const logger = require("./lib/logger");
const { mapLimit } = require("./lib/http");
const { pickBaseToken, pickQuoteToken, ageMinutes, parseIsoAgeMinutes } = require("./lib/format");
const meteora = require("./services/meteora.service");
const dexpaprika = require("./services/dexpaprika.service");
const rugcheck = require("./services/rugcheck.service");
const dexscreener = require("./services/dexscreener.service");
const solanaWallet = require("./services/solanaWallet.service");
const gmgn = require("./services/gmgn.service");
const { evaluate } = require("./engine/ruleEngine");
const userConfig = require("./state/userConfig.store");
const seenPools = require("./state/seenPools.store");
const lastScan = require("./state/lastScan.store");
const kolWallets = require("./state/kolWallets.store");

function buildToken(rawPool, paprika, rug, dex, gmgnInfo, kol) {
  const pool = meteora.normalizePool(rawPool);
  const base = pickBaseToken(pool.tokenX, pool.tokenY);
  const quote = pickQuoteToken(pool.tokenX, pool.tokenY);
  const mint = base?.address;

  const tokenAgeMeteora = ageMinutes(base?.created_at);
  const tokenAgePaprika = parseIsoAgeMinutes(paprika?.tokenCreatedAt || paprika?.createdAt);
  const tokenAgeMinutes = tokenAgeMeteora ?? tokenAgePaprika;
  const poolAgeMinutes = ageMinutes(pool.poolCreatedAt) ?? parseIsoAgeMinutes(paprika?.createdAt);

  const volumes = {
    "5m": paprika?.volumes?.["5m"] ?? null,
    "1h": paprika?.volumes?.["1h"] ?? null,
    "6h": paprika?.volumes?.["6h"] ?? null,
    "24h": paprika?.volumes?.["24h"] ?? pool.volume24h,
  };

  const tvlLiqRatio =
    paprika?.liquidityUsd > 0 && pool.tvl != null ? pool.tvl / paprika.liquidityUsd : null;

  return {
    ...pool,
    mint,
    symbol: base?.symbol || pool.name,
    tokenName: base?.name || pool.name,
    quoteSymbol: quote?.symbol || "",
    hasMintAuthority: !!base?.has_mint_authority,
    hasFreezeAuthority: !!base?.has_freeze_authority,
    tokenAgeMinutes,
    poolAgeMinutes,
    volumes,
    paprikaLiquidityUsd: paprika?.liquidityUsd ?? null,
    tvlLiqRatio,
    dexUrl: dex?.url || `https://dexscreener.com/solana/${mint}`,
    rugcheckUrl: `https://rugcheck.xyz/tokens/${mint}`,
    meteoraUrl: `https://app.meteora.ag/dlmm/${pool.poolAddress}`,
    paprikaUrl: `https://dexpaprika.com/solana/pool/${pool.poolAddress}`,
    gmgnUrl: `https://gmgn.ai/sol/token/${mint}`,
    rugcheck: rug,
    gmgn: gmgnInfo,
    kolAvoid: kol.avoid,
    kolGreen: kol.greenFlag,
    marketCap: base?.market_cap ?? null,
  };
}

async function enrichOne(raw, kolHoldings) {
  const pool = meteora.normalizePool(raw);
  const base = pickBaseToken(pool.tokenX, pool.tokenY);
  const mint = base?.address;
  const [paprikaRes, rugRes, dexRes, gmgnRes] = await Promise.allSettled([
    dexpaprika.enrichPool(pool.poolAddress, mint),
    rugcheck.safeReport(mint),
    dexscreener.bestPairLiquidity(mint, pool.poolAddress),
    gmgn.getTokenInfo(mint),
  ]);

  const paprika = paprikaRes.status === "fulfilled" ? paprikaRes.value : null;
  const rug = rugRes.status === "fulfilled" ? rugRes.value : null;
  const dex = dexRes.status === "fulfilled" ? dexRes.value : null;
  const gmgnInfo = gmgnRes.status === "fulfilled" ? gmgnRes.value : null;
  const kol = solanaWallet.matchKol(kolHoldings, mint);

  return buildToken(raw, paprika, rug, dex, gmgnInfo, kol);
}

async function runScan({ alert = true, force = false } = {}) {
  const started = Date.now();
  const config = userConfig.load();
  const status = lastScan.load();
  lastScan.heartbeat();

  if (status.paused && !force) {
    logger.info("scan skipped — paused");
    return { paused: true, recommended: status.recommended || [] };
  }

  let scanned = 0;
  let rejected = 0;
  let errors = 0;
  const rejectReasons = {};
  const recommended = [];
  const freshAlerts = [];

  let pools = [];
  try {
    pools = await meteora.fetchDiscoveryPools(config);
  } catch (err) {
    logger.error("discovery failed", { err: err.message });
    lastScan.save({
      ...lastScan.load(),
      at: new Date().toISOString(),
      errors: 1,
    });
    throw err;
  }

  let kolHoldings = [];
  try {
    kolHoldings = await solanaWallet.scanKolHoldings(kolWallets.allTagged());
  } catch (err) {
    logger.warn("KOL snapshot failed, continuing without it", { err: err.message });
  }

  const concurrency = Number(process.env.ENRICH_CONCURRENCY || 3);
  const results = await mapLimit(pools, concurrency, async (raw) => {
    scanned += 1;
    const token = await enrichOne(raw, kolHoldings);
    const verdict = evaluate(token, config);
    return { token, verdict };
  });

  for (const r of results) {
    if (!r.ok) {
      errors += 1;
      logger.warn("token cycle error", { err: r.error.message });
      continue;
    }
    const { token, verdict } = r.value;
    if (!verdict.pass) {
      rejected += 1;
      rejectReasons[verdict.reason] = (rejectReasons[verdict.reason] || 0) + 1;
      logger.debug("reject", { pool: token.poolAddress, reason: verdict.reason });
      continue;
    }
    const item = { token, verdict };
    recommended.push(item);
    if (alert && !seenPools.has(token.poolAddress)) {
      freshAlerts.push(item);
      seenPools.mark(token.poolAddress, { symbol: token.symbol, score: verdict.score });
    }
  }

  const summary = {
    at: new Date().toISOString(),
    paused: false,
    heartbeat: new Date().toISOString(),
    scanned,
    rejected,
    rejectReasons,
    errors,
    ms: Date.now() - started,
    recommended: recommended.map(compactResult),
  };
  lastScan.save(summary);
  logger.info("scan done", {
    scanned,
    recommended: recommended.length,
    fresh: freshAlerts.length,
    rejected,
    errors,
    ms: summary.ms,
  });

  return { ...summary, recommended, freshAlerts };
}

function compactResult({ token, verdict }) {
  return {
    poolAddress: token.poolAddress,
    mint: token.mint,
    name: token.name,
    symbol: token.symbol,
    poolType: token.poolType,
    marketCap: token.marketCap,
    tvl: token.tvl,
    activeTvl: token.activeTvl,
    volumes: token.volumes,
    volume24h: token.volume24h,
    fees24h: token.fees24h,
    feeTvlRatio: token.feeTvlRatio,
    totalLps: token.totalLps,
    uniqueLps: token.uniqueLps,
    holders: token.holders,
    top10HolderPct: token.top10HolderPct,
    devBalancePct: token.devBalancePct,
    volatility: token.volatility,
    tokenAgeMinutes: token.tokenAgeMinutes,
    poolAgeMinutes: token.poolAgeMinutes,
    score: verdict.score,
    category: verdict.category,
    warnings: verdict.warnings,
    kolAvoid: token.kolAvoid,
    kolGreen: token.kolGreen,
    dexUrl: token.dexUrl,
    rugcheckUrl: token.rugcheckUrl,
    meteoraUrl: token.meteoraUrl,
    paprikaUrl: token.paprikaUrl,
    gmgnUrl: token.gmgnUrl,
  };
}

module.exports = { runScan, enrichOne, compactResult };
