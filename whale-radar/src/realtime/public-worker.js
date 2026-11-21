import { PUBLIC_OPENING_MIN_USD, WHALE_DEPOSIT_USD } from '../config.js';
import { parallel } from '../clients/http.js';
import { getMeta, latestPools, refreshProfile, savePublicOpening, savePublicPosition, setMeta, snapshot, touchWallet } from '../db.js';
import { openingDepositUsd, serializePublicOpening } from '../public-snapshot.js';
import { classifyOpeningMarket } from '../opening-market.js';
import { accountOwner, closurePositions, isAddress, parsePositions, PROGRAM } from '../strategy/instructions.js';
import { enqueue } from './worker.js';

export function publicWatchPools(db) {
  const selected = JSON.parse(getMeta(db, 'public_watch_pools') ?? '[]').filter(isAddress);
  if (selected.length) return selected;
  return latestPools(db).filter(pool => !pool.blacklisted && isAddress(pool.address))
    .sort((a, b) => (b.volume24 ?? 0) - (a.volume24 ?? 0)).slice(0, 12).map(pool => pool.address);
}

export function publicLiquidityLogs(logs) {
  return logs.some(line => line.startsWith('Program ' + PROGRAM + ' invoke')) &&
    logs.some(line => /^Program log: Instruction: (?:AddLiquidity|ClosePosition)/.test(line));
}

export async function pollPublicPools(ctx, pools) {
  const results = await parallel(pools, 2, async pool => {
    const key = 'public-poll:' + pool;
    const previous = getMeta(ctx.db, key);
    const rows = await ctx.providers.signatures(pool, { limit: 8, until: previous });
    if (!Array.isArray(rows)) throw new Error('Invalid public signature page');
    if (!rows.length) return;
    ctx.db.transaction(() => {
      const signatures = rows.filter(row => !row.err).slice(0, previous ? 8 : 3);
      enqueue(ctx.db, signatures.reverse().map(row => row.signature));
      setMeta(ctx.db, key, rows[0].signature);
    }).immediate();
  });
  const failed = results.filter(row => row.error).length;
  if (failed) ctx.logger.warn({ failed, sampled: pools.length }, 'Some fallback RPC polls failed');
  return pools.length - failed;
}

export async function refreshPublicWallets({ db, providers, logger, signal }, now = Date.now()) {
  const targets = db.prepare(`SELECT candidates.wallet,candidates.pool FROM (
    SELECT wallet,pool FROM whale_deposits
    UNION SELECT p.wallet,p.pool FROM positions p JOIN wallets w ON w.address=p.wallet
      WHERE p.status='open' AND w.is_favorite=1 AND w.is_blacklisted=0
    ) candidates
    LEFT JOIN public_pool_refresh seen ON seen.wallet=candidates.wallet AND seen.pool=candidates.pool
    ORDER BY coalesce(seen.observed_at,0),candidates.wallet,candidates.pool LIMIT 20`).all();
  const results = await parallel(targets, 3, async ({ wallet, pool }) => {
    const state = await providers.openPoolPositions(wallet, pool, now);
    signal?.throwIfAborted();
    db.transaction(() => {
      const previous = db.prepare('SELECT observed_at FROM public_pool_refresh WHERE wallet=? AND pool=?').get(wallet, pool);
      if ((previous?.observed_at ?? 0) > now || Number(getMeta(db, 'public_snapshot_at') ?? 0) > now) return;
      db.prepare(`INSERT INTO public_pool_refresh VALUES (?,?,?) ON CONFLICT(wallet,pool)
        DO UPDATE SET observed_at=excluded.observed_at`).run(wallet, pool, now);
      for (const { position } of state.positions.values()) savePublicPosition(db, position);
      refreshProfile(db, wallet, now);
    }).immediate();
  });
  signal?.throwIfAborted();
  const errors = results.filter(result => result.error);
  if (errors.length) logger.warn({ failed: errors.length, sampled: targets.length }, 'Tracked wallet refresh incomplete');
  if (errors.length < targets.length) setMeta(db, 'public_wallets_at', now);
  setMeta(db, 'public_wallets_state', errors.length === 0 ? (targets.length ? 'complete' : 'waiting') :
    errors.length < targets.length ? 'partial' : 'failed');
}

function persist(ctx, group, state, openings, alertMarket, signature, at, observedAt) {
  const { db, logger } = ctx;
  return db.transaction(() => {
    const previous = db.prepare('SELECT observed_at FROM public_pool_refresh WHERE wallet=? AND pool=?').get(group.wallet, group.pool);
    if ((previous?.observed_at ?? 0) > observedAt || Number(getMeta(db, 'public_snapshot_at') ?? 0) > observedAt) {
      throw new Error('A newer pool observation already exists');
    }
    const existing = db.prepare('SELECT is_blacklisted FROM wallets WHERE address=?').get(group.wallet);
    if (existing?.is_blacklisted) return;
    const positions = [...state.positions.values()].map(row => row.position);
    const amount = positions.reduce((sum, row) => sum + (row.deposit_usd ?? 0), 0);
    if (!existing && !(amount > WHALE_DEPOSIT_USD) && !openings.length) return;
    touchWallet(db, group.wallet, observedAt);
    db.prepare("UPDATE wallets SET validation='public_sample' WHERE address=? AND current_rank IS NULL").run(group.wallet);
    db.prepare(`INSERT INTO public_pool_refresh VALUES (?,?,?) ON CONFLICT(wallet,pool)
      DO UPDATE SET observed_at=excluded.observed_at`).run(group.wallet, group.pool, observedAt);
    const events = new Map(group.liquidity.map(event => [event.position, event]));
    for (const position of positions) {
      const event = events.get(position.position_pubkey);
      if (event?.kind === 'opened' && event.label) {
        position.strategy_label = event.label;
        position.strategy_source = 'instruction';
        position.confidence = 1;
        position.one_sided = Number(event.amounts.size === 1);
      }
      savePublicPosition(db, position);
    }
    for (const position of group.closures) {
      const prior = db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(position);
      if (prior?.status === 'open') savePublicPosition(db, { ...prior, status: 'closed', closed_at: at, last_checked_at: observedAt });
    }
    refreshProfile(db, group.wallet, observedAt);
    if (!(amount > WHALE_DEPOSIT_USD) && !openings.length) return;
    if (state.pool) snapshot(db, state.pool, observedAt);
    for (const { event, usd } of openings) {
      savePublicOpening(db, { ...serializePublicOpening(event, group.wallet, signature, at),
        depositUsd: amount, openingDepositUsd: usd, alertMarket });
    }
    setMeta(db, 'public_last_verified_at', observedAt);
    logger.info({ pool: group.pool, signature, amountUsd: amount, latencyMs: observedAt - at }, 'Public pool deposits verified');
  }).immediate();
}

async function processSignature(ctx, signature, pools) {
  const { db, providers } = ctx;
  const tx = await providers.transaction(signature);
  if (!tx?.blockTime || tx.transaction?.signatures?.[0] !== signature) throw new Error('Confirmed transaction not available');
  if (tx.meta?.err) return false;
  const at = tx.blockTime * 1000;
  const groups = new Map();
  const stored = db.prepare('SELECT wallet,pool FROM positions WHERE position_pubkey=?');
  const addGroup = (wallet, pool) => {
    const key = wallet + ':' + pool;
    if (!groups.has(key)) groups.set(key, { wallet, pool, liquidity: [], closures: [] });
    return groups.get(key);
  };
  for (const event of parsePositions(tx)) {
    if (!pools.has(event.pool) || !event.amounts.size) continue;
    const owner = event.owner || accountOwner((await providers.account(event.position))?.value);
    if (owner && isAddress(owner)) addGroup(owner, event.pool).liquidity.push(event);
  }
  for (const position of closurePositions(tx)) {
    const prior = stored.get(position);
    if (!prior || !pools.has(prior.pool)) continue;
    const account = await providers.account(position);
    if (account?.value === null) addGroup(prior.wallet, prior.pool).closures.push(position);
  }
  if (!groups.size) return false;
  setMeta(db, 'public_last_liquidity_at', Date.now());
  const rows = await parallel([...groups.values()], 2, async group => {
    const observedAt = Date.now();
    const state = await providers.openPoolPositions(group.wallet, group.pool, observedAt);
    if (group.liquidity.some(event => (state.positions.get(event.position)?.indexedAt ?? 0) < at) ||
      group.closures.some(position => state.positions.has(position))) {
      throw new Error('Meteora has not indexed this position update');
    }
    const openings = [];
    for (const event of group.liquidity.filter(event => event.kind === 'opened')) {
      const adds = await providers.positionAdds(event.position);
      const usd = openingDepositUsd(adds, signature, event.position, group.pool, group.wallet);
      if (usd == null) throw new Error('Meteora has not indexed the opening deposit amount');
      if (usd >= PUBLIC_OPENING_MIN_USD) openings.push({ event, usd });
    }
    const alertMarket = openings.length && state.pool ? await providers.openingMarkets([state.pool])
      .then(markets => markets.get(group.pool) ?? null).catch(error => {
        ctx.logger.warn({ pool: group.pool, reason: error.message }, 'Opening market cap unavailable');
        return classifyOpeningMarket(state.pool);
      }) : null;
    persist(ctx, group, state, openings, alertMarket, signature, at, observedAt);
  });
  if (rows.some(row => row.error)) throw rows.find(row => row.error).error;
  return true;
}

export async function processPublicInbox(ctx, pools = publicWatchPools(ctx.db)) {
  if (!pools.length || !getMeta(ctx.db, 'public_snapshot_at')) return;
  const observedPools = new Set(pools);
  const take = ctx.db.prepare('SELECT * FROM event_inbox WHERE done_at IS NULL AND available_at<=? ORDER BY available_at,received_at LIMIT 12');
  await parallel(take.all(Date.now()), 3, async row => {
    try {
      const matched = await processSignature(ctx, row.signature, observedPools);
      const now = Date.now();
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE event_inbox SET done_at=?,last_error=NULL WHERE signature=?').run(now, row.signature);
        setMeta(ctx.db, 'public_last_rpc_processed_at', now);
        if (matched) setMeta(ctx.db, 'public_last_matched_at', now);
      }).immediate();
    } catch (error) {
      const attempts = row.attempts + 1;
      const now = Date.now();
      ctx.db.prepare('UPDATE event_inbox SET attempts=?,available_at=?,last_error=?,done_at=? WHERE signature=?')
        .run(attempts, now + Math.min(30000, 2000 * 2 ** attempts), error.message, attempts >= 7 ? now : null, row.signature);
      if (attempts === 7) ctx.logger.warn({ signature: row.signature, reason: error.message }, 'Public event could not be resolved');
    }
  });
}
