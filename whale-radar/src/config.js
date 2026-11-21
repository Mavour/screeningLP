import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: [fileURLToPath(new URL('../.env', import.meta.url)),
  fileURLToPath(new URL('../../.env', import.meta.url))] });

export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DAY = 86_400_000;
export const WHALE_DEPOSIT_USD = 2000;
export const PUBLIC_OPENING_MIN_USD = 2000;
export const finite = value => {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function config(env = process.env) {
  const mock = env.MOCK === '1';
  const number = (name, fallback, min = 0, max = Infinity) => {
    const value = finite(env[name] ?? fallback);
    if (value === null || value < min || value > max) throw new Error('Invalid ' + name);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = number(name, fallback, min, max);
    if (!Number.isSafeInteger(value)) throw new Error('Invalid ' + name);
    return value;
  };
  return {
    mock, live: env.RADAR_LIVE === '1', web: env.RADAR_WEB_ENABLED !== '0',
    dormApiKey: env.RADAR_DORM_API_KEY?.trim() || '',
    database: env.RADAR_DB || fileURLToPath(new URL(mock ? '../data/mock.sqlite' : '../data/radar.sqlite', import.meta.url)),
    webhookPort: integer('RADAR_WEBHOOK_PORT', 9012, 1, 65535),
    webPort: integer('RADAR_WEB_PORT', 9011, 1, 65535),
    webUser: env.WEB_USER || (mock ? 'mock' : ''),
    webPassword: env.WEB_PASSWORD || '',
    publicUrl: env.RADAR_PUBLIC_URL || '',
    webhookUrl: env.HELIUS_WEBHOOK_URL || '',
    webhookSecret: env.HELIUS_WEBHOOK_AUTH || (mock ? 'mock-webhook' : ''),
    webhookId: env.HELIUS_WEBHOOK_ID || '',
    heliusKey: env.HELIUS_API_KEY || '', rpcUrl: env.RADAR_RPC_URL || '',
    wsUrl: env.RADAR_WS_URL || '', lpKey: env.LP_AGENT_API_KEY || '',
    jupiterKey: env.JUPITER_API_KEY || '', telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.RADAR_CHAT_ID || env.ALLOWED_CHAT_ID || '',
    windowDays: integer('RADAR_WINDOW_DAYS', 30, 1), minClosed: integer('RADAR_MIN_CLOSED', 20, 1),
    minAvgSol: number('RADAR_MIN_AVG_SOL', 5), concentration: number('RADAR_MAX_PROFIT_SHARE', 0.6, 0, 1),
    botHoldMinutes: number('RADAR_BOT_HOLD_MIN', 5), botDaily: number('RADAR_BOT_POSITIONS_DAY', 40),
    top: integer('RADAR_TOP', 100, 1, 1000), crossCheck: integer('RADAR_CROSS_CHECK', 30, 1, 100),
    pnlTolerance: number('RADAR_PNL_TOLERANCE', 0.25, 0, 1),
    minVolume: number('RADAR_MIN_POOL_VOLUME', 50000), minTvl: number('RADAR_MIN_POOL_TVL', 10000),
    minFees: number('RADAR_MIN_POOL_FEES', 1), minOrganic: number('RADAR_MIN_ORGANIC_SCORE', 0, 0, 100),
    minFdv: number('RADAR_TREND_MIN_FDV', 0), trendMinDays: number('RADAR_TREND_MIN_DAYS', 0),
    trendMaxDays: number('RADAR_TREND_MAX_DAYS', 3650), poolPages: integer('RADAR_POOL_PAGES', 2, 1),
    poolsPerRun: integer('RADAR_POOLS_PER_RUN', 20, 1), lpPages: integer('RADAR_LP_PAGES', 1, 1),
    historyPages: integer('RADAR_HISTORY_PAGES', 100, 1), candidates: integer('RADAR_CANDIDATES', 250, 1),
    lpRpm: number('LP_AGENT_RPM', 10, 1), concurrency: integer('RADAR_CONCURRENCY', 4, 1, 20),
    alertSol: number('RADAR_ALERT_SOL', 10), batchMs: integer('RADAR_BATCH_SECONDS', 90, 0) * 1000,
    discoveryMs: integer('RADAR_DISCOVERY_MINUTES', 360, 1) * 60000,
    trendMs: integer('RADAR_TREND_MINUTES', 15, 1) * 60000,
    trendWeights: { fee: number('RADAR_TREND_FEE_WEIGHT', 45), momentum: number('RADAR_TREND_MOMENTUM_WEIGHT', 20),
      liquidity: number('RADAR_TREND_LIQUIDITY_WEIGHT', 10), age: number('RADAR_TREND_AGE_WEIGHT', 5),
      whales: number('RADAR_TREND_WHALE_WEIGHT', 20), risk: number('RADAR_TREND_RISK_WEIGHT', 10) },
    strategy: {
      uniform: number('RADAR_STRATEGY_UNIFORM_CV', 0.2, 0, 1),
      concentration: number('RADAR_STRATEGY_CONCENTRATION', 1.4, 1),
    },
  };
}

export function requireLive(settings, worker = false) {
  if (settings.mock) return;
  if (!settings.live) throw new Error('Set RADAR_LIVE=1 or MOCK=1');
  if (!settings.lpKey) throw new Error('Live Smart LP requires LP_AGENT_API_KEY for top-lpers (npm run check:live)');
  if (!settings.rpcUrl && !settings.heliusKey) throw new Error('Live Smart LP requires RADAR_RPC_URL or HELIUS_API_KEY');
  if (worker && settings.webhookUrl && (!settings.webhookSecret || !settings.heliusKey || !settings.webhookId)) {
    throw new Error('Webhook mode requires HELIUS_WEBHOOK_AUTH, HELIUS_API_KEY and HELIUS_WEBHOOK_ID');
  }
  for (const url of [settings.webhookUrl, settings.publicUrl].filter(Boolean)) {
    if (new URL(url).protocol !== 'https:') throw new Error('Public endpoints require HTTPS');
  }
}
