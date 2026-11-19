import pino from 'pino';
import { config, finite } from './config.js';
import { getMeta, openDb, setMeta } from './db.js';
import { discoverPublicSmartLp, publicHistoryProviders } from './discovery/public-leaderboard.js';
import { summarize, verification } from './discovery/leaderboard.js';
import { evaluateCohort } from './discovery/smart-lp.js';
import { assertPublicDatabase, publicDatabasePath, publicStreamProviders, refreshPublicMarket, refreshPublicSnapshot } from './public-snapshot.js';
import { pollPublicPools, processPublicInbox, publicLiquidityLogs, publicWatchPools, refreshPublicWallets } from './realtime/public-worker.js';
import { watchActivity } from './realtime/watch.js';
import { publicTelegramDelivery } from './notify/public-telegram.js';
import { createProviders } from './clients/providers.js';
import { positionTools } from './strategy/positions.js';
import { createWeb } from './web/server.js';

async function start() {
  if (process.env.MOCK === '1') throw new Error('Public Radar requires real public data');
  const minutes = finite(process.env.RADAR_PUBLIC_SNAPSHOT_MINUTES ?? 15);
  if (!(minutes >= 2)) throw new Error('RADAR_PUBLIC_SNAPSHOT_MINUTES must be at least 2');
  const db = openDb(publicDatabasePath());
  try { assertPublicDatabase(db); }
  catch (error) { db.close(); throw error; }
  const logger = pino({ level: process.env.RADAR_LOG_LEVEL || 'info' });
  const controller = new AbortController();
  const settings = config();
  const ctx = { db, logger, signal: controller.signal, providers: publicStreamProviders(controller.signal),
    settings: { mock: false, webhookUrl: '', concurrency: 2 } };
  const smartContext = { db, logger, settings, publicMeteora: true, signal: controller.signal,
    providers: publicHistoryProviders(settings, logger, controller.signal, ctx.providers) };
  let web;
  if (process.argv.includes('--web') && settings.web) {
    try {
      const providers = createProviders({ ...settings, rpcUrl: settings.rpcUrl ||
        (settings.heliusKey ? '' : process.env.RADAR_PUBLIC_RPC_URL || 'https://solana-rpc.publicnode.com') }, logger, controller.signal);
      const archive = createProviders({ ...settings, rpcUrl: 'https://api.mainnet-beta.solana.com' }, logger, controller.signal);
      web = createWeb({ db, settings, tools: positionTools(providers, settings, archive) });
      await web.listen({ host: '127.0.0.1', port: settings.webPort });
      logger.info({ port: settings.webPort }, 'Public Radar dashboard listening');
    } catch (error) {
      await web?.close();
      db.close();
      throw error;
    }
  }
  let stream = 'idle';
  let stopping = false;
  let rotation = 0;
  const heartbeat = () => setMeta(db, 'public_worker_heartbeat', Date.now());
  const watcher = watchActivity(ctx, {
    addresses: () => publicWatchPools(db), accepts: publicLiquidityLogs,
    cursorPrefix: 'public-ws', pageSize: 8, pageLimit: 2, bounded: true,
    state(value, size) {
      if (value !== stream && value === 'connected') logger.info({ pools: size }, 'Public Solana WebSocket connected');
      stream = value;
      setMeta(db, 'public_stream_state', stream);
      setMeta(db, 'public_stream_pools', size);
      heartbeat();
    },
  });

  const jobs = [];
  function schedule(name, delay, action, initial = 0) {
    const entry = {};
    jobs.push(entry);
    const run = () => {
      entry.running = Promise.resolve().then(action).catch(error => {
        if (!stopping) logger.warn({ job: name, reason: error.message }, 'Public Radar task failed');
      }).finally(() => {
        if (!stopping) entry.timer = setTimeout(run, delay);
      });
    };
    entry.timer = setTimeout(run, initial);
  }

  setMeta(db, 'public_worker_started_at', Date.now());
  setMeta(db, 'public_discovery_interval_ms', minutes * 60000);
  setMeta(db, 'public_stream_state', 'starting');
  setMeta(db, 'public_stream_pools', 0);
  heartbeat();
  schedule('stream subscriptions', 12000, async () => {
    heartbeat();
    await watcher.sync();
  });
  schedule('confirmed transactions', 250, () => processPublicInbox(ctx));
  schedule('tracked wallet refresh', 120000, () => refreshPublicWallets(ctx), 3000);
  schedule('Meteora market refresh', 120000, async () => {
    try { await refreshPublicMarket(ctx); }
    catch (error) {
      if (!stopping) setMeta(db, 'public_market_state', 'failed');
      throw error;
    }
  }, 1000);
  const telegram = publicTelegramDelivery(db, logger, process.env, controller.signal);
  if (telegram) schedule('public Telegram delivery', 5000, telegram);
  schedule('fallback polling', 20000, async () => {
    if (stream === 'connected') return;
    const pools = publicWatchPools(db);
    if (!pools.length) return;
    const sampled = Array.from({ length: Math.min(4, pools.length) }, (_, i) => pools[(rotation + i) % pools.length]);
    rotation = (rotation + sampled.length) % pools.length;
    if (await pollPublicPools(ctx, sampled)) setMeta(db, 'public_last_poll_at', Date.now());
  }, 7000);
  schedule('automatic wallet discovery', minutes * 60000, async () => {
    setMeta(db, 'public_scan_started_at', Date.now());
    setMeta(db, 'public_scan_state', 'running');
    try {
      const result = await refreshPublicSnapshot(db, { signal: controller.signal });
      logger.info(result, 'Public wallet discovery completed');
      setMeta(db, 'public_scan_state', 'complete');
      setMeta(db, 'public_scan_completed_at', Date.now());
      if (!stopping) await watcher.sync();
    } catch (error) {
      if (!stopping) setMeta(db, 'public_scan_state', 'failed');
      throw error;
    }
  });
  let lastSmartScan = 0;
  schedule('Smart LP discovery', 60000, async () => {
    if (!getMeta(db, 'public_sample_owners') || Date.now() - lastSmartScan < settings.discoveryMs) return;
    const result = await discoverPublicSmartLp(smartContext);
    if (result) lastSmartScan = result.finishedAt;
  }, 5000);
  schedule('Smart LP follow-up', settings.discoveryMs, () => evaluateCohort(smartContext, summarize, verification), 10000);
  logger.info({ discoveryMinutes: minutes }, 'Public Radar worker started');

  const close = async () => {
    if (stopping) return;
    stopping = true;
    for (const job of jobs) clearTimeout(job.timer);
    controller.abort();
    setMeta(db, 'public_stream_state', 'stopped');
    setMeta(db, 'public_worker_heartbeat', 0);
    setTimeout(() => process.exit(0), 8000).unref();
    await Promise.allSettled([web?.close(), watcher.close(), ...jobs.map(job => job.running)]);
    db.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

start().catch(error => { console.error(error.message); process.exitCode = 1; });
