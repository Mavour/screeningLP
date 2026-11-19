import { DAY } from '../config.js';
import { createHash } from 'node:crypto';
import { parallel } from '../clients/http.js';
import { replaceLeaderboard, scheduleWallet, touchWallet } from '../db.js';
import { isAddress } from '../strategy/instructions.js';

export function summarize(address, items, settings, now) {
  const positions = [...new Map(items.map(row => [row.position_pubkey, row])).values()].filter(row =>
    row.status === 'closed' && row.closed_at >= now - settings.windowDays * DAY && row.closed_at <= now &&
    row.opened_at != null && row.opened_at <= row.closed_at && Number.isFinite(row.pnl_sol) && row.deposit_sol > 0);
  const count = positions.length;
  if (count < settings.minClosed) return null;
  const sum = key => positions.reduce((total, position) => total + position[key], 0);
  const deposit = sum('deposit_sol');
  const pnl = sum('pnl_sol');
  const size = deposit / count;
  const hold = positions.reduce((total, position) => total + position.closed_at - position.opened_at, 0) / count / 60000;
  const profits = positions.map(row => row.pnl_sol).filter(value => value > 0);
  const grossProfit = profits.reduce((total, value) => total + value, 0);
  const days = Math.max(1, (Math.max(...positions.map(row => row.closed_at)) - Math.min(...positions.map(row => row.closed_at))) / DAY);
  if (size < settings.minAvgSol || pnl <= 0 || Math.max(...profits) / grossProfit > settings.concentration ||
      (hold < settings.botHoldMinutes && count / days > settings.botDaily)) return null;
  return { address, pnl, roi: pnl / deposit, winRate: profits.length / count, count, size, hold, positions };
}

export function scoreWallets(wallets) {
  if (!wallets.length) return [];
  const weights = { pnl: 0.5, roi: 0.3, winRate: 0.2 };
  const scores = new Map(wallets.map(row => [row.address, 0]));
  for (const [metric, weight] of Object.entries(weights)) {
    const sorted = [...wallets].sort((a, b) => a[metric] - b[metric]);
    for (let left = 0; left < sorted.length;) {
      let right = left;
      while (right + 1 < sorted.length && sorted[right + 1][metric] === sorted[left][metric]) right++;
      const part = sorted.length === 1 ? 1 : (left + right) / (2 * (sorted.length - 1));
      for (let i = left; i <= right; i++) scores.set(sorted[i].address, scores.get(sorted[i].address) + 100 * weight * part);
      left = right + 1;
    }
  }
  return wallets.map(row => ({ ...row, score: scores.get(row.address) }))
    .sort((a, b) => b.score - a.score || b.pnl - a.pnl || a.address.localeCompare(b.address));
}

export function verification(matches, count, tolerance) {
  if (matches.length < Math.ceil(count * 0.8)) return 'insufficient';
  const [lp, meteora] = matches.reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]);
  const scale = matches.reduce((sum, [value]) => sum + Math.abs(value), 0);
  const error = matches.reduce((sum, [a, b]) => sum + Math.abs(a - b), 0);
  return Math.abs(lp - meteora) <= Math.max(0.5, Math.abs(lp) * tolerance) &&
    error <= Math.max(0.5, scale * tolerance) ? 'matched' : 'disagreement';
}

function stratum(pool, candles, now) {
  const age = pool.createdAt ? now - pool.createdAt : null;
  const returns = candles.slice(1).map((row, i) => Math.log(row.close / candles[i].close));
  const volatility = returns.length >= 12 ? Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0)) : null;
  return [
    age == null ? 'unknown' : age < 7 * DAY ? 'new' : age < 30 * DAY ? 'young' : 'established',
    pool.volume24 < 250000 ? 'lower' : pool.volume24 < 1000000 ? 'middle' : 'higher',
    volatility == null ? 'unknown' : volatility < 0.05 ? 'lower' : 'higher',
  ].join('/');
}

async function diversify(pools, providers, settings, now) {
  const end = Math.floor(now / 3600000) * 3600000;
  const sample = pools.slice(0, settings.poolsPerRun * 3);
  const results = await parallel(sample, settings.concurrency,
    pool => providers.candles(pool.address, '1h', end - DAY, end - 1000));
  const strata = new Map();
  for (const [i, pool] of sample.entries()) {
    const key = stratum(pool, results[i].value ?? [], now);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(pool);
  }
  const selected = [];
  while (selected.length < settings.poolsPerRun && strata.size) {
    for (const [key, values] of strata) {
      selected.push(values.shift());
      if (!values.length) strata.delete(key);
      if (selected.length === settings.poolsPerRun) break;
    }
  }
  return selected;
}

function recordSelection(db, harvested, ranked, controls, now, days) {
  db.transaction(() => {
    const record = db.prepare(`INSERT OR IGNORE INTO pool_rank_observations
      VALUES (?,?,?,'LP Agent','total_pnl_native',?)`);
    for (const row of harvested) {
      touchWallet(db, row.owner, now);
      record.run(row.pool, row.owner, now, row.rank);
    }
    enrollWallets(db, ranked.map(row => row.address), 'candidate', now, days);
    enrollWallets(db, controls, 'comparison', now, days);
  }).immediate();
}

export function enrollWallets(db, wallets, cohort, now, days) {
  const enroll = db.prepare(`INSERT INTO smart_lp_evaluations(wallet,starts_at,ends_at,cohort)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM smart_lp_evaluations WHERE wallet=?
      AND (status IN ('pending','insufficient') OR ends_at>?))`);
  for (const wallet of wallets) {
    touchWallet(db, wallet, now);
    enroll.run(wallet, now, now + days * DAY, cohort, wallet, now);
  }
}

export async function discover({ db, providers, settings, logger }, now = Date.now()) {
  const pools = (await providers.poolList())
    .filter(row => row.address && !row.blacklisted && row.volume24 >= settings.minVolume && row.tvl >= settings.minTvl &&
      row.fees24 != null && row.fees24 >= settings.minFees);
  const screened = settings.minOrganic > 0
    ? (await parallel(pools.slice(0, settings.poolsPerRun * 2), settings.concurrency, pool => providers.poolDetails(pool)))
      .map(row => row.value).filter(pool => pool?.organic != null && pool.organic >= settings.minOrganic)
    : pools;
  const blacklist = new Set(db.prepare('SELECT address FROM wallets WHERE is_blacklisted=1').all().map(row => row.address));
  const selected = await diversify(screened, providers, settings, now);
  const harvest = await parallel(selected, settings.concurrency, async pool => {
    const seed = createHash('sha256').update(pool.address + ':' + Math.floor(now / (settings.windowDays * DAY))).digest().readUInt32BE();
    const { ranks, comparison } = await providers.topLpers(pool.address, seed);
    const annotate = rows => rows.filter(row => isAddress(row.owner) && Number.isSafeInteger(row.rank) && row.rank > 0)
      .map(row => ({ ...row, pool: pool.address }));
    return { ranks: annotate(ranks), comparison: annotate(comparison) };
  });
  const primary = harvest.flatMap(row => row.value?.ranks ?? []);
  const comparison = harvest.flatMap(row => row.value?.comparison ?? []);
  const candidateSet = new Set(primary.map(row => row.owner));
  const addresses = [...candidateSet]
    .filter(address => isAddress(address) && !blacklist.has(address)).slice(0, settings.candidates);
  const results = await parallel(addresses, settings.concurrency, async address => {
    const positions = await providers.closedPositions(address, now - settings.windowDays * DAY);
    return summarize(address, positions, settings, now);
  });
  const scored = scoreWallets(results.map(row => row.value).filter(Boolean));
  const checked = await parallel(scored.slice(0, settings.crossCheck), settings.concurrency, async row => ({
    ...row, validation: verification(await providers.crossCheck(row.address, row.positions), row.count, settings.pnlTolerance),
  }));
  const failures = [...harvest, ...results, ...checked].filter(row => row.error);
  for (const row of failures.slice(0, 10)) logger.warn({ reason: row.error.message }, 'Discovery provider request failed');
  const valid = checked.map(row => row.value).filter(Boolean);
  for (const row of valid.filter(row => row.validation === 'disagreement')) {
    logger.warn({ wallet: row.address }, 'Excluded wallet with LP Agent and Meteora PnL disagreement');
  }
  const top = [...valid.filter(row => row.validation !== 'disagreement'),
    ...scored.slice(settings.crossCheck).map(row => ({ ...row, validation: 'not_sampled' }))]
    .slice(0, settings.top).map((row, i) => ({ ...row, rank: i + 1 }));
  if (failures.length && (!top.length || !valid.some(row => row.validation === 'matched'))) {
    throw new Error('Discovery provider unavailable or no cross-validated results; previous leaderboard retained');
  }
  // Preserve a usable snapshot when a partial outage would remove most previously ranked wallets.
  const previousCount = db.prepare('SELECT count(*) AS n FROM wallets WHERE current_rank IS NOT NULL AND is_blacklisted=0').get().n;
  if (failures.length && top.length < previousCount * 0.8) {
    throw new Error('Partial discovery would shrink leaderboard; previous leaderboard retained');
  }
  replaceLeaderboard(db, top, now);
  const controls = [...new Set(comparison.map(row => row.owner))]
    .filter(address => !blacklist.has(address) && !candidateSet.has(address));
  recordSelection(db, [...primary, ...comparison], top, controls, now, settings.windowDays);
  const unscheduled = db.prepare('SELECT 1 FROM wallet_jobs WHERE wallet=?');
  db.transaction(() => {
    for (const row of top) if (!unscheduled.get(row.address)) scheduleWallet(db, row.address, now);
  }).immediate();
  logger.info({ candidates: addresses.length, ranked: top.length, crossChecked: valid.length, failures: failures.length }, 'Leaderboard refreshed');
  return top;
}
