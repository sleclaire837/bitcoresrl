import { Transform } from 'stream';
import logger from '../logger';
import { ITransaction } from '../models/baseTransaction';
import { CoinModel, CoinStorage } from '../models/coin';
import { TransactionModel, TransactionStorage } from '../models/transaction';
import { SpentHeightIndicators } from '../types/Coin';
import parseArgv from '../utils/parseArgv';
import '../utils/polyfills';
import { Config } from './config';

const { PRUNING_CHAIN, PRUNING_NETWORK, PRUNING_MEMPOOL_AGE, PRUNING_INTERVAL_HRS } = process.env;
const args = parseArgv([], [
  { arg: 'CHAIN', type: 'string' },
  { arg: 'NETWORK', type: 'string' },
  { arg: 'OLD', type: 'bool' },
  { arg: 'INVALID', type: 'bool' },
  { arg: 'EXIT', type: 'bool' },
  { arg: 'DRY', type: 'bool' },
  { arg: 'MEMPOOL_AGE', type: 'int' },
  { arg: 'INTERVAL_HRS', type: 'float' }
]);

const ONE_MIN = 1000 * 60;
const ONE_HOUR = 60 * ONE_MIN;
const ONE_DAY = 24 * ONE_HOUR;

const CHAIN = args.CHAIN || PRUNING_CHAIN;
const NETWORK = args.NETWORK || PRUNING_NETWORK;
const INTERVAL_HRS = args.INTERVAL_HRS || Number(PRUNING_INTERVAL_HRS) || 12;
const MEMPOOL_AGE = args.MEMPOOL_AGE || Number(PRUNING_MEMPOOL_AGE) || 7;

// If --DRY was given w/o a follow arg (i.e. 'true', '0', etc) assume the user wants to run a dry run (safe)
if (Object.keys(args).includes('DRY') && args.DRY === undefined) {
  args.DRY = '1';
}

if (INTERVAL_HRS > 72) {
  throw new Error('INTERVAL_HRS cannot be over 72. Consider using a cron job.');
}

export class PruningService {
  transactionModel: TransactionModel;
  coinModel: CoinModel;
  stopping = false;
  running = false;
  interval;

  constructor({ transactionModel = TransactionStorage, coinModel = CoinStorage } = {}) {
    this.transactionModel = transactionModel;
    this.coinModel = coinModel;
  }

  async start() {
    logger.info('Starting Pruning Service');
    args.OLD && logger.info(`Pruning mempool txs older than ${MEMPOOL_AGE} day(s)`);
    args.INVALID && logger.info('Pruning conflicting mempool txs');
    args.DRY && logger.info('Pruning service DRY RUN');
    
    if (args.EXIT) {
      this.detectAndClear().then(() => {
        process.emit('SIGINT', 'SIGINT');
      });
    } else {
      logger.info('Pruning service interval (hours): ' + INTERVAL_HRS);
      this.interval = setInterval(this.detectAndClear.bind(this), INTERVAL_HRS * ONE_HOUR);
    }
  }

  async stop() {
    logger.info('Stopping Pruning Service');
    this.stopping = true;
    clearInterval(this.interval);
  }

  async detectAndClear() {
    if (this.running) { return; }
    this.running = true;

    try {
      if (CHAIN && NETWORK) {
        args.OLD && await this.processOldMempoolTxs(CHAIN, NETWORK, MEMPOOL_AGE);
        args.INVALID && await this.processAllInvalidTxs(CHAIN, NETWORK);
      } else {
        for (let chainNetwork of Config.chainNetworks()) {
          const { chain, network } = chainNetwork;
          if (!chain || !network) {
            throw new Error('Config structure should contain both a chain and network');
          }
          args.OLD && await this.processOldMempoolTxs(chain, network, MEMPOOL_AGE);
          args.INVALID && await this.processAllInvalidTxs(chain, network);
        }
      }
    } catch (err: any) {
      logger.error('Pruning Error: ' + err.stack || err.message || err);
    } finally {
      this.running = false;
    }
  }

  async processOldMempoolTxs(chain: string, network: string, days: number) {
    const oldTime = new Date(Date.now() - days * ONE_DAY);
    const count = await this.transactionModel.collection.countDocuments({
      chain,
      network,
      blockHeight: -1,
      blockTimeNormalized: { $lt: oldTime }
    });
    logger.info(`Found ${count} outdated ${chain} ${network} mempool txs`);
    await new Promise((resolve, reject) => {
      this.transactionModel.collection
        .find({ chain, network, blockHeight: -1, blockTimeNormalized: { $lt: oldTime } })
        .pipe(
          new Transform({
            objectMode: true,
            transform: async (data: any, _, cb) => {
              if (this.stopping) {
                return cb(new Error('Stopping'));
              }
              const tx = data as ITransaction;
              logger.info(`Finding ${tx.txid} outputs and dependent outputs`);
              const outputGenerator = this.transactionModel.yieldRelatedOutputs(tx.txid);
              let spentTxids = new Set<string>();
              let count = 0;
              for await (const coin of outputGenerator) {
                if (coin.mintHeight >= 0 || coin.spentHeight >= 0) {
                  return cb(new Error(`Invalid coin! ${coin.mintTxid} `));
                }
                count++;
                if (count > 50) {
                  throw new Error(`${tx.txid} has too many decendents`);
                }
                if (coin.spentTxid) {
                  spentTxids.add(coin.spentTxid);
                }
              }
              spentTxids.add(tx.txid);
              const uniqueTxids = Array.from(spentTxids);
              await this.removeOldMempool(chain, network, uniqueTxids);
              logger.info(`Removed ${tx.txid} transaction and ${count} dependent txs`);
              cb();
            }
          })
        )
        .on('finish', resolve)
        .on('error', reject);
    });
    logger.info(`Removed all old mempool txs within the last ${days} days`);
  }

  async processAllInvalidTxs(chain, network) {
    const count = await this.transactionModel.collection.countDocuments({
      chain,
      network,
      blockHeight: -3
    });
    logger.info(`Found ${count} invalid ${chain} ${network} txs`);
    await new Promise((resolve, reject) => {
      this.transactionModel.collection
        .find({ chain, network, blockHeight: -3 })
        .pipe(
          new Transform({
            objectMode: true,
            transform: async (data: any, _, cb) => {
              if (this.stopping) {
                return cb(new Error('Stopping'));
              }
              const tx = data as ITransaction;
              logger.info(`Invalidating ${tx.txid} outputs and dependent outputs`);
              const outputGenerator = this.transactionModel.yieldRelatedOutputs(tx.txid);
              let spentTxids = new Set<string>();
              let count = 0;
              for await (const coin of outputGenerator) {
                if (coin.mintHeight >= 0 || coin.spentHeight >= 0) {
                  return cb(new Error(`Invalid coin! ${coin.mintTxid} `));
                }
                count++;
                if (count > 50) {
                  throw new Error(`${tx.txid} has too many decendents`);
                }
                if (coin.spentTxid) {
                  spentTxids.add(coin.spentTxid);
                }
              }
              spentTxids.add(tx.txid);
              const uniqueTxids = Array.from(spentTxids);
              await this.clearInvalid(uniqueTxids);
              logger.info(`Invalidated ${tx.txid} and ${count} dependent txs`);
              cb();
            }
          })
        )
        .on('finish', resolve)
        .on('error', reject);
    });
  }

  async clearInvalid(invalidTxids: Array<string>) {
    logger.info(`${args.DRY ? 'DRY RUN - ' : ''}Invalidating ${invalidTxids.length} txids`);
    if (args.DRY) {
      return;
    }
    return Promise.all([
      // Set all invalid txs to conflicting status
      this.transactionModel.collection.updateMany(
        { txid: { $in: invalidTxids } },
        { $set: { blockHeight: SpentHeightIndicators.conflicting } }
      ),
      // Set all coins that were pending to be spent by an invalid tx back to unspent
      this.coinModel.collection.updateMany(
        { spentTxid: { $in: invalidTxids } },
        { $set: { spentHeight: SpentHeightIndicators.unspent } }
      ),
      // Set all coins that were created by invalid txs to conflicting status
      this.coinModel.collection.updateMany(
        { mintTxid: { $in: invalidTxids } },
        { $set: { mintHeight: SpentHeightIndicators.conflicting } }
      )
    ]);
  }

  async removeOldMempool(chain, network, txids: Array<string>) {
    logger.info(`${args.DRY ? 'DRY RUN - ' : ''}Removing ${txids.length} txids`);
    if (args.DRY) {
      return;
    }
    return Promise.all([
      this.transactionModel.collection.deleteMany({ chain, network, txid: { $in: txids }, blockHeight: -1 }),
      this.coinModel.collection.deleteMany({ chain, network, mintTxid: { $in: txids }, mintHeight: -1 })
    ]);
  }
}
export const Pruning = new PruningService();
