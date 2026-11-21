import SQLite from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PUBLIC_OPENING_MIN_USD, WHALE_DEPOSIT_USD } from './config.js';

const migrations = [
  `CREATE TABLE wallets (
    address TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    alert_count INTEGER NOT NULL DEFAULT 0, current_rank INTEGER, best_rank INTEGER, score REAL,
    realized_pnl_sol REAL, roi REAL, win_rate REAL, n_closed INTEGER, avg_hold_min REAL, avg_position_sol REAL,
    tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', is_favorite INTEGER NOT NULL DEFAULT 0,
    is_blacklisted INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER, validation TEXT
  );
  CREATE TABLE positions (
    position_pubkey TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES wallets(address), pool TEXT NOT NULL,
    token_mint TEXT, pool_name TEXT, status TEXT NOT NULL CHECK(status IN ('open','closed')),
    opened_at INTEGER, closed_at INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, bin_step INTEGER,
    deposit_sol REAL, withdraw_sol REAL, fees_sol REAL, pnl_sol REAL, strategy_label TEXT,
    strategy_source TEXT, confidence REAL, one_sided INTEGER, width_pct REAL, in_range INTEGER,
    last_checked_at INTEGER NOT NULL, active_bin_id INTEGER, min_price REAL, max_price REAL,
    pnl_usd REAL, unclaimed_sol REAL, current_sol REAL,
    observed_ms INTEGER NOT NULL DEFAULT 0, in_range_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX positions_wallet ON positions(wallet,status);
  CREATE INDEX positions_pool ON positions(pool,status);
  CREATE TABLE position_bins (
    position_pubkey TEXT REFERENCES positions(position_pubkey), bin_id INTEGER,
    amount_x TEXT NOT NULL, amount_y TEXT NOT NULL, liquidity TEXT, snapshot_at INTEGER NOT NULL,
    PRIMARY KEY(position_pubkey, bin_id)
  );
  CREATE TABLE event_inbox (
    signature TEXT PRIMARY KEY, received_at INTEGER NOT NULL, done_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL, last_error TEXT
  );
  CREATE INDEX event_pending ON event_inbox(done_at,available_at);
  CREATE TABLE alert_batches (
    id INTEGER PRIMARY KEY, pool TEXT NOT NULL, closes_at INTEGER NOT NULL, sent_at INTEGER,
    delivery TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES alert_batches(id),
    signature TEXT NOT NULL, wallet TEXT NOT NULL REFERENCES wallets(address), pool TEXT NOT NULL,
    position_pubkey TEXT NOT NULL REFERENCES positions(position_pubkey), size_sol REAL NOT NULL, rank_at_alert INTEGER,
    received_at INTEGER NOT NULL, parsed_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, sent_at INTEGER,
    detail TEXT NOT NULL, UNIQUE(signature,position_pubkey)
  );
  CREATE INDEX alert_wallet ON alerts(wallet,id);
  CREATE TABLE wallet_strategy_profile (
    wallet TEXT PRIMARY KEY REFERENCES wallets(address), pct_spot REAL, pct_curve REAL, pct_bidask REAL, pct_mixed REAL,
    avg_width_pct REAL, pct_one_sided REAL, pct_time_in_range REAL, n_positions INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE pool_snapshots (
    id INTEGER PRIMARY KEY, pool TEXT NOT NULL, taken_at INTEGER NOT NULL, fdv_usd REAL, tvl_usd REAL,
    volume_24h REAL, fees_24h REAL, fee_tvl REAL, risk_flags TEXT, detail TEXT NOT NULL,
    alert_id INTEGER UNIQUE REFERENCES alerts(id)
  );
  CREATE INDEX snapshot_latest ON pool_snapshots(pool,taken_at DESC,id DESC);
  CREATE TABLE wallet_jobs (wallet TEXT PRIMARY KEY REFERENCES wallets(address), due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE positions ADD COLUMN deposit_usd REAL;
  CREATE VIEW whale_deposits AS
    SELECT p.wallet,p.pool,sum(p.deposit_usd) AS deposit_usd,count(*) AS active_positions
    FROM positions p JOIN wallets w ON w.address=p.wallet
    WHERE p.status='open' AND w.is_blacklisted=0
    GROUP BY p.wallet,p.pool HAVING sum(p.deposit_usd)>${WHALE_DEPOSIT_USD};`,
  `CREATE TABLE pool_rank_observations (
    pool TEXT NOT NULL, wallet TEXT NOT NULL REFERENCES wallets(address), observed_at INTEGER NOT NULL,
    provider TEXT NOT NULL, metric TEXT NOT NULL, rank INTEGER NOT NULL,
    PRIMARY KEY(pool,wallet,observed_at)
  );
  CREATE INDEX pool_rank_wallet ON pool_rank_observations(wallet,observed_at DESC);
  CREATE TABLE smart_lp_evaluations (
    wallet TEXT NOT NULL REFERENCES wallets(address), starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    cohort TEXT NOT NULL CHECK(cohort IN ('candidate','comparison')),
    status TEXT NOT NULL DEFAULT 'pending', checked_at INTEGER, evidence TEXT,
    PRIMARY KEY(wallet,starts_at)
  );
  CREATE INDEX smart_lp_due ON smart_lp_evaluations(status,ends_at,checked_at);`,
  `DROP VIEW whale_deposits;
  CREATE VIEW whale_deposits AS
    SELECT p.wallet,p.pool,sum(p.deposit_usd) AS deposit_usd,count(*) AS active_positions
    FROM positions p JOIN wallets w ON w.address=p.wallet
    LEFT JOIN metadata sample ON sample.key='public_snapshot_at'
    WHERE p.status='open' AND w.is_blacklisted=0
      AND (sample.value IS NULL OR p.last_checked_at=CAST(sample.value AS INTEGER))
    GROUP BY p.wallet,p.pool HAVING sum(p.deposit_usd)>${WHALE_DEPOSIT_USD};`,
  `CREATE TABLE public_pool_refresh (
    wallet TEXT NOT NULL REFERENCES wallets(address), pool TEXT NOT NULL, observed_at INTEGER NOT NULL,
    PRIMARY KEY(wallet,pool)
  );
  CREATE TABLE public_activity_events (
    signature TEXT NOT NULL, position TEXT NOT NULL, happened_at INTEGER NOT NULL, detail TEXT NOT NULL,
    PRIMARY KEY(signature,position)
  );
  CREATE INDEX public_activity_time ON public_activity_events(happened_at DESC);
  CREATE VIEW current_position_observations AS
    SELECT p.position_pubkey FROM positions p
    LEFT JOIN metadata sample ON sample.key='public_snapshot_at'
    LEFT JOIN public_pool_refresh live ON live.wallet=p.wallet AND live.pool=p.pool
    WHERE sample.value IS NULL OR p.last_checked_at=max(CAST(sample.value AS INTEGER),coalesce(live.observed_at,0));
  DROP VIEW whale_deposits;
  CREATE VIEW whale_deposits AS
    SELECT p.wallet,p.pool,sum(p.deposit_usd) AS deposit_usd,count(*) AS active_positions
    FROM positions p JOIN wallets w ON w.address=p.wallet
    JOIN current_position_observations c ON c.position_pubkey=p.position_pubkey
    WHERE p.status='open' AND w.is_blacklisted=0
    GROUP BY p.wallet,p.pool HAVING sum(p.deposit_usd)>${WHALE_DEPOSIT_USD};`,
  `CREATE TABLE public_telegram_delivery (
    signature TEXT NOT NULL, position TEXT NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(signature,position),
    FOREIGN KEY(signature,position) REFERENCES public_activity_events(signature,position)
  );`,
];

const positionFields = [
  'position_pubkey', 'wallet', 'pool', 'token_mint', 'pool_name', 'status', 'opened_at', 'closed_at',
  'lower_bin_id', 'upper_bin_id', 'bin_step', 'deposit_sol', 'withdraw_sol', 'fees_sol', 'pnl_sol',
  'strategy_label', 'strategy_source', 'confidence', 'one_sided', 'width_pct', 'in_range', 'last_checked_at',
  'active_bin_id', 'min_price', 'max_price', 'pnl_usd', 'unclaimed_sol', 'current_sol', 'deposit_usd',
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new SQLite(path);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    const current = db.pragma('user_version', { simple: true });
    if (current > migrations.length) throw new Error('Database schema is newer than this app');
    for (let i = current; i < migrations.length; i++) {
      db.exec(migrations[i]);
      db.pragma('user_version = ' + (i + 1));
    }
  }).immediate();
  return db;
}

export const getMeta = (db, key) => db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

export function touchWallet(db, address, now) {
  db.prepare(`INSERT INTO wallets(address,first_seen_at,last_seen_at) VALUES (?,?,?)
    ON CONFLICT(address) DO UPDATE SET last_seen_at=max(last_seen_at,excluded.last_seen_at)`).run(address, now, now);
}

export function leaderboard(db) {
  return db.prepare('SELECT * FROM wallets WHERE current_rank IS NOT NULL AND is_blacklisted=0 ORDER BY current_rank').all();
}

export function watchlist(db) {
  return db.prepare(`SELECT address FROM wallets WHERE is_blacklisted=0 AND
    (current_rank IS NOT NULL OR is_favorite=1) ORDER BY address`).all().map(row => row.address);
}

export function replaceLeaderboard(db, ranked, now) {
  db.transaction(() => {
    db.exec('UPDATE wallets SET current_rank=NULL');
    const update = db.prepare(`UPDATE wallets SET current_rank=@rank, best_rank=min(coalesce(best_rank,@rank),@rank),
      score=@score, realized_pnl_sol=@pnl, roi=@roi, win_rate=@winRate, n_closed=@count,
      avg_hold_min=@hold, avg_position_sol=@size, validation=@validation WHERE address=@address AND is_blacklisted=0`);
    for (const row of ranked) {
      touchWallet(db, row.address, now);
      update.run(row);
    }
    setMeta(db, 'leaderboard_at', now);
  }).immediate();
}

export function savePosition(db, row, bins) {
  const previous = db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(row.position_pubkey);
  // Never reopen an indexed closed position from a late event or an out-of-date provider response.
  if (previous?.status === 'closed' && row.status !== 'closed') return;
  const data = Object.fromEntries(positionFields.map(key => [key, row[key] ?? previous?.[key] ?? null]));
  if (previous?.strategy_source === 'instruction' && row.strategy_source !== 'instruction') {
    for (const key of ['strategy_label', 'strategy_source', 'confidence']) data[key] = previous[key];
  }
  if (row.status === 'closed') data.in_range = null;
  const interval = row.observeRange && row.in_range != null && previous?.status === 'open' && previous.in_range != null
    ? Math.min(30 * 60000, Math.max(0, row.last_checked_at - previous.last_checked_at)) : 0;
  data.observed_ms = (previous?.observed_ms ?? 0) + interval;
  data.in_range_ms = (previous?.in_range_ms ?? 0) + (previous?.in_range ? interval : 0);
  const fields = Object.keys(data);
  db.prepare(`INSERT INTO positions (${fields.join(',')}) VALUES (${fields.map(key => '@' + key).join(',')})
    ON CONFLICT(position_pubkey) DO UPDATE SET ${fields.slice(1).map(key => key + '=excluded.' + key).join(',')}`).run(data);
  if (bins?.length || (bins && row.status === 'open')) {
    db.prepare('DELETE FROM position_bins WHERE position_pubkey=?').run(data.position_pubkey);
    const insert = db.prepare('INSERT INTO position_bins VALUES (?,?,?,?,?,?)');
    for (const bin of bins) insert.run(data.position_pubkey, bin.id, String(bin.x), String(bin.y),
      bin.liquidity == null ? null : String(bin.liquidity), data.last_checked_at);
  }
}

export function savePublicPosition(db, row) {
  const prior = db.prepare('SELECT last_checked_at FROM positions WHERE position_pubkey=?').get(row.position_pubkey);
  if (!prior || row.last_checked_at >= prior.last_checked_at) savePosition(db, row);
}

export function savePublicOpening(db, event) {
  db.prepare(`INSERT INTO public_activity_events(signature,position,happened_at,detail) VALUES (?,?,?,?)
    ON CONFLICT(signature,position) DO UPDATE SET detail=excluded.detail
    WHERE json_extract(public_activity_events.detail,'$.openingDepositUsd') IS NULL`)
    .run(event.signature, event.position, event.timestamp, JSON.stringify(event));
}

export function publicActivity(db) {
  return db.prepare(`SELECT e.detail FROM public_activity_events e
    JOIN wallets w ON w.address=json_extract(e.detail,'$.wallet') AND w.is_blacklisted=0
    WHERE json_extract(e.detail,'$.openingDepositUsd')>=?
    ORDER BY e.happened_at DESC LIMIT 200`).all(PUBLIC_OPENING_MIN_USD)
    .map(row => JSON.parse(row.detail));
}

export function publicOpening(db, wallet, signature, position) {
  const detail = db.prepare(`SELECT e.detail FROM public_activity_events e
    JOIN wallets w ON w.address=json_extract(e.detail,'$.wallet') AND w.is_blacklisted=0
    WHERE e.signature=? AND e.position=? AND w.address=? AND json_extract(e.detail,'$.openingDepositUsd')>=?`)
    .pluck().get(signature, position, wallet, PUBLIC_OPENING_MIN_USD);
  return detail ? JSON.parse(detail) : null;
}

export function scheduleWallet(db, address, dueAt) {
  db.prepare(`INSERT INTO wallet_jobs(wallet,due_at) VALUES (?,?)
    ON CONFLICT(wallet) DO UPDATE SET due_at=min(due_at,excluded.due_at)`).run(address, dueAt);
}

export function refreshProfile(db, wallet, now) {
  db.prepare(`INSERT INTO wallet_strategy_profile SELECT wallet,
    100.0*avg(CASE WHEN strategy_label IS NOT NULL THEN strategy_label='SPOT' END),
    100.0*avg(CASE WHEN strategy_label IS NOT NULL THEN strategy_label='CURVE' END),
    100.0*avg(CASE WHEN strategy_label IS NOT NULL THEN strategy_label='BIDASK' END),
    100.0*avg(CASE WHEN strategy_label IS NOT NULL THEN strategy_label='MIXED' END),
    avg(width_pct), 100.0*avg(one_sided), 100.0*sum(in_range_ms)/nullif(sum(observed_ms),0), count(*), ?
    FROM positions WHERE wallet=? GROUP BY wallet
    ON CONFLICT(wallet) DO UPDATE SET pct_spot=excluded.pct_spot,pct_curve=excluded.pct_curve,
      pct_bidask=excluded.pct_bidask,pct_mixed=excluded.pct_mixed,avg_width_pct=excluded.avg_width_pct,
      pct_one_sided=excluded.pct_one_sided,pct_time_in_range=excluded.pct_time_in_range,
      n_positions=excluded.n_positions,updated_at=excluded.updated_at`).run(now, wallet);
}

export function snapshot(db, pool, now, alertId = null) {
  db.prepare(`INSERT INTO pool_snapshots(pool,taken_at,fdv_usd,tvl_usd,volume_24h,fees_24h,fee_tvl,risk_flags,detail,alert_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pool.address, now, pool.fdv ?? null, pool.tvl ?? null, pool.volume24 ?? null,
    pool.fees24 ?? null, pool.feeTvl ?? null, JSON.stringify(pool.risks ?? []), JSON.stringify(pool), alertId);
}

export function latestPools(db) {
  return db.prepare(`SELECT s.detail FROM pool_snapshots s JOIN
    (SELECT pool,max(id) AS id FROM pool_snapshots GROUP BY pool) latest ON latest.id=s.id`).all().map(row => JSON.parse(row.detail));
}
