import { DAY } from '../config.js';
import { http, parallel, url } from '../clients/http.js';
import { createProviders } from '../clients/providers.js';
import { getMeta, leaderboard, replaceLeaderboard, savePublicPosition, setMeta } from '../db.js';
import { normalizePosition } from '../public-snapshot.js';
import { isAddress } from '../strategy/instructions.js';
import { enrollWallets, scoreWallets, summarize } from './leaderboard.js';
import { smartLpStatus } from './smart-lp.js';

const endpoint = 'https://dlmm.datapi.meteora.ag';
const emptyActivity = new Map();
const favoriteCheckPrefix = 'public_smart_lp_favorite:';

function favoriteWallets(db) {
  return db.prepare(`SELECT w.address, m.value AS outcome FROM wallets w
    LEFT JOIN metadata m ON m.key=? || w.address
    WHERE w.is_favorite=1 AND w.is_blacklisted=0 ORDER BY w.address`).all(favoriteCheckPrefix)
    .filter(row => isAddress(row.address));
}

export function hasPendingSmartLpFavorites(db) {
  return favoriteWallets(db).some(row => row.outcome == null);
}

export function resetSmartLpFavorite(db, address) {
  db.prepare('DELETE FROM metadata WHERE key=?').run(favoriteCheckPrefix + address);
}

export function publicHistoryProviders(settings, logger, signal, stream) {
  const { candles, positionEvents } = createProviders(settings, logger, signal);
  const request = http('Meteora Smart LP', { rpm: 180, timeout: 8000, retries: 1, signal });

  async function pages(path, query, field, maxSize) {
    const rows = [];
    for (let page = 1; page <= settings.historyPages; page++) {
      const result = await request(url(endpoint, path, { ...query, page, page_size: maxSize }), { ttl: 120000 });
      if (!Array.isArray(result[field]) || typeof result.hasNext !== 'boolean') throw new Error('Incomplete Meteora ' + field + ' page');
      rows.push(...result[field]);
      if (!result.hasNext) return rows;
    }
    throw new Error('Meteora ' + field + ' page limit reached');
  }

  async function positions(wallet, status, since) {
    const closed = status === 'closed';
    const now = Date.now();
    const daysBack = closed ? Math.max(1, Math.ceil((now - since) / DAY) + 1) : undefined;
    if (daysBack > 365) throw new Error('Meteora history exceeds the 365-day portfolio window');
    const pools = await pages(closed ? '/portfolio' : '/portfolio/open', { user: wallet, days_back: daysBack }, 'pools', 50);
    if (pools.some(pool => !isAddress(pool.poolAddress))) throw new Error('Incomplete Meteora wallet portfolio');
    const distinct = new Map(pools.map(pool => [pool.poolAddress, pool]));
    const found = await parallel([...distinct.values()], 2, async pool => {
      const rows = await pages('/positions/' + pool.poolAddress + '/pnl', { user: wallet, status }, 'positions', 100);
      return rows.flatMap(indexed => {
        const position = normalizePosition(indexed, pool, wallet, emptyActivity, now);
        if (indexed.isClosed !== closed || !isAddress(position.position_pubkey) || (closed && !position.closed_at)) {
          throw new Error('Incomplete Meteora ' + status + ' position');
        }
        if (closed && position.closed_at < since) return [];
        if (closed) {
          const { pnl_sol: pnl, deposit_sol: deposit, withdraw_sol: withdraw, fees_sol: fees } = position;
          if (![pnl, deposit, withdraw, fees].every(Number.isFinite) || !(deposit > 0) ||
            !position.opened_at || position.opened_at > position.closed_at ||
            Math.abs(pnl - (withdraw + fees - deposit)) > Math.max(0.00001, Math.abs(pnl) * 0.00001)) {
            throw new Error('Unreconciled Meteora closed position');
          }
        }
        return [{ ...position, indexed, tokens: { tokenX: pool.tokenXMint, tokenY: pool.tokenYMint } }];
      });
    });
    const failure = found.find(result => result.error);
    if (failure) throw failure.error;
    return [...new Map(found.flatMap(row => row.value).map(row => [row.position_pubkey, row])).values()];
  }

  return { closedPositions: (wallet, since) => positions(wallet, 'closed', since),
    openPositions: wallet => positions(wallet, 'open'), candles, positionEvents, transaction: stream.transaction };
}

export async function discoverPublicSmartLp({ db, settings, providers, logger, signal }, now = Date.now()) {
  const sampled = JSON.parse(getMeta(db, 'public_sample_owners') ?? '[]');
  const favorites = new Set(favoriteWallets(db).map(row => row.address));
  const profileSeeds = db.prepare(`SELECT address FROM wallets WHERE current_rank IS NOT NULL
    UNION SELECT wallet AS address FROM whale_deposits`).all().map(row => row.address);
  const blocked = new Set(db.prepare('SELECT address FROM wallets WHERE is_blacklisted=1').pluck().all());
  const candidates = [...new Set([...favorites, ...profileSeeds, ...sampled])]
    .filter(address => isAddress(address) && !blocked.has(address)).slice(0, Math.max(settings.candidates, favorites.size));
  if (!candidates.length) return;
  const source = 'Meteora DLMM Data API';
  const health = { source, windowDays: settings.windowDays, minClosed: settings.minClosed,
    startedAt: now, candidates: candidates.length, measured: 0, incomplete: 0, eligible: null, state: 'running' };
  setMeta(db, 'public_smart_lp_health', JSON.stringify(health));
  const progress = { ...health };
  const results = await parallel(candidates, settings.concurrency, async wallet => {
    try {
      const positions = await providers.closedPositions(wallet, now - settings.windowDays * DAY);
      const result = summarize(wallet, positions, settings, now);
      progress.measured++;
      return result;
    } catch (error) {
      progress.incomplete++;
      throw error;
    } finally {
      if (!signal?.aborted && (progress.measured + progress.incomplete) % 5 === 0) {
        setMeta(db, 'public_smart_lp_health', JSON.stringify(progress));
      }
    }
  });
  signal?.throwIfAborted();
  const failures = results.filter(result => result.error);
  for (const { error } of failures.slice(0, 5)) logger.warn({ reason: error.message }, 'Public Smart LP history incomplete');
  const eligible = results.map(result => result.value).filter(Boolean);
  const top = scoreWallets(eligible).slice(0, settings.top)
    .map((row, index) => ({ ...row, rank: index + 1, validation: 'meteora_reconciled' }));
  const measured = candidates.length - failures.length;
  const previousCount = leaderboard(db).length;
  const retained = failures.length > 0 && (!measured || top.length < previousCount * 0.8);
  const report = { ...health, measured, incomplete: failures.length, eligible: eligible.length, finishedAt: Date.now(),
    state: retained ? 'retained' : failures.length ? 'partial' : 'complete' };
  db.transaction(() => {
    const currentFavorites = new Set(favoriteWallets(db).map(row => row.address));
    for (const [index, address] of candidates.entries()) {
      if (!favorites.has(address) || !currentFavorites.has(address)) continue;
      const result = results[index];
      const outcome = result.error ? 'history_unavailable' : result.value ? 'eligible' : 'did_not_qualify';
      setMeta(db, favoriteCheckPrefix + address, outcome);
    }
    if (!retained) {
      replaceLeaderboard(db, top, now);
      for (const row of top) {
        for (const position of row.positions) savePublicPosition(db, { ...position, last_checked_at: report.finishedAt });
      }
      enrollWallets(db, top.map(row => row.address), 'candidate', now, settings.windowDays);
    }
    setMeta(db, 'public_smart_lp_health', JSON.stringify(report));
  }).immediate();
  logger.info(report, 'Public Smart LP scan finished');
  return report;
}

export function publicSmartLpReport(db, now = Date.now()) {
  const health = JSON.parse(getMeta(db, 'public_smart_lp_health') ?? 'null');
  const ranked = leaderboard(db);
  const rankedAddresses = new Set(ranked.map(row => row.address));
  return { health, leaderboardAt: Number(getMeta(db, 'leaderboard_at')) || null,
    favorites: favoriteWallets(db).filter(row => !rankedAddresses.has(row.address))
      .map(row => ({ wallet: row.address, status: row.outcome ?? 'queued' })),
    wallets: ranked.map(row => ({
      wallet: row.address, rank: row.current_rank, score: row.score, pnlSol: row.realized_pnl_sol, roi: row.roi,
      winRate: row.win_rate, closedPositions: row.n_closed, favorite: Boolean(row.is_favorite),
      status: smartLpStatus(db, row.address, now).status,
    })) };
}
