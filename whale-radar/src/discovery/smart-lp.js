import { DAY, SOL, finite } from '../config.js';
import { parallel } from '../clients/http.js';

const FIVE_MINUTES = 300000;

export function holdBenchmark(events, position, wallet, closePrice) {
  if (!(closePrice > 0) || !events.length) return null;
  const { tokenX, tokenY } = events[0];
  if (!tokenX || !tokenY || (tokenX === SOL) === (tokenY === SOL)) return null;
  const inputs = [0, 0];
  const withdrawals = [0, 0];
  const fees = [0, 0];
  const signatures = new Set();
  const unique = new Set();
  let adds = 0;
  let removes = 0;
  for (const event of events) {
    if (event.positionAddress !== position.positionAddress || event.poolAddress !== position.pool ||
      event.userAddress !== wallet || event.tokenX !== tokenX || event.tokenY !== tokenY || !event.signature ||
      !['add', 'remove', 'claim_fee', 'claim_reward'].includes(event.eventType)) return null;
    const key = event.signature + ':' + event.ixIndex + ':' + event.eventType;
    if (unique.has(key)) continue;
    unique.add(key);
    signatures.add(event.signature);
    // Rewards are kept out of the benchmark so incentives cannot create an LP edge.
    if (event.eventType === 'claim_reward') continue;
    const amounts = [finite(event.amountX), finite(event.amountY)];
    if (amounts.some(amount => amount == null || amount < 0)) return null;
    const destination = event.eventType === 'add' ? inputs : event.eventType === 'remove' ? withdrawals : fees;
    if (event.eventType === 'add') adds++;
    if (event.eventType === 'remove') removes++;
    destination[0] += amounts[0];
    destination[1] += amounts[1];
  }
  // Reconcile indexed transfers against the independently aggregated position totals.
  const reconcile = (observed, reported) => ['tokenX', 'tokenY'].every((name, i) => {
    const qty = finite(reported?.[name]?.amount);
    return qty != null && Math.abs(observed[i] - qty) <= Math.max(1e-10, Math.abs(qty) * 0.00001);
  });
  if (!adds || !removes || !reconcile(inputs, position.allTimeDeposits) ||
      !reconcile(withdrawals, position.allTimeWithdrawals) || !reconcile(fees, position.allTimeFees)) return null;
  const value = ([x, y]) => tokenY === SOL ? x * closePrice + y : x + y / closePrice;
  const excess = value(withdrawals) + value(fees) - value(inputs);
  return Number.isFinite(excess) ? { excess, signatures: [...signatures] } : null;
}

async function auditPosition(providers, wallet, row, indexed, tokens) {
  if (!indexed || (tokens.tokenX === SOL) === (tokens.tokenY === SOL)) return null;
  const bucket = Math.floor(row.closed_at / FIVE_MINUTES) * FIVE_MINUTES;
  const [events, candles] = await Promise.all([
    providers.positionEvents(row.position_pubkey),
    providers.candles(row.pool, '5m', bucket - 6 * FIVE_MINUTES, bucket - 1000),
  ]);
  if (events.some(event => event.tokenX !== tokens.tokenX || event.tokenY !== tokens.tokenY)) return null;
  const price = candles.filter(candle => candle.at + FIVE_MINUTES <= row.closed_at).at(-1)?.close;
  const measured = holdBenchmark(events, { ...indexed, pool: row.pool }, wallet, price);
  if (!measured) return null;
  const fees = new Map();
  for (const signature of measured.signatures) {
    const tx = await providers.transaction(signature, false);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    const payerAddress = typeof payer === 'string' ? payer : payer?.pubkey;
    if (!payerAddress || tx?.meta?.err || !Number.isFinite(tx?.meta?.fee) ||
      tx.transaction.signatures?.[0] !== signature) return null;
    fees.set(signature, payerAddress === wallet ? tx.meta.fee / 1e9 : 0);
  }
  return { at: row.closed_at, excess: measured.excess, fees };
}

export function evaluateEvidence(positions, open, start, options) {
  const openLoss = open.reduce((n, row) => n + Math.min(0, row.pnl_sol), 0);
  const sharedFees = new Map();
  for (const row of positions) for (const signature of row.fees.keys()) {
    sharedFees.set(signature, (sharedFees.get(signature) ?? 0) + 1);
  }
  const weeks = new Map();
  let netExcess = openLoss;
  let gas = 0;
  const winningExcess = [];
  for (const row of positions) {
    const cost = [...row.fees].reduce((sum, [signature, fee]) => sum + fee / sharedFees.get(signature), 0);
    gas += cost;
    const gain = row.excess - cost;
    netExcess += gain;
    if (gain > 0) winningExcess.push(gain);
    const week = Math.floor((row.at - start) / (7 * DAY));
    weeks.set(week, (weeks.get(week) ?? 0) + gain);
  }
  const positiveWeeks = [...weeks.values()].filter(value => value > 0).length;
  const largestShare = winningExcess.length ? Math.max(...winningExcess) / winningExcess.reduce((a, b) => a + b, 0) : 1;
  return { passed: netExcess > 0 && options.closedPnl - gas + openLoss > 0 && positiveWeeks >= 3 &&
      largestShare <= options.concentration, netExcess, openLoss, positiveWeeks, gas, largestShare };
}

export async function evaluateCohort(ctx, summarize, verification, now = Date.now()) {
  const { db, settings, providers, logger } = ctx;
  db.prepare(`UPDATE smart_lp_evaluations SET status='inconclusive'
    WHERE status='insufficient' AND ends_at<?`).run(now - 7 * DAY);
  const due = db.prepare(`SELECT e.* FROM smart_lp_evaluations e JOIN wallets w ON w.address=e.wallet
    WHERE w.is_blacklisted=0 AND e.ends_at<=? AND e.status IN ('pending','insufficient')
      AND (e.checked_at IS NULL OR e.checked_at<=?)
    ORDER BY e.checked_at IS NOT NULL,e.checked_at,e.ends_at LIMIT ?`).all(now, now - DAY, settings.concurrency);
  await parallel(due, Math.min(settings.concurrency, 2), async cohort => {
    const record = (status, evidence) => db.prepare(`UPDATE smart_lp_evaluations SET status=?,checked_at=?,evidence=?
      WHERE wallet=? AND starts_at=?`).run(status, now, JSON.stringify(evidence), cohort.wallet, cohort.starts_at);
    try {
      const [closed, open] = await Promise.all([
        providers.closedPositions(cohort.wallet, cohort.starts_at), providers.openPositions(cohort.wallet),
      ]);
      const rules = { ...settings, windowDays: (cohort.ends_at - cohort.starts_at) / DAY };
      const inWindow = closed.filter(row => row.closed_at > cohort.starts_at && row.closed_at <= cohort.ends_at);
      const openExposure = [...open.filter(row => row.opened_at == null || row.opened_at <= cohort.ends_at),
        ...closed.filter(row => row.closed_at > cohort.ends_at && (row.opened_at == null || row.opened_at <= cohort.ends_at))];
      if (inWindow.length < settings.minClosed) {
        record('insufficient', { reason: 'too_few_closed_positions', observed: inWindow.length });
        return;
      }
      if (inWindow.some(row => !Number.isFinite(row.pnl_sol) || !(row.deposit_sol > 0) ||
          row.opened_at == null || row.opened_at > row.closed_at) ||
          openExposure.some(row => row.opened_at == null || !Number.isFinite(row.pnl_sol))) {
        record('insufficient', { reason: 'unpriced_or_incomplete_positions', observed: inWindow.length });
        return;
      }
      const stats = summarize(cohort.wallet, inWindow, rules, cohort.ends_at);
      if (!stats) {
        record('not_qualified', { reason: 'holdout_pnl_or_activity_filter', observed: inWindow.length });
        return;
      }
      let auditedInputs = stats.positions.map(row => [row.indexed, row.tokens]);
      if (!ctx.publicMeteora) {
        const expected = new Set(stats.positions.map(row => row.position_pubkey));
        if (!await providers.verifyClosedUniverse(cohort.wallet, cohort.starts_at, cohort.ends_at, expected)) {
          record('insufficient', { reason: 'unreconciled_closed_position_universe', observed: stats.count });
          return;
        }
        const matches = await providers.crossCheck(cohort.wallet, stats.positions);
        const crossCheck = verification(matches, stats.count, settings.pnlTolerance);
        if (crossCheck !== 'matched' || matches.length !== stats.count) {
          record(crossCheck === 'disagreement' ? 'not_qualified' : 'insufficient',
            { reason: crossCheck === 'disagreement' ? 'provider_disagreement' : 'incomplete_cross_check',
              observed: stats.count, matched: matches.length });
          return;
        }
        auditedInputs = matches.map(match => [match[2], match[3]]);
      }
      const indexed = new Map(auditedInputs.filter(([position, tokens]) => position && tokens)
        .map(([position, tokens]) => [position.positionAddress, { position, tokens }]));
      const audits = await parallel(stats.positions, 2, async row => {
        const match = indexed.get(row.position_pubkey);
        return match ? auditPosition(providers, cohort.wallet, row, match.position, match.tokens) : null;
      });
      const measured = audits.map(row => row.value).filter(Boolean);
      if (measured.length !== stats.count) {
        record('insufficient', { reason: 'incomplete_hold_benchmark', observed: stats.count,
          matched: indexed.size, benchmarked: measured.length });
        return;
      }
      const result = evaluateEvidence(measured, openExposure, cohort.starts_at,
        { closedPnl: stats.pnl, concentration: settings.concentration });
      record(result.passed ? 'verified' : 'not_qualified', {
        ...result, observed: stats.count, matched: indexed.size, benchmarked: measured.length,
        closedPnl: stats.pnl, openMarkedAt: now,
        source: ctx.publicMeteora ? 'Meteora + Solana RPC' : 'LP Agent + Meteora + Solana RPC',
      });
    } catch (error) {
      record('insufficient', { reason: 'provider_unavailable' });
      logger.warn({ wallet: cohort.wallet, reason: error.message }, 'Smart LP evaluation deferred');
    }
  });
}

export function smartLpStatus(db, wallet, now = Date.now()) {
  const newest = db.prepare(`SELECT * FROM smart_lp_evaluations WHERE wallet=? ORDER BY starts_at DESC LIMIT 1`).get(wallet);
  if (!newest) return { status: 'candidate' };
  if (newest.cohort === 'comparison') return { ...newest, status: 'comparison' };
  const verified = db.prepare(`SELECT * FROM smart_lp_evaluations WHERE wallet=? AND cohort='candidate' AND status='verified'
    AND ends_at + (ends_at-starts_at)>? ORDER BY ends_at DESC LIMIT 1`).get(wallet, now);
  if (verified && (newest.status === 'pending' || newest.ends_at <= verified.ends_at)) return { ...verified, status: 'verified' };
  if (newest.status === 'verified' && newest.cohort === 'candidate') return { ...newest, status: 'stale' };
  return newest;
}
