const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

function headers() {
  const key = process.env.DEXPAPRIKA_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function client() {
  return createClient({
    baseURL: process.env.DEXPAPRIKA_URL || "https://api.dexpaprika.com",
    name: "dexpaprika",
    headers: headers(),
  });
}

async function getPool(poolAddress) {
  return client().get(`/networks/solana/pools/${poolAddress}`);
}

async function getToken(mint) {
  return client().get(`/networks/solana/tokens/${mint}`);
}

async function getOhlcv(poolAddress, { start, interval = "1h", limit = 24 } = {}) {
  const startIso = start || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return client().get(`/networks/solana/pools/${poolAddress}/ohlcv`, {
    start: startIso,
    interval,
    limit,
  });
}

function extractVolumes(poolOrToken) {
  const src = poolOrToken?.summary || poolOrToken || {};
  return {
    "5m": num(src["5m"]?.volume_usd),
    "1h": num(src["1h"]?.volume_usd),
    "6h": num(src["6h"]?.volume_usd),
    "24h": num(src["24h"]?.volume_usd),
  };
}

function extractCreatedAt(poolOrToken) {
  return poolOrToken?.created_at || poolOrToken?.added_at || null;
}

async function enrichPool(poolAddress, mint) {
  try {
    const pool = await getPool(poolAddress);
    return {
      source: "pool",
      volumes: extractVolumes(pool),
      liquidityUsd: num(pool.liquidity_usd),
      createdAt: extractCreatedAt(pool),
      tokenCreatedAt: pool.tokens?.find((t) => t.id === mint)?.added_at || null,
      lastPriceUsd: num(pool.last_price_usd),
      raw: pool,
    };
  } catch (err) {
    logger.warn("dexpaprika pool miss, falling back to token", { poolAddress, err: err.message });
    if (!mint) throw err;
    const token = await getToken(mint);
    return {
      source: "token",
      volumes: extractVolumes(token),
      liquidityUsd: num(token.summary?.liquidity_usd),
      createdAt: extractCreatedAt(token),
      tokenCreatedAt: extractCreatedAt(token),
      lastPriceUsd: num(token.summary?.price_usd),
      raw: token,
    };
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getPool, getToken, getOhlcv, enrichPool, extractVolumes };
