import { DAY, SOL, USDC, finite } from '../config.js';
import { parallel } from '../clients/http.js';
import { latestPools, setMeta, snapshot } from '../db.js';
import { mergeLabels } from '../strategy/distribution.js';

const clamp = (n, max = 1) => Math.max(0, Math.min(max, n));
export function trendingScore(pool, whales, settings, now) {
  const age = pool.createdAt == null ? null : (now - pool.createdAt) / DAY;
  if (pool.blacklisted || !(pool.tvl >= settings.minTvl) ||
      (settings.minFdv > 0 && !(pool.fdv >= settings.minFdv)) ||
      (age != null && (age < settings.trendMinDays || age > settings.trendMaxDays))) return null;
  const weights = settings.trendWeights;
  const momentum = pool.volume24 > 0 && pool.volume1 != null ? clamp((pool.volume1 * 24 / pool.volume24 - 1) / 4) : 0;
  const rankedWhales = whales?.wallets.reduce((sum, wallet) => sum + (wallet.rank ? 1 + 1 / Math.sqrt(wallet.rank) : 1), 0) ?? 0;
  return Math.max(0, weights.fee * clamp((pool.feeTvl1 ?? 0) / 0.01) + weights.momentum * momentum +
    weights.liquidity * clamp(Math.log10(Math.max(1, pool.tvl / Math.max(1, settings.minTvl))) / 2) +
    weights.age * (age == null ? 0 : clamp(1 - age / 30)) + weights.whales * clamp(rankedWhales / 6) -
    weights.risk * (pool.risks?.length ?? 0));
}

export function whalePools(db) {
  const rows = db.prepare(`SELECT p.*,w.current_rank,g.deposit_usd AS wallet_pool_deposit_usd
    FROM positions p JOIN wallets w ON p.wallet=w.address
    JOIN whale_deposits g ON g.wallet=p.wallet AND g.pool=p.pool
    JOIN current_position_observations c ON c.position_pubkey=p.position_pubkey
    WHERE p.status='open' AND w.is_blacklisted=0 AND
      (w.current_rank IS NOT NULL OR w.is_favorite=1 OR w.alert_count>0 OR w.validation='public_sample')`).all();
  const pools = new Map();
  for (const row of rows) {
    if (!pools.has(row.pool)) pools.set(row.pool, new Map());
    const wallets = pools.get(row.pool);
    const wallet = wallets.get(row.wallet) ?? { wallet: row.wallet, rank: row.current_rank,
      depositUsd: row.wallet_pool_deposit_usd, labels: [], sizes: [], widths: [], name: row.pool_name };
    wallet.labels.push(row.strategy_label);
    if (row.current_sol != null) wallet.sizes.push(row.current_sol);
    if (row.width_pct != null) wallet.widths.push(row.width_pct);
    wallets.set(row.wallet, wallet);
  }
  return [...pools].map(([address, items]) => {
    const wallets = [...items.values()];
    const mix = {};
    const sizes = wallets.flatMap(row => row.sizes);
    const widths = wallets.flatMap(row => row.widths);
    for (const wallet of wallets) {
      const label = mergeLabels(...wallet.labels);
      if (label) mix[label] = (mix[label] ?? 0) + 1;
    }
    return { address, name: wallets.find(row => row.name)?.name, wallets, count: wallets.length, mix,
      depositUsd: wallets.reduce((sum, wallet) => sum + wallet.depositUsd, 0),
      size: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
      width: widths.length ? widths.reduce((sum, width) => sum + width, 0) / widths.length : null };
  }).sort((a, b) => b.count - a.count || (b.size ?? 0) - (a.size ?? 0));
}

export async function refreshIntel({ db, providers, settings, logger }, now = Date.now()) {
  const [pools, prices] = await Promise.all([providers.poolList(), providers.prices([SOL, USDC]).catch(() => null)]);
  const candidates = pools.slice(0, settings.poolsPerRun);
  const seen = new Set(candidates.map(row => row.address));
  for (const whale of whalePools(db)) {
    if (!seen.has(whale.address)) candidates.push({ address: whale.address });
  }
  const rows = await parallel(candidates, settings.concurrency, async row => {
    const pool = row.name ? row : await providers.pool(row.address);
    return providers.poolDetails(pool, true);
  });
  db.transaction(() => {
    const solUsd = finite(prices?.[SOL]?.usdPrice);
    if (solUsd > 0) setMeta(db, 'sol_usd', solUsd);
    const usdcUsd = finite(prices?.[USDC]?.usdPrice);
    if (usdcUsd > 0) setMeta(db, 'usdc_usd', usdcUsd);
    for (const row of rows) {
      if (row.value) snapshot(db, row.value, now);
      else logger.warn({ reason: row.error.message }, 'Pool snapshot failed');
    }
  })();
}

export function trending(db, settings, now = Date.now()) {
  const whales = new Map(whalePools(db).map(row => [row.address, row]));
  return latestPools(db).filter(pool => !pool.takenAt || now - pool.takenAt <= 3 * settings.trendMs)
    .map(pool => ({ ...pool, whales: whales.get(pool.address), score: trendingScore(pool, whales.get(pool.address), settings, now) }))
    .filter(pool => pool.score != null)
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}
