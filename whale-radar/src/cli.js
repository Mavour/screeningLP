import bcrypt from 'bcryptjs';
import pino from 'pino';
import { config, requireLive } from './config.js';
import { getMeta, openDb, leaderboard, scheduleWallet, watchlist } from './db.js';
import { createProviders } from './clients/providers.js';
import { mockProviders } from './clients/mock.js';
import { distribution } from './strategy/distribution.js';
import { isAddress, isSignature } from './strategy/instructions.js';
import { positionTools } from './strategy/positions.js';
import { discover } from './discovery/leaderboard.js';
import { reclassify, refreshWallet } from './jobs/wallets.js';
import { startJobs } from './jobs/scheduler.js';
import { createWeb, createWebhook } from './web/server.js';
import { enqueue, flushBatches, processInbox } from './realtime/worker.js';
import { telegramMessages } from './notify/telegram.js';

const logger = pino({ level: process.env.RADAR_LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'authorization', 'apiKey', 'password', 'token'] });

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const known = ['leaderboard', 'backfill', 'reclassify', 'web', 'bot'];
  if (!known.includes(command)) throw new Error('Unknown command');
  const settings = config();
  const replayFlag = args.indexOf('--replay');
  const replay = replayFlag >= 0 ? args[replayFlag + 1] : null;
  if (replayFlag >= 0 && (command !== 'bot' || !isSignature(replay))) throw new Error('Provide a valid --replay <signature>');
  if (command !== 'web' && command !== 'reclassify') requireLive(settings, command === 'bot' && !replay);
  const dryRun = settings.mock || Boolean(replay) || args.includes('--dry-run');
  if (command === 'bot' && !dryRun && (!settings.telegramToken || !/^-?\d+$/.test(settings.chatId))) {
    throw new Error('Live Telegram requires TELEGRAM_BOT_TOKEN and a numeric RADAR_CHAT_ID or ALLOWED_CHAT_ID');
  }
  if (settings.mock && !settings.webPassword) settings.webPassword = await bcrypt.hash('whale-radar-mock', 8);

  const controller = new AbortController();
  const db = openDb(settings.database);
  if (['bot', 'leaderboard'].includes(command) &&
      (getMeta(db, 'public_snapshot_at') || getMeta(db, 'public_worker_started_at'))) {
    db.close();
    throw new Error('Smart LP requires a separate RADAR_DB from the public Radar worker');
  }
  const providers = settings.mock ? mockProviders() : createProviders(settings, logger, controller.signal);
  const ctx = { db, settings, providers, tools: positionTools(providers, settings), logger, dryRun,
    print: output => console.log(output) };

  if (command === 'web' || (command === 'bot' && !replay)) {
    const servers = [];
    let stopJobs;
    let stopping;
    const close = () => {
      if (!stopping) {
        controller.abort();
        stopping = Promise.allSettled([...servers.map(app => app.close()), stopJobs?.()]).then(() => db.close());
      }
      return stopping;
    };
    try {
      if (command === 'web' || settings.web) {
        const browserProviders = !settings.mock && !settings.rpcUrl && !settings.heliusKey
          ? createProviders({ ...settings, rpcUrl: process.env.RADAR_PUBLIC_POSITION_RPC_URL || 'https://solana-rpc.publicnode.com' },
            logger, controller.signal) : providers;
        const archive = settings.mock ? undefined : createProviders({
          ...settings, rpcUrl: 'https://api.mainnet-beta.solana.com',
        }, logger, controller.signal);
        const app = createWeb({ ...ctx, tools: positionTools(browserProviders, settings, archive) });
        servers.push(app);
        await app.listen({ port: settings.webPort, host: '127.0.0.1' });
        logger.info({ port: settings.webPort }, 'Private radar dashboard listening');
      }
      if (command === 'bot') {
        if (settings.webhookSecret) {
          const app = createWebhook(ctx);
          servers.push(app);
          await app.listen({ port: settings.webhookPort, host: '127.0.0.1' });
          logger.info({ port: settings.webhookPort }, 'Radar webhook listening');
        }
        stopJobs = startJobs(ctx);
      }
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    } catch (error) {
      await close();
      throw error;
    }
    return;
  }

  try {
    if (command === 'leaderboard') {
      try { await discover(ctx); }
      catch (error) {
        if (!leaderboard(db).length) throw error;
        logger.warn({ reason: error.message }, 'Showing previous leaderboard');
        process.exitCode = 1;
      }
      console.table(leaderboard(db).map(row => ({ Rank: row.current_rank, Wallet: row.address.slice(0, 6) + '…' + row.address.slice(-5),
        'PnL SOL': row.realized_pnl_sol.toFixed(2), ROI: (row.roi * 100).toFixed(1) + '%', 'Win rate': (row.win_rate * 100).toFixed(1) + '%',
        Closed: row.n_closed, Validation: row.validation })));
    }
    if (command === 'backfill') {
      if (!isAddress(args[0])) throw new Error('Provide a valid Solana wallet address');
      await refreshWallet(ctx, args[0], { full: true });
      scheduleWallet(db, args[0], Date.now() + 30 * 60000);
    }
    if (command === 'reclassify') {
      const count = reclassify(db, bins => distribution(bins, settings.strategy));
      logger.info({ count }, 'Bin strategies reclassified');
    }
    if (replay) {
      if (settings.mock && !watchlist(db).length) await discover(ctx);
      // Live replay is read-only with respect to the production inbox and alert history.
      const replayDb = settings.mock ? db : openDb(':memory:');
      try {
        if (replayDb !== db) {
          const get = db.prepare('SELECT current_rank,is_favorite FROM wallets WHERE address=?');
          const insert = replayDb.prepare('INSERT INTO wallets(address,first_seen_at,last_seen_at,current_rank,is_favorite) VALUES (?,?,?,?,?)');
          const now = Date.now();
          for (const address of watchlist(db)) {
            const row = get.get(address);
            insert.run(address, now, now, row.current_rank, row.is_favorite);
          }
        }
        const replayCtx = { ...ctx, db: replayDb, settings: { ...settings, batchMs: 0 } };
        const existing = replayDb.prepare('SELECT * FROM alerts WHERE signature=? AND sent_at IS NOT NULL ORDER BY id').all(replay);
        if (existing.length) {
          for (const { message } of telegramMessages(existing, settings.publicUrl)) ctx.print(message.text);
        } else {
          enqueue(replayDb, [replay]);
          await processInbox(replayCtx, { signature: replay });
          // Only deliver this replay's batches, without touching unrelated queued dry-run events.
          await flushBatches(replayCtx, Date.now(), true, replay);
          const result = replayDb.prepare('SELECT done_at,last_error FROM event_inbox WHERE signature=?').get(replay);
          if (!result?.done_at) {
            logger.warn('Replay could not load the transaction');
            process.exitCode = 1;
          } else if (!replayDb.prepare('SELECT 1 FROM alerts WHERE signature=?').get(replay)) {
            logger.info('No qualifying DLMM deposits in the replayed transaction');
          }
        }
      } finally {
        if (replayDb !== db) replayDb.close();
      }
    }
  } finally {
    controller.abort();
    db.close();
  }
}

main().catch(error => {
  logger.error({ reason: error.message }, 'Whale Radar stopped');
  process.exitCode = 1;
});
