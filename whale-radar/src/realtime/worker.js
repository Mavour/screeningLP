import { SOL, WHALE_DEPOSIT_USD, finite } from '../config.js';
import { parallel } from '../clients/http.js';
import { isSignature, parsePositions, PROGRAM } from '../strategy/instructions.js';
import { distribution, priceRange } from '../strategy/distribution.js';
import { savePosition, scheduleWallet, snapshot, watchlist } from '../db.js';
import { telegramMessages } from '../notify/telegram.js';
import { smartLpStatus } from '../discovery/smart-lp.js';

export function enqueue(db, signatures, now = Date.now()) {
  const insert = db.prepare('INSERT OR IGNORE INTO event_inbox(signature,received_at,available_at) VALUES (?,?,?)');
  return db.transaction(() => signatures.reduce((n, signature) =>
    n + (isSignature(signature) ? insert.run(signature, now, now).changes : 0), 0)).immediate();
}

export function webhookSignatures(body) {
  if (!Array.isArray(body) || body.length > 1000 || body.some(event => !event || !isSignature(event.signature))) return null;
  return body.filter(event => {
    if (event.transactionError) return false;
    if (!Array.isArray(event.instructions) || !event.instructions.length) return true;
    // Without a complete program list, defer filtering to the canonical RPC transaction.
    const stack = [...event.instructions];
    for (const ix of stack) {
      if (typeof ix?.programId !== 'string' || ix.programId === PROGRAM) return true;
      if (!Array.isArray(ix.innerInstructions)) return true;
      for (const nested of ix.innerInstructions) stack.push(nested);
    }
    return false;
  }).map(event => event.signature);
}

function timebox(promise, ms) {
  let timer;
  return Promise.race([promise.catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })])
    .finally(() => clearTimeout(timer));
}

async function enrich(event, ctx) {
  const { providers, tools } = ctx;
  const owner = event.owner || await tools.owner(event.position);
  if (!owner) return null;
  const wallet = ctx.db.prepare(`SELECT * FROM wallets WHERE address=? AND is_blacklisted=0
    AND (current_rank IS NOT NULL OR is_favorite=1)`).get(owner);
  if (!wallet || !event.amounts.size) return null;
  const mints = [...event.amounts.keys()];
  const [pool, quoted, qualification] = await Promise.all([
    timebox(providers.pool(event.pool), 2000),
    mints.some(mint => mint !== SOL) ? timebox(providers.prices([...mints, SOL]), 3000) : null,
    timebox(providers.activeDepositUsd(owner, event.pool, event.position, event.at), 3000),
  ]);
  const solPrice = finite(quoted?.[SOL]?.usdPrice);
  let size = 0;
  let fullyPriced = true;
  for (const [mint, amount] of event.amounts) {
    const decimal = event.decimals.get(mint) ?? (mint === SOL ? 9 :
      mint === pool?.tokenX ? pool?.decimalsX : mint === pool?.tokenY ? pool?.decimalsY : null);
    const price = mint === SOL ? 1 : solPrice > 0 ? finite(quoted?.[mint]?.usdPrice) / solPrice : null;
    if (!Number.isInteger(decimal) || !(price > 0)) {
      fullyPriced = false;
      continue;
    }
    size += Number(amount) / 10 ** decimal * price;
  }
  if (!Number.isFinite(size)) return null;
  if (size < ctx.settings.alertSol) {
    if (!fullyPriced) throw new Error('Deposit valuation incomplete');
    return null;
  }
  if (qualification == null) throw new Error('Whale deposit verification unavailable');
  const indexedDepositUsd = qualification.usd;
  if (indexedDepositUsd <= WHALE_DEPOSIT_USD) {
    // Newly indexed positions can lag the confirmed transaction.
    if (!qualification.indexed) throw new Error('Waiting for the active deposit to be indexed');
    return null;
  }
  const [info, liveBins] = await Promise.all([
    pool && timebox(providers.poolDetails(pool), 2000),
    !event.label && timebox(tools.bins(owner), 2000),
  ]);
  const saved = !event.label && !liveBins?.has(event.position) ? ctx.db.prepare(
    'SELECT bin_id AS id,amount_x AS x,amount_y AS y,liquidity FROM position_bins WHERE position_pubkey=?'
  ).all(event.position) : [];
  const state = liveBins?.get?.(event.position);
  const strategy = event.label ? { label: event.label, source: 'instruction', confidence: 1 } :
    distribution(state?.bins ?? saved, ctx.settings.strategy);
  const range = priceRange(event.lower ?? state?.lower, event.upper ?? state?.upper,
    pool?.binStep ?? state?.step, pool?.decimalsX ?? state?.dx, pool?.decimalsY ?? state?.dy);
  const tokenMint = pool?.tokenMint ?? mints.find(mint => mint !== SOL) ?? null;
  const cached = !info && ctx.db.prepare('SELECT detail FROM pool_snapshots WHERE pool=? ORDER BY id DESC LIMIT 1').get(event.pool);
  const poolInfo = info ?? (cached && JSON.parse(cached.detail)) ?? pool ?? { address: event.pool };
  return { owner, wallet, size, fullyPriced, pool: poolInfo, tokenMint, range, strategy, state, indexedDepositUsd };
}

function saveAlert(ctx, event, enriched, inbox, parsedAt, now) {
  const { db, settings } = ctx;
  const { owner, wallet, pool, size, fullyPriced, tokenMint, range, strategy, state, indexedDepositUsd } = enriched;
  const existing = db.prepare('SELECT 1 FROM alerts WHERE signature=? AND position_pubkey=?').get(inbox.signature, event.position);
  if (existing) return;
  const pending = db.prepare(`SELECT id FROM alert_batches WHERE pool=? AND sent_at IS NULL AND closes_at>?
    ORDER BY id DESC LIMIT 1`).get(event.pool, now);
  const batchId = pending?.id ?? db.prepare('INSERT INTO alert_batches(pool,closes_at) VALUES (?,?)')
    .run(event.pool, now + settings.batchMs).lastInsertRowid;
  savePosition(db, { position_pubkey: event.position, wallet: owner, pool: event.pool, pool_name: pool.name,
    token_mint: tokenMint, status: 'open', opened_at: event.kind === 'opened' ? event.at : null,
    lower_bin_id: event.kind === 'opened' ? event.lower : state?.lower,
    upper_bin_id: event.kind === 'opened' ? event.upper : state?.upper, bin_step: pool.binStep ?? state?.step,
    strategy_label: event.kind === 'opened' ? strategy.label : null,
    strategy_source: event.kind === 'opened' ? strategy.source : null,
    confidence: event.kind === 'opened' ? strategy.confidence : null,
    one_sided: event.kind === 'opened' ? Number(event.amounts.size === 1) : null,
    last_checked_at: now, ...(event.kind === 'opened' && range) }, state?.bins);
  const detail = { kind: event.kind, name: pool.name, label: strategy.label, strategySource: strategy.source,
    tokenMint, fullyPriced, walletDepositUsd: indexedDepositUsd, smartLp: smartLpStatus(db, owner, now).status === 'verified',
    oneSided: event.amounts.size === 1, pairX: pool.tokenX, pairY: pool.tokenY, ...range, poolInfo: pool };
  const id = db.prepare(`INSERT INTO alerts(batch_id,signature,wallet,pool,position_pubkey,size_sol,rank_at_alert,received_at,
    parsed_at,ready_at,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(batchId, inbox.signature, owner, event.pool,
    event.position, size, wallet.current_rank, inbox.received_at, parsedAt, now, JSON.stringify(detail)).lastInsertRowid;
  snapshot(db, pool, now, id);
  db.prepare('UPDATE wallets SET last_seen_at=max(last_seen_at,?) WHERE address=?').run(now, owner);
  scheduleWallet(db, owner, now);
}

export async function processInbox(ctx, { signature, now = Date.now } = {}) {
  const { db, providers, logger } = ctx;
  const rows = signature
    ? db.prepare('SELECT * FROM event_inbox WHERE signature=? AND done_at IS NULL AND available_at<=?').all(signature, now())
    : db.prepare('SELECT * FROM event_inbox WHERE done_at IS NULL AND available_at<=? ORDER BY received_at LIMIT 24').all(now());
  const watch = watchlist(db);
  await parallel(rows, ctx.settings.concurrency, async inbox => {
    try {
      const tx = await providers.transaction(inbox.signature);
      if (!tx) throw new Error('Transaction not available');
      if (tx.transaction?.signatures?.[0] !== inbox.signature) throw new Error('RPC returned a different transaction signature');
      const events = watch.length ? parsePositions(tx).filter(event => !event.owner || watch.includes(event.owner)) : [];
      for (const event of events) event.at = tx.blockTime ? tx.blockTime * 1000 : null;
      const parsedAt = now();
      const measures = await parallel(events, ctx.settings.concurrency, event => enrich(event, ctx));
      const failure = measures.find(item => item.error);
      const ready = now();
      db.transaction(() => {
        measures.forEach((item, i) => {
          if (!item.value) return;
          const event = events[i];
          saveAlert(ctx, event, item.value, inbox, parsedAt, ready);
        });
        if (!failure) db.prepare('UPDATE event_inbox SET done_at=? WHERE signature=?').run(ready, inbox.signature);
      }).immediate();
      if (measures.some(item => item.value)) logger.info({ signature: inbox.signature,
        parseMs: parsedAt - inbox.received_at, enrichMs: ready - parsedAt }, 'Alert ready for batch');
      if (failure) throw failure.error;
    } catch (error) {
      const attempts = inbox.attempts + 1;
      db.prepare('UPDATE event_inbox SET attempts=?, available_at=?, last_error=?, done_at=? WHERE signature=?')
        .run(attempts, now() + Math.min(300000, 2000 * 2 ** attempts), error.name, attempts >= 8 ? now() : null, inbox.signature);
      logger.warn({ signature: inbox.signature, attempts, reason: error.message }, 'Event processing failed');
    }
  });
}

export async function flushBatches(ctx, now = Date.now(), force = false, signature = null) {
  const { db, providers, logger, dryRun, settings } = ctx;
  const batches = db.prepare(`SELECT * FROM alert_batches b WHERE sent_at IS NULL AND
    retry_at<=? AND (? OR closes_at<=?) AND (? IS NULL OR EXISTS
      (SELECT 1 FROM alerts a WHERE a.batch_id=b.id AND a.signature=?))
    ORDER BY closes_at,id LIMIT 100`).all(now, Number(force), now, signature, signature);
  for (const batch of batches) {
    const alerts = db.prepare(`SELECT a.*,w.current_rank FROM alerts a JOIN wallets w ON a.wallet=w.address
      WHERE a.batch_id=? AND a.sent_at IS NULL AND w.is_blacklisted=0
        AND json_extract(a.detail,'$.walletDepositUsd')>? AND (? IS NULL OR a.signature=?)
      ORDER BY a.id`).all(batch.id, WHALE_DEPOSIT_USD, signature, signature);
    const messages = telegramMessages(alerts, settings.publicUrl);
    try {
      for (const { message, rows } of messages) {
        const started = Date.now();
        if (dryRun) ctx.print(message.text);
        else await providers.sendTelegram(message);
        const sent = Date.now();
        db.transaction(() => {
          const mark = db.prepare('UPDATE alerts SET sent_at=? WHERE id=? AND sent_at IS NULL');
          const count = db.prepare('UPDATE wallets SET alert_count=alert_count+1 WHERE address=?');
          for (const row of rows) {
            if (mark.run(sent, row.id).changes) count.run(row.wallet);
            logger.info({ alertId: row.id, telegramMs: sent - started,
              excludingBatchMs: row.ready_at - row.received_at + sent - started }, 'Alert delivery recorded');
          }
        }).immediate();
      }
      if (signature && db.prepare('SELECT 1 FROM alerts WHERE batch_id=? AND sent_at IS NULL AND signature<>?').get(batch.id, signature)) continue;
      db.prepare('UPDATE alert_batches SET sent_at=?,delivery=? WHERE id=?')
        .run(Date.now(), alerts.length ? dryRun ? 'dry-run' : 'telegram' : (batch.attempts ? 'complete' : 'suppressed'), batch.id);
    } catch (error) {
      db.prepare('UPDATE alert_batches SET attempts=attempts+1,retry_at=? WHERE id=?')
        .run(now + Math.min(300000, 2000 * 2 ** Math.min(batch.attempts, 8)), batch.id);
      logger.warn({ batchId: batch.id, reason: error.message }, 'Alert delivery deferred');
    }
  }
}
