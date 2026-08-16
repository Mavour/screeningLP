const { computeRiskScore } = require("./riskScorer");
const { QUOTE_MINTS } = require("../lib/constants");

function reject(reason) {
  return { pass: false, reason };
}

function evaluate(token, config) {
  if (config.skipQuoteQuotePairs !== false) {
    const x = token.tokenX?.address;
    const y = token.tokenY?.address;
    if (x && y && QUOTE_MINTS.has(x) && QUOTE_MINTS.has(y)) {
      return reject("Quote-quote pair (SOL/USDC/USDT)");
    }
  }
  if (config.rejectMeteoraBlacklisted && token.isBlacklisted) {
    return reject("Meteora blacklisted");
  }
  if (config.poolTypes?.length && !config.poolTypes.includes(token.poolType)) {
    return reject(`pool type ${token.poolType} not allowed`);
  }
  if (config.requireMintRevoked && token.hasMintAuthority) {
    return reject("Mint authority still active");
  }
  if (config.requireFreezeRevoked && token.hasFreezeAuthority) {
    return reject("Freeze authority still active");
  }
  if (token.devBalancePct != null && token.devBalancePct > config.maxDevBalancePct) {
    return reject(`Creator still holds ${token.devBalancePct.toFixed(4)}%`);
  }
  if (token.volume24h < config.minVolume24hUsd) {
    return reject(`24h volume ${token.volume24h} < ${config.minVolume24hUsd}`);
  }
  if (token.tvl < config.minTvlUsd) {
    return reject(`TVL ${token.tvl} < ${config.minTvlUsd}`);
  }
  if (config.minActiveTvlUsd > 0 && (token.activeTvl || 0) < config.minActiveTvlUsd) {
    return reject(`Active TVL ${token.activeTvl} < ${config.minActiveTvlUsd}`);
  }
  if ((token.totalLps || 0) < config.minTotalLps) {
    return reject(`Total LPs ${token.totalLps} < ${config.minTotalLps}`);
  }
  if (config.maxTop10HolderPct > 0 && token.top10HolderPct > config.maxTop10HolderPct) {
    return reject(`Top 10 holders ${token.top10HolderPct.toFixed(1)}%`);
  }
  if (config.minHolders > 0 && (token.holders || 0) < config.minHolders) {
    return reject(`Holders ${token.holders} < ${config.minHolders}`);
  }
  if (config.minTokenAgeMinutes > 0 && (token.tokenAgeMinutes || 0) < config.minTokenAgeMinutes) {
    return reject("Token too new");
  }
  if (config.maxTokenAgeMinutes > 0 && token.tokenAgeMinutes > config.maxTokenAgeMinutes) {
    return reject("Token too old");
  }
  if (config.minPoolAgeMinutes > 0 && (token.poolAgeMinutes || 0) < config.minPoolAgeMinutes) {
    return reject("Pool too new");
  }
  if (config.maxPoolAgeMinutes > 0 && token.poolAgeMinutes > config.maxPoolAgeMinutes) {
    return reject("Pool too old");
  }
  if (config.maxVolatility > 0 && token.volatility > config.maxVolatility) {
    return reject(`Volatility ${token.volatility} > ${config.maxVolatility}`);
  }
  if (config.minVolatility > 0 && (token.volatility || 0) < config.minVolatility) {
    return reject(`Volatility ${token.volatility} < ${config.minVolatility}`);
  }
  if (config.minFeeTvlRatio24h > 0 && (token.feeTvlRatio || 0) < config.minFeeTvlRatio24h) {
    return reject("Fee/TVL too low");
  }
  if (config.maxFeeTvlRatio24h > 0 && token.feeTvlRatio > config.maxFeeTvlRatio24h) {
    return reject("Fee/TVL too high");
  }
  if (config.minVolume5mUsd > 0 && (token.volumes?.["5m"] || 0) < config.minVolume5mUsd) {
    return reject("5m volume too low");
  }
  if (config.minVolume1hUsd > 0 && (token.volumes?.["1h"] || 0) < config.minVolume1hUsd) {
    return reject("1h volume too low");
  }
  if (config.minVolume6hUsd > 0 && (token.volumes?.["6h"] || 0) < config.minVolume6hUsd) {
    return reject("6h volume too low");
  }
  if (token.rugcheck?.rugged) {
    return reject("RugCheck marked rugged");
  }
  if (token.rugcheck?.scoreNormalised != null && token.rugcheck.scoreNormalised > config.maxRugcheckScore) {
    return reject(`RugCheck score ${token.rugcheck.scoreNormalised}`);
  }

  const { score, category, warnings } = computeRiskScore(token);
  return {
    pass: true,
    category,
    score,
    warnings,
    kolAvoid: token.kolAvoid,
    kolGreen: token.kolGreen,
  };
}

module.exports = { evaluate };
