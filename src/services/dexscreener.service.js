const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

function client() {
  return createClient({
    baseURL: process.env.DEXSCREENER_URL || "https://api.dexscreener.com",
    name: "dexscreener",
  });
}

async function getTokenPairs(mint) {
  const data = await client().get(`/token-pairs/v1/solana/${mint}`);
  return Array.isArray(data) ? data : data?.pairs || [];
}

async function bestPairLiquidity(mint, poolAddress) {
  try {
    const pairs = await getTokenPairs(mint);
    const match = pairs.find((p) => p.pairAddress === poolAddress) || pairs[0];
    return {
      liquidityUsd: num(match?.liquidity?.usd),
      url: match?.url,
      pairAddress: match?.pairAddress,
    };
  } catch (err) {
    logger.warn("dexscreener skip", { mint, err: err.message });
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getTokenPairs, bestPairLiquidity };
