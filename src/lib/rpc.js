const { Connection } = require("@solana/web3.js");
const logger = require("./logger");

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

function heliusUrl() {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL.trim();
  const key = (process.env.HELIUS_API_KEY || "").trim();
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

function endpointList() {
  const primary = (process.env.SOLANA_RPC_URL || PUBLIC_RPC).trim();
  const helius = heliusUrl();
  const fallback = (process.env.SOLANA_RPC_FALLBACK_URL || "").trim() || helius;
  const urls = [primary];
  if (fallback && fallback !== primary) urls.push(fallback);
  return urls;
}

const connections = new Map();
let preferredIndex = 0;

function connectionFor(url) {
  if (!connections.has(url)) {
    connections.set(
      url,
      new Connection(url, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 20000,
      })
    );
  }
  return connections.get(url);
}

function isRetryable(err) {
  const msg = String(err?.message || err || "");
  const status = err?.status || err?.code;
  return (
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /429|rate.?limit|too many|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|503|502|504|timeout/i.test(msg)
  );
}

function label(url) {
  if (!url) return "rpc";
  if (url.includes("helius")) return "helius";
  if (url.includes("mainnet-beta.solana.com")) return "public";
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

async function withRpc(fn) {
  const urls = endpointList();
  const order = urls.slice(preferredIndex).concat(urls.slice(0, preferredIndex));
  let lastErr;

  for (let i = 0; i < order.length; i++) {
    const url = order[i];
    try {
      const result = await fn(connectionFor(url));
      const idx = urls.indexOf(url);
      if (idx !== preferredIndex) {
        logger.info(`rpc switched to ${label(url)}`);
        preferredIndex = idx;
      }
      return result;
    } catch (err) {
      lastErr = err;
      const more = i < order.length - 1;
      logger.warn(`rpc ${label(url)} failed`, { err: err.message, fallback: more });
      if (!more || !isRetryable(err)) break;
    }
  }
  throw lastErr;
}

function getConnection() {
  const urls = endpointList();
  return connectionFor(urls[preferredIndex] || urls[0] || PUBLIC_RPC);
}

module.exports = { withRpc, getConnection, endpointList, heliusUrl, label };
