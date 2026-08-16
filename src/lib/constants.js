const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
]);

const VOLUME_WINDOWS = ["5m", "1h", "6h", "24h"];

const MENU = {
  Liquidity: {
    minVolume24hUsd: { label: "Min volume 24h (USD)", type: "number" },
    minVolume5mUsd: { label: "Min volume 5m (USD, 0=off)", type: "number" },
    minVolume1hUsd: { label: "Min volume 1h (USD, 0=off)", type: "number" },
    minVolume6hUsd: { label: "Min volume 6h (USD, 0=off)", type: "number" },
    minTvlUsd: { label: "Min TVL (USD)", type: "number" },
    minActiveTvlUsd: { label: "Min active TVL (USD, 0=off)", type: "number" },
    minTotalLps: { label: "Min total LPs", type: "number" },
    minFeeTvlRatio24h: { label: "Min fee/TVL 24h (0=off)", type: "number" },
    maxFeeTvlRatio24h: { label: "Max fee/TVL 24h (0=off)", type: "number" },
  },
  Holder: {
    maxDevBalancePct: { label: "Max creator % (0 = sold all)", type: "number" },
    maxTop10HolderPct: { label: "Max top-10 holder %", type: "number" },
    minHolders: { label: "Min holders (0=off)", type: "number" },
  },
  Risk: {
    maxRugcheckScore: { label: "Max RugCheck score", type: "number" },
    requireMintRevoked: { label: "Require mint revoked", type: "bool" },
    requireFreezeRevoked: { label: "Require freeze revoked", type: "bool" },
    rejectMeteoraBlacklisted: { label: "Reject Meteora blacklist", type: "bool" },
    maxVolatility: { label: "Max volatility (0=off)", type: "number" },
    minVolatility: { label: "Min volatility (0=off)", type: "number" },
  },
  Age: {
    minTokenAgeMinutes: { label: "Min token age (min, 0=off)", type: "number" },
    maxTokenAgeMinutes: { label: "Max token age (min, 0=off)", type: "number" },
    minPoolAgeMinutes: { label: "Min pool age (min, 0=off)", type: "number" },
    maxPoolAgeMinutes: { label: "Max pool age (min, 0=off)", type: "number" },
  },
  Discovery: {
    discoveryCategory: { label: "Category (trending/top/new/all)", type: "enum", options: ["trending", "top", "new", "all"] },
    discoveryTimeframe: { label: "Discovery TF", type: "enum", options: ["5m", "1h", "4h", "12h", "24h"] },
    skipQuoteQuotePairs: { label: "Skip SOL/USDC/USDT pairs", type: "bool" },
  },
};

module.exports = { QUOTE_MINTS, VOLUME_WINDOWS, MENU };
