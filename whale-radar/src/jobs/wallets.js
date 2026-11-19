import { parallel } from '../clients/http.js';
import { getMeta, refreshProfile, savePosition, setMeta, touchWallet } from '../db.js';
import { priceRange } from '../strategy/distribution.js';

export async function refreshWallet(ctx, address, { full = false, classifyHistory = true } = {}) {
  const { db, providers, tools, settings, logger } = ctx;
  const started = Date.now();
  const previous = db.prepare('SELECT * FROM positions WHERE wallet=?').all(address);
  const index = new Map(previous.map(row => [row.position_pubkey, row]));
  const [open, bins] = await Promise.all([
    providers.openPositions(address),
    tools.bins(address).catch(error => {
      logger.warn({ wallet: address, reason: error.message }, 'Position bins unavailable');
      return new Map();
    }),
  ]);
  const openIds = new Set(open.map(row => row.position_pubkey));
  const vanished = previous.some(row => row.status === 'open' && !openIds.has(row.position_pubkey));
  const initialized = getMeta(db, 'backfill:' + address);
  let closed = [];
  if (full || !initialized || vanished) {
    closed = await providers.closedPositions(address);
  }
  const all = [...open, ...closed];
  const results = await parallel(all, settings.concurrency, async row => {
    const cached = index.get(row.position_pubkey);
    const state = bins.get(row.position_pubkey);
    let position = tools.applyBins({
      ...row, last_checked_at: started,
      ...priceRange(row.lower_bin_id, row.upper_bin_id, row.bin_step, row.decimalsX, row.decimalsY),
    }, state);
    if (classifyHistory && cached?.strategy_source !== 'instruction' && (!cached || full || row.status === 'open')) {
      try {
        const history = await tools.historicalStrategy(row);
        if (history?.strategy_label) position = { ...position, ...history };
      } catch (error) {
        logger.debug({ position: row.position_pubkey, reason: error.message }, 'Opening strategy unavailable');
      }
    }
    return { position, bins: state?.bins };
  });
  db.transaction(() => {
    touchWallet(db, address, started);
    for (const result of results) {
      if (result.error) throw result.error;
      savePosition(db, result.value.position, result.value.bins);
    }
    refreshProfile(db, address, started);
    db.prepare('UPDATE wallets SET refreshed_at=? WHERE address=?').run(started, address);
    if (!initialized || full) setMeta(db, 'backfill:' + address, started);
  }).immediate();
  logger.info({ wallet: address, open: open.length, closed: closed.length }, 'Wallet positions refreshed');
}

export async function refreshDueWallets(ctx) {
  const { db, settings, logger } = ctx;
  const now = Date.now();
  const jobs = db.prepare(`SELECT j.*,w.is_favorite FROM wallet_jobs j JOIN wallets w ON w.address=j.wallet
    WHERE j.due_at<=? ORDER BY w.is_favorite DESC,j.due_at LIMIT ?`).all(now, settings.concurrency);
  const results = await parallel(jobs, settings.concurrency, async job => {
    try {
      await refreshWallet(ctx, job.wallet);
      db.prepare('UPDATE wallet_jobs SET attempts=0,due_at=? WHERE wallet=?')
        .run(Date.now() + (job.is_favorite ? 5 : 30) * 60000, job.wallet);
    } catch (error) {
      db.prepare('UPDATE wallet_jobs SET attempts=attempts+1,due_at=? WHERE wallet=?')
        .run(Date.now() + Math.min(1800000, 60000 * 2 ** Math.min(job.attempts, 5)), job.wallet);
      throw error;
    }
  });
  for (const [i, result] of results.entries()) {
    if (result.error) logger.warn({ wallet: jobs[i].wallet, reason: result.error.message }, 'Wallet refresh deferred');
  }
}

export function reclassify(db, classify, now = Date.now()) {
  const rows = db.prepare("SELECT position_pubkey,wallet FROM positions WHERE coalesce(strategy_source,'')!='instruction'").all();
  const read = db.prepare('SELECT bin_id AS id,amount_x AS x,amount_y AS y,liquidity FROM position_bins WHERE position_pubkey=? ORDER BY bin_id');
  const update = db.prepare(`UPDATE positions SET strategy_label=?,strategy_source=?,confidence=?,one_sided=? WHERE position_pubkey=?`);
  db.transaction(() => {
    for (const row of rows) {
      const state = classify(read.all(row.position_pubkey));
      update.run(state.label, state.source, state.confidence, state.oneSided, row.position_pubkey);
    }
    for (const wallet of new Set(rows.map(row => row.wallet))) refreshProfile(db, wallet, now);
  }).immediate();
  return rows.length;
}
