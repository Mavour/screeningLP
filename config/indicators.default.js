module.exports = {
  // Hard trigger: 24h pool volume
  minVolume24hUsd: 1_000_000,

  // Creator must have sold all (0%)
  maxDevBalancePct: 0.01,

  // Security
  requireMintRevoked: true,
  requireFreezeRevoked: true,
  rejectMeteoraBlacklisted: true,
  maxRugcheckScore: 40,

  // Liquidity / pool
  minTvlUsd: 5000,
  minActiveTvlUsd: 0,
  minTotalLps: 1,
  minFeeTvlRatio24h: 0,
  maxFeeTvlRatio24h: 0,
  poolTypes: ["dlmm"],
  skipQuoteQuotePairs: true,

  // Holders
  maxTop10HolderPct: 80,
  minHolders: 0,

  // Age (minutes). 0 = disabled
  minTokenAgeMinutes: 0,
  maxTokenAgeMinutes: 0,
  minPoolAgeMinutes: 0,
  maxPoolAgeMinutes: 0,

  // Volatility from Meteora discovery (0 = disabled)
  maxVolatility: 0,
  minVolatility: 0,

  // Optional extra volume windows (display-only unless > 0)
  minVolume5mUsd: 0,
  minVolume1hUsd: 0,
  minVolume6hUsd: 0,

  // Discovery query
  discoveryCategory: "trending",
  discoveryTimeframe: "24h",
  discoverySortBy: "volume:desc",
};
