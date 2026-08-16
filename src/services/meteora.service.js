const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

function client() {
  return createClient({
    baseURL: process.env.METEORA_DISCOVERY_URL || "https://pool-discovery-api.datapi.meteora.ag",
    name: "meteora-discovery",
  });
}

/**
 * Trending/discovery feed used by https://app.meteora.ag/?tab=trending
 * Has total_lps, volatility, dev_balance_pct, top_holders_pct.
 */
async function fetchDiscoveryPage({
  pageSize = 50,
  afterKey,
  category = "trending",
  timeframe = "24h",
  sortBy = "volume:desc",
  filterBy,
} = {}) {
  const params = {
    page_size: pageSize,
    category,
    timeframe,
    sort_by: sortBy,
  };
  if (afterKey) params.after_key = afterKey;
  if (filterBy) params.filter_by = filterBy;
  return client().get("/pools", params);
}

async function fetchDiscoveryPools(config) {
  const maxPages = Number(process.env.DISCOVERY_MAX_PAGES || 2);
  const filterParts = [
    "is_blacklisted=false",
    config.minVolume24hUsd > 0 ? `volume>=${config.minVolume24hUsd}` : null,
    config.minTvlUsd > 0 ? `tvl>=${config.minTvlUsd}` : null,
  ].filter(Boolean);

  const all = [];
  let afterKey;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchDiscoveryPage({
      pageSize: 50,
      afterKey,
      category: config.discoveryCategory || "trending",
      timeframe: config.discoveryTimeframe || "24h",
      sortBy: config.discoverySortBy || "volume:desc",
      filterBy: filterParts.join(" && "),
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    all.push(...rows);
    logger.info(`meteora discovery page ${page + 1}`, {
      got: rows.length,
      total: res?.total,
      hasMore: res?.has_more,
    });
    if (!res?.has_more || !res?.after_key || rows.length === 0) break;
    afterKey = res.after_key;
  }
  return all;
}

function normalizePool(raw) {
  return {
    poolAddress: raw.pool_address,
    name: raw.name,
    poolType: raw.pool_type,
    feePct: raw.fee_pct,
    isBlacklisted: !!raw.is_blacklisted,
    poolCreatedAt: raw.pool_created_at,
    tokenX: raw.token_x,
    tokenY: raw.token_y,
    tvl: num(raw.tvl),
    activeTvl: num(raw.active_tvl),
    volume24h: num(raw.volume),
    volumeChangePct: num(raw.volume_change_pct),
    fees24h: num(raw.fee),
    feeTvlRatio: num(raw.fee_tvl_ratio),
    feeActiveTvlRatio: num(raw.fee_active_tvl_ratio),
    volumeTvlRatio: num(raw.volume_tvl_ratio),
    swapCount: num(raw.swap_count),
    uniqueLps: num(raw.unique_lps),
    totalLps: num(raw.total_lps),
    uniqueTraders: num(raw.unique_traders),
    netDeposits: num(raw.net_deposits),
    holders: num(raw.base_token_holders),
    top10HolderPct: num(raw.token_x?.top_holders_pct),
    devBalancePct: num(raw.token_x?.dev_balance_pct),
    volatility: num(raw.volatility),
    dynamicFeePct: num(raw.dynamic_fee_pct),
    permanentLockPct: num(raw.permanent_lock_liquidity_pct),
    openPositions: num(raw.open_positions),
    activePositions: num(raw.active_positions),
    hasFarm: !!raw.has_farm,
    binStep: raw.dlmm_params?.bin_step,
    collectFeeMode: raw.dlmm_params?.collect_fee_mode,
    poolPrice: num(raw.pool_price),
    organicScore: num(raw.token_x?.organic_score),
    raw,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { fetchDiscoveryPools, fetchDiscoveryPage, normalizePool };
