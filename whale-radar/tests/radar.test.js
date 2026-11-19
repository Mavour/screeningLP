import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { WebSocketServer } from 'ws';
import { config, DAY, SOL } from '../src/config.js';
import { openDb, getMeta, leaderboard, publicActivity, savePosition, savePublicPosition, setMeta, snapshot } from '../src/db.js';
import { discover, scoreWallets, summarize, verification } from '../src/discovery/leaderboard.js';
import { discoverPublicSmartLp } from '../src/discovery/public-leaderboard.js';
import { evaluateCohort, evaluateEvidence, holdBenchmark, smartLpStatus } from '../src/discovery/smart-lp.js';
import { distribution, binPrice, mergeLabels } from '../src/strategy/distribution.js';
import { DLMM, PROGRAM, openingRebalance, parsePositions } from '../src/strategy/instructions.js';
import { positionTools } from '../src/strategy/positions.js';
import { mockProviders, mockSignature, mockTransaction, mockWallet, mockPool, mockPosition } from '../src/clients/mock.js';
import { enqueue, flushBatches, processInbox, webhookSignatures } from '../src/realtime/worker.js';
import { watchActivity } from '../src/realtime/watch.js';
import { pollPublicPools, processPublicInbox, publicLiquidityLogs } from '../src/realtime/public-worker.js';
import { createWeb, createWebhook } from '../src/web/server.js';
import { refreshWallet } from '../src/jobs/wallets.js';
import { publicHealth } from '../src/radar-report.js';
import { refreshIntel, trending, trendingScore, whalePools } from '../src/intel/pools.js';
import { http, ProviderError } from '../src/clients/http.js';
import { publicTelegramMessage } from '../src/notify/public-telegram.js';

const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture(path = ':memory:', options = {}) {
  const now = Date.now();
  const settings = { ...config({ MOCK: '1' }), ...options };
  const db = openDb(path);
  cleanups.push(() => { if (db.open) db.close(); });
  const providers = mockProviders(now);
  return { db, settings, providers, tools: positionTools(providers, settings), dryRun: true, print: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, now };
}

describe('discovery', () => {
  it('ranks eligible wallets, rejects concentrated/bot histories and retains the last leaderboard during provider failure', async () => {
    const ctx = fixture();
    await discover(ctx, ctx.now);
    expect(leaderboard(ctx.db).map(row => [row.address === mockWallet, row.current_rank, row.n_closed, row.validation]))
      .toEqual([[true, 1, 24, 'matched'], [false, 2, 23, 'matched']]);
    const eligible = await ctx.providers.closedPositions(mockWallet);
    const concentrated = eligible.map((p, i) => ({ ...p, pnl_sol: i === 0 ? 100 : 1 }));
    expect(summarize(mockWallet, concentrated, ctx.settings, ctx.now)).toBeNull();
    const bursts = eligible.map((p, i) => ({ ...p, opened_at: ctx.now - i * 60000 - 60000, closed_at: ctx.now - i * 60000 }));
    expect(summarize(mockWallet, bursts, { ...ctx.settings, botDaily: 12 }, ctx.now)).toBeNull();
    expect(verification([[1, 3]], 1, 0.25)).toBe('disagreement');
    expect(verification([[10, 20], [10, 0]], 2, 0.25)).toBe('disagreement');
    expect(verification([[1, 1]], 2, 0.25)).toBe('insufficient');
    const tied = scoreWallets([{ address: 'a', pnl: 1, roi: 1, winRate: 1 }, { address: 'b', pnl: 1, roi: 1, winRate: 1 }]);
    expect(tied.map(r => r.score)).toEqual([50, 50]);
    ctx.providers.topLpers = async () => { throw new ProviderError('lpagent', 401); };
    await expect(discover(ctx, ctx.now + DAY)).rejects.toThrow('previous leaderboard retained');
    expect(leaderboard(ctx.db)).toHaveLength(2);
  });
});

describe('Smart LP verification', () => {
  const token = 'another-token';
  const totals = (x, y) => ({ tokenX: { amount: x }, tokenY: { amount: y } });
  const positionData = (id, pool) => ({ positionAddress: id, pool,
    allTimeDeposits: totals(10, 0), allTimeWithdrawals: totals(8, 4), allTimeFees: totals(1, 0) });
  const eventsFor = (id, pool) => [['add',10,0],['remove',8,4],['claim_fee',1,0]].map(([eventType, x, y], ixIndex) =>
    ({ positionAddress:id, poolAddress:pool, userAddress:mockWallet, tokenX:SOL, tokenY:token,
      signature:id + ':' + ixIndex, ixIndex, eventType, amountX:String(x), amountY:String(y) }));

  it('matches retained asset flows, catches missing transfers, and subtracts fees and losing open positions', () => {
    const events = eventsFor('position','pool');
    expect(holdBenchmark(events, positionData('position','pool'), mockWallet, 2).excess).toBe(1);
    expect(holdBenchmark(events.slice(0,2), positionData('position','pool'), mockWallet, 2)).toBeNull();
    const start = Date.now() - 30 * DAY;
    const rows = [1, 8, 15].map(day => ({ at: start + day * DAY, excess: 1, fees: new Map([['same-signature', 0.03]]) }));
    const positive = evaluateEvidence(rows, [], start, { closedPnl: 3, concentration: 0.6 });
    expect(positive).toMatchObject({ passed: true, positiveWeeks: 3 });
    expect(positive.gas).toBeCloseTo(0.03);
    expect(evaluateEvidence(rows, [{ pnl_sol: -3 }], start, { closedPnl: 3, concentration: 0.6 }).passed).toBe(false);
  });

  it('freezes cohorts, leaves early candidates unverified and promotes only on complete forward evidence', async () => {
    const ctx = fixture(':memory:', { minClosed: 3 });
    const start = ctx.now;
    await discover(ctx, start);
    await discover(ctx, start + DAY);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM smart_lp_evaluations').get().n).toBe(2);
    expect(ctx.db.prepare('SELECT rank,provider FROM pool_rank_observations WHERE wallet=? ORDER BY observed_at DESC LIMIT 1')
      .get(mockWallet)).toEqual({ rank: 1, provider: 'LP Agent' });
    ctx.providers.closedPositions = async wallet => wallet === mockWallet ? [1, 8, 15].map((day, index) => ({
      position_pubkey: 'holdout-' + index, pool: mockPool, status: 'closed', closed_at: start + day * DAY,
      opened_at: start + day * DAY - 3600000, pnl_sol: 1, deposit_sol: 10,
    })) : [];
    ctx.providers.openPositions = async () => [];
    ctx.providers.crossCheck = async (_wallet, positions) => positions.map(row => [
      row.pnl_sol, row.pnl_sol, positionData(row.position_pubkey, row.pool), { tokenX: SOL, tokenY: token },
    ]);
    ctx.providers.positionEvents = async id => eventsFor(id, mockPool);
    ctx.providers.candles = async (_pool, _frame, from) => [{ at: from, close: 2 }];
    ctx.providers.transaction = async signature => ({ meta: { err: null, fee: 5000 },
      transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: mockWallet }] } } });
    await evaluateCohort(ctx, summarize, verification, start + 29 * DAY);
    expect(smartLpStatus(ctx.db, mockWallet, start + 29 * DAY).status).toBe('pending');
    await evaluateCohort(ctx, summarize, verification, start + 30 * DAY);
    expect(smartLpStatus(ctx.db, mockWallet, start + 30 * DAY).status).toBe('insufficient');
    ctx.providers.verifyClosedUniverse = async () => true;
    await evaluateCohort(ctx, summarize, verification, start + 31 * DAY);
    expect(smartLpStatus(ctx.db, mockWallet, start + 31 * DAY).status).toBe('verified');
    expect(smartLpStatus(ctx.db, mockWallet, start + 60 * DAY).status).toBe('stale');
  });

  it('preserves comparison membership and keeps passed controls out of the Smart LP label', async () => {
    const ctx = fixture();
    const result = await ctx.providers.topLpers(mockPool);
    ctx.providers.topLpers = async () => ({ ranks: result.ranks.slice(0,2), comparison: result.ranks.slice(2) });
    await discover(ctx);
    const control = result.ranks[2].owner;
    const selected = ctx.db.prepare('SELECT cohort,starts_at FROM smart_lp_evaluations WHERE wallet=?').get(control);
    expect(selected.cohort).toBe('comparison');
    ctx.db.prepare("UPDATE smart_lp_evaluations SET status='verified' WHERE wallet=?").run(control);
    expect(smartLpStatus(ctx.db, control).status).toBe('comparison');
  });

  it('audits public follow-up using indexed transfers and Solana fees without LP Agent', async () => {
    const ctx = fixture(':memory:', { minClosed: 3 });
    ctx.publicMeteora = true;
    const start = ctx.now;
    setMeta(ctx.db, 'public_sample_owners', JSON.stringify([mockWallet]));
    await discoverPublicSmartLp(ctx, start);
    ctx.providers.closedPositions = async () => [1, 8, 15].map(day => {
      const position = 'holdout-' + day;
      return { position_pubkey: position, pool: mockPool, status: 'closed', closed_at: start + day * DAY,
        opened_at: start + day * DAY - 3600000, pnl_sol: 1, deposit_sol: 10,
        indexed: positionData(position, mockPool), tokens: { tokenX: SOL, tokenY: token } };
    });
    ctx.providers.openPositions = async () => [];
    ctx.providers.crossCheck = vi.fn();
    ctx.providers.verifyClosedUniverse = vi.fn();
    ctx.providers.positionEvents = async id => eventsFor(id, mockPool);
    ctx.providers.candles = async (_pool, _frame, from) => [{ at: from, close: 2 }];
    ctx.providers.transaction = async signature => ({ meta: { err: null, fee: 5000 },
      transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: mockWallet }] } } });
    await evaluateCohort(ctx, summarize, verification, start + 30 * DAY);
    const status = smartLpStatus(ctx.db, mockWallet, start + 30 * DAY);
    expect(status.status).toBe('verified');
    expect(JSON.parse(status.evidence)).toMatchObject({ source: 'Meteora + Solana RPC', benchmarked: 3, positiveWeeks: 3 });
    expect(ctx.providers.crossCheck).not.toHaveBeenCalled();
    expect(ctx.providers.verifyClosedUniverse).not.toHaveBeenCalled();
  });
});

describe('strategies', () => {
  it('reconstructs the configured one-sided allocation from a recorded DLMM rebalance', () => {
    const id = '6svvped7s42HMBivFhZZizLvBeu5kLJFaHxSUsgVoGHD';
    const pool = '3gUa73kgEfZW6zj97uShGaCd4GAPjc7kd61aKkcCMqpw';
    const data = '2GpD59YMjQrMuFKQrBihgXKCWFp561PbCATh3bP1LPVPbpA2CErwJq5JtEtjdPN7LaNNoMqRYBaJQrqv2tfbFqm8BoxTrpLjrw9VxEG8zSutqkjTewr9HLT8SYsXjZMU4qypadFg7NR2qXHVtL76s2JdteRPm3gkchHg5xnAub27ztM1xhMuwjkDtRkf6ShwT3tCX8s3USJPj33vc55';
    const tx = { meta: { err: null }, transaction: { message: {
      instructions: [{ programId: PROGRAM, data, accounts: [id, pool] }],
    } } };
    const result = openingRebalance(tx, { position_pubkey: id, pool }, 25);
    expect(result).toMatchObject({ strategy_label: 'Custom rebalance', one_sided: 1 });
    expect(result.openingAllocation.bins).toHaveLength(58);
    expect(result.openingAllocation.bins[0]).toEqual({ id: -755, liquidity: '166429284' });
    expect(result.openingAllocation.bins.at(-1)).toEqual({ id: -698, liquidity: '0' });
  });

  it('decodes a recorded on-chain AddLiquidityByStrategy2 transaction', () => {
    const tx = JSON.parse(readFileSync(new URL('../fixtures/dlmm-spot-real.json', import.meta.url)));
    const result = parsePositions(tx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ position: '8JhkF5EvQNkurNVKovpsy4tf2wCrU7BjdQvdUX7ZvzF3',
      kind: 'opened', label: 'SPOT', lower: 533, upper: 574 });
    expect(result[0].amounts.get('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(50_459_976n);
  });
  it('decodes Anchor strategy, actual deposit, open/add and failed transactions', () => {
    const tx = mockTransaction();
    const [position] = parsePositions(tx);
    expect(position).toMatchObject({ position: mockPosition, pool: mockPool, owner: mockWallet, kind: 'opened',
      label: 'BIDASK', lower: -6, upper: 1 });
    expect(position.amounts.get(SOL)).toBe(15_000_000_000n);
    tx.transaction.message.instructions[0] = { programId: SOL };
    expect(parsePositions(tx)[0]).toMatchObject({ kind: 'added', owner: undefined, sender: mockWallet });
    tx.meta.err = { InstructionError: [1, 'InsufficientFunds'] };
    expect(parsePositions(tx)).toEqual([]);
  });

  it('matches the SDK price orientation and detects distributions', () => {
    const thresholds = config({}).strategy;
    expect(binPrice(-100, 50, 6, 9)).toBeCloseTo(Number(DLMM.getPriceOfBinByBinId(-100, 50)) / 1000, 12);
    expect(binPrice(0, 50, 6, 9)).toBe(0.001);
    expect(binPrice(null, 50, 6, 9)).toBeNull();
    const bin = (arr, oneSided = false) => distribution(arr.map((liquidity, id) => ({ id, liquidity, x: 1, y: oneSided ? 0 : 1 })), thresholds);
    expect(bin([1, 1, 1, 1, 1])).toMatchObject({ label: 'SPOT', source: 'distribution', oneSided: 0 });
    expect(bin([1, 2, 9, 2, 1])).toMatchObject({ label: 'CURVE' });
    expect(bin([8, 2, 1, 2, 8], true)).toMatchObject({ label: 'BIDASK', oneSided: 1 });
    expect(bin([5, 3, 1, 2, 1])).toMatchObject({ label: 'MIXED' });
    expect(bin([1, 2]).label).toBeNull();
    expect(mergeLabels('SPOT','BIDASK','SPOT')).toBe('BIDASK+SPOT');
  });
});

describe('realtime', () => {
  it('automatically discovers a new public whale after index catch-up and preserves the newer observation', async () => {
    const ctx = fixture();
    setMeta(ctx.db, 'public_snapshot_at', ctx.now - 1000);
    setMeta(ctx.db, 'public_watch_pools', JSON.stringify([mockPool]));
    ctx.providers.signatures = async () => [{ signature: mockSignature }];
    expect(await pollPublicPools(ctx, [mockPool])).toBe(1);
    await pollPublicPools(ctx, [mockPool]);
    const eventTime = Math.floor(ctx.now / 1000) * 1000;
    const positionAt = (at, deposit) => ({ position_pubkey: mockPosition, wallet: mockWallet, pool: mockPool,
      status: 'open', last_checked_at: at, deposit_usd: deposit, current_sol: 12 });
    let indexedAt = eventTime - 1000;
    ctx.providers.openPoolPositions = async (_wallet, _pool, at) => ({
      positions: new Map([[mockPosition, { position: positionAt(at, 2500), indexedAt }]]),
    });
    await processPublicInbox(ctx);
    expect(publicActivity(ctx.db)).toEqual([]);
    expect(ctx.db.prepare('SELECT attempts FROM event_inbox').get().attempts).toBe(1);
    indexedAt = eventTime;
    ctx.db.exec('UPDATE event_inbox SET available_at=0');
    await processPublicInbox(ctx);
    expect(publicActivity(ctx.db)).toEqual([expect.objectContaining({ wallet: mockWallet, depositUsd: 2500 })]);
    savePublicPosition(ctx.db, positionAt(ctx.now - 1000, 100));
    expect(whalePools(ctx.db)).toEqual([expect.objectContaining({ address: mockPool, depositUsd: 2500 })]);
    setMeta(ctx.db, 'public_snapshot_at', Date.now() + 60000);
    expect(whalePools(ctx.db)).toEqual([]);
    expect(publicActivity(ctx.db)).toEqual([expect.objectContaining({ wallet: mockWallet, depositUsd: 2500 })]);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM event_inbox').get().n).toBe(1);
  });

  it('ignores swap logs and only queues DLMM liquidity updates on the public stream', () => {
    const invocation = 'Program ' + PROGRAM + ' invoke [1]';
    expect(publicLiquidityLogs([invocation, 'Program log: Instruction: Swap'])).toBe(false);
    expect(publicLiquidityLogs([invocation, 'Program log: Instruction: AddLiquidityByStrategy2'])).toBe(true);
    expect(publicLiquidityLogs(['Program log: Instruction: ClosePosition2'])).toBe(false);
  });

  it('durably deduplicates authenticated webhook deliveries and flushes the saved batch on restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'radar-test-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'test.sqlite');
    const ctx = fixture(path);
    await discover(ctx, ctx.now);
    const app = createWebhook(ctx);
    cleanups.push(() => app.close());
    const payload = [{ signature: mockSignature, transactionError: null }];
    expect((await app.inject({ method: 'POST', url: '/hooks/helius', payload })).statusCode).toBe(401);
    const post = () => app.inject({ method: 'POST', url: '/hooks/helius', payload,
      headers: { authorization: ctx.settings.webhookSecret } });
    expect((await post()).json()).toEqual({ accepted: 1 });
    expect((await post()).json()).toEqual({ accepted: 0 });
    await processInbox(ctx);
    const first = ctx.db.prepare('SELECT * FROM alerts').get();
    expect(first).toMatchObject({ size_sol: 15, sent_at: null });
    await flushBatches(ctx);
    expect(ctx.print).not.toHaveBeenCalled();
    const closes = ctx.db.prepare('SELECT closes_at FROM alert_batches').get().closes_at;
    await app.close();
    ctx.db.close();
    const reopened = fixture(path);
    await flushBatches(reopened, closes + 1);
    expect(reopened.print).toHaveBeenCalledWith(expect.stringContaining('opened 15 SOL'));
    expect(reopened.db.prepare('SELECT alert_count FROM wallets WHERE address=?').get(mockWallet).alert_count).toBe(1);
    expect(reopened.db.prepare('SELECT count(*) AS n FROM pool_snapshots WHERE alert_id=?').get(first.id).n).toBe(1);
    expect(enqueue(reopened.db, [mockSignature])).toBe(0);
    await flushBatches(reopened, closes + 1000);
    expect(reopened.print).toHaveBeenCalledTimes(1);
  });

  it('does not publish alerts below the measured deposit threshold or after blacklisting', async () => {
    const ctx = fixture(':memory:', { alertSol: 20 });
    await discover(ctx);
    enqueue(ctx.db, [mockSignature]);
    await processInbox(ctx);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM alerts').get().n).toBe(0);
    ctx.settings.alertSol = 10;
    ctx.db.exec('UPDATE event_inbox SET done_at=NULL');
    await processInbox(ctx);
    ctx.db.prepare('UPDATE wallets SET is_blacklisted=1 WHERE address=?').run(mockWallet);
    await flushBatches(ctx, Date.now(), true);
    expect(ctx.print).not.toHaveBeenCalled();
  });

  it('batches distinct signatures for the same pool within the window', async () => {
    const ctx = fixture();
    await discover(ctx);
    const other = mockSignature.replace(/^2/, '3');
    ctx.providers.transaction = async signature => {
      const tx = mockTransaction();
      tx.transaction.signatures = [signature];
      return tx;
    };
    expect(enqueue(ctx.db, [mockSignature, other])).toBe(2);
    await processInbox(ctx);
    expect(ctx.db.prepare('SELECT count(*) AS batches FROM alert_batches').get().batches).toBe(1);
    expect(ctx.db.prepare('SELECT count(*) AS alerts FROM alerts').get().alerts).toBe(2);
    await flushBatches(ctx, Date.now(), true);
    expect(ctx.print).toHaveBeenCalledTimes(1);
    expect(ctx.print.mock.calls[0][0].match(/opened 15 SOL/g)).toHaveLength(2);
  });

  it('filters complete non-DLMM enhanced payloads and preserves nested and incomplete notifications', () => {
    expect(webhookSignatures([{ signature: mockSignature, instructions: [{ programId: SOL, innerInstructions: [] }] }])).toEqual([]);
    expect(webhookSignatures([{ signature: mockSignature, instructions: [
      { programId: SOL, innerInstructions: [{ programId: PROGRAM }] },
    ] }])).toEqual([mockSignature]);
    expect(webhookSignatures([{ signature: mockSignature, instructions: [] }])).toEqual([mockSignature]);
  });

  it('reconciles a saved cursor before advancing it on WebSocket notifications', async () => {
    const ctx = fixture();
    await discover(ctx);
    const previous = mockSignature.replace(/^2/, '3');
    const next = mockSignature.replace(/^2/, '4');
    ctx.settings.mock = false;
    ctx.settings.webhookUrl = '';
    setMeta(ctx.db, 'ws-cursor:' + mockWallet, previous);
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(ws, 'listening');
    cleanups.push(() => new Promise(resolve => ws.close(resolve)));
    ctx.providers.websocketUrl = () => 'ws://127.0.0.1:' + ws.address().port;
    ctx.providers.signatures = async (_, options) => options.until === previous ? [{ signature: mockSignature, slot: 10 }] : [];
    let socket;
    let subscription;
    ws.on('connection', client => {
      socket = client;
      client.on('message', data => {
        const request = JSON.parse(data);
        const id = request.id + 100;
        if (request.params[0].mentions[0] === mockWallet) subscription = id;
        client.send(JSON.stringify({ id: request.id, jsonrpc: '2.0', result: id }));
      });
    });
    const watcher = watchActivity(ctx);
    cleanups.push(() => watcher.close());
    await watcher.sync();
    await vi.waitFor(() => expect(getMeta(ctx.db, 'ws-cursor:' + mockWallet)).toBe(mockSignature));
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: {
      subscription, result: { context: { slot: 11 }, value: { signature: next, err: null, logs: ['Program ' + PROGRAM + ' invoke [1]'] } },
    } }));
    await vi.waitFor(() => expect(getMeta(ctx.db, 'ws-cursor:' + mockWallet)).toBe(next));
    expect(ctx.db.prepare('SELECT count(*) AS n FROM event_inbox').get().n).toBe(2);
  });
});

describe('dashboard and intelligence', () => {
  it('uses an archived opening instruction when the current position has no funded bins', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4) });
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    ctx.db.prepare('UPDATE positions SET strategy_label=NULL,strategy_source=NULL WHERE position_pubkey=?').run(mockPosition);
    const snapshots = await ctx.providers.bins(mockWallet);
    const saved = snapshots.get(mockPosition);
    snapshots.set(mockPosition, { ...saved, bins: saved.bins.map(bin => ({ ...bin, liquidity: '0' })) });
    ctx.providers.bins = async () => snapshots;
    ctx.providers.transaction = async () => null;
    const archive = { transaction: vi.fn(async () => mockTransaction()) };
    ctx.tools = positionTools(ctx.providers, ctx.settings, archive);
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const result = await app.inject({ url: '/web/positions/' + mockPosition + '/bins', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().strategy).toContain('BID-ASK');
    expect(result.json().strategy).toContain('https://solscan.io/tx/' + mockSignature);
    expect(result.json().chart).toContain('No liquidity currently funded');
    expect(result.json().chart).toContain('Saved distribution');
    expect(archive.transaction).toHaveBeenCalledWith(mockSignature, false);
  });

  it('renders the bin range and protects on-demand liquidity for an open position', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4) });
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    ctx.db.prepare("UPDATE positions SET strategy_label='BIDASK',strategy_source='instruction' WHERE position_pubkey=?").run(mockPosition);
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const url = '/web/positions/' + mockPosition + '/bins';
    expect((await app.inject(url)).statusCode).toBe(401);
    const profile = await app.inject({ url: '/web/wallets/' + mockWallet, headers });
    expect(profile.body).toContain('Bins -6 to 1, active bin 2, Out of range');
    expect(profile.body).toContain('data-position-bins="' + mockPosition);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().range).toContain('Out of range');
    expect(result.json().range).toContain('bin-range is-out-of-range');
    expect(result.json().strategy).toContain('BID-ASK');
    expect(result.json().strategy).toContain('Instruction');
    expect(result.json().chart).toContain('Relative position liquidity by bin');
    expect(result.json().chart).toContain('liquidity-bar below');
    expect(result.json().chart).toContain('bin-chart-marker right');
    ctx.db.prepare("UPDATE positions SET status='closed' WHERE position_pubkey=?").run(mockPosition);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
  });

  it('publishes a single public candidate with closed history and retains it after a provider failure', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4), dormApiKey: 'test-key' });
    setMeta(ctx.db, 'public_snapshot_at', ctx.now);
    setMeta(ctx.db, 'public_sample_owners', JSON.stringify([mockWallet, mockWallet]));
    const scan = await discoverPublicSmartLp(ctx, ctx.now);
    expect(scan).toMatchObject({ candidates: 1, measured: 1, eligible: 1, state: 'complete' });
    expect(smartLpStatus(ctx.db, mockWallet).status).toBe('pending');
    ctx.providers.closedPositions = async () => { throw new Error('provider down'); };
    expect((await discoverPublicSmartLp(ctx, ctx.now + 60000)).state).toBe('retained');
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const ranked = await app.inject({ url: '/web/leaderboard', headers });
    expect(ranked.body).toContain('Candidate · in evaluation');
    expect(ranked.body).toContain(mockWallet + '?unit=SOL&amp;tab=closed');
    const wallet = await app.inject({ url: '/web/wallets/' + mockWallet + '?tab=closed', headers });
    expect(wallet.statusCode).toBe(200);
    expect(wallet.body).toContain('Follow-up performance');
    const exports = await app.inject({ url: '/web/export.csv?table=positions', headers });
    expect(exports.body).toContain(mockWallet);
    const dorm = await app.inject({ url: '/api/agent-dorm/status', headers: { authorization: 'Bearer test-key' } });
    expect(dorm.json().metrics.whaleRadar.smartLp.wallets).toMatchObject([{ rank: 1, wallet: mockWallet, status: 'pending' }]);
  });

  it('switches the wallet PnL between SOL and quoted USDC while keeping the position tab', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4) });
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    setMeta(ctx.db, 'usdc_usd', 0.8);
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const profile = '/web/wallets/' + mockWallet + '?tab=open&unit=';
    const sol = (await app.inject({ url: profile + 'SOL', headers })).body;
    const usdc = (await app.inject({ url: profile + 'USDC', headers })).body;
    const legacy = (await app.inject({ url: profile + 'USD', headers })).body;
    expect(sol).toContain('aria-label="PnL currency"');
    expect(sol).toContain('aria-current="true">SOL</a>');
    expect(sol).toContain('tab=open&amp;unit=USDC');
    expect(sol).toContain('0.5 SOL</span>');
    expect(usdc).toContain('aria-current="true" title="USDC equivalent');
    expect(usdc).toContain('93.75 USDC</span>');
    expect(legacy).toContain('93.75 USDC</span>');
  });

  it('uses the same whale, deposit, bin and fee data for the Dorm API and Telegram preview', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4), dormApiKey: 'test-key' });
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    const observed = ctx.db.prepare('SELECT last_checked_at FROM positions WHERE position_pubkey=?').get(mockPosition).last_checked_at;
    setMeta(ctx.db, 'public_snapshot_at', observed);
    setMeta(ctx.db, 'public_worker_heartbeat', Date.now());
    setMeta(ctx.db, 'public_stream_state', 'connected');
    setMeta(ctx.db, 'public_market_at', Date.now());
    setMeta(ctx.db, 'public_activity', JSON.stringify([{ signature: mockSignature, position: mockPosition, wallet: mockWallet,
      pool: mockPool, timestamp: Date.now(), label: 'BIDASK' }]));
    await refreshIntel(ctx);
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const url = '/api/agent-dorm/status';
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') } })).statusCode).toBe(401);
    const result = await app.inject({ url, headers: { authorization: 'Bearer test-key' } });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body).toMatchObject({ agentId: 'alert', status: 'ok', metrics: { candidates: [] }, events: [] });
    const radar = body.metrics.whaleRadar;
    expect(radar.totals).toMatchObject({ wallets: 1, pools: 1, depositUsd: 2250 });
    expect(radar.openings[0]).toMatchObject({ verification: 'observed_whale', walletDepositUsd: 2250,
      pool: { binStep: 50, baseFeePct: 1, dynamicFeePct: 1.2 } });
    const message = publicTelegramMessage(radar.openings[0], radar);
    expect(message.text).toContain('US$2,250');
    expect(message.text).toContain('Bin Step 50 · Base fee 1% · Dynamic fee 1.2%');
    expect(message.reply_markup.inline_keyboard[0][1].url).toBe(radar.openings[0].transactionUrl);
  });

  it('opens the public dashboard before discovery and exposes changes without calling the provider from the UI', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4) });
    setMeta(ctx.db, 'public_worker_started_at', ctx.now);
    setMeta(ctx.db, 'public_worker_heartbeat', ctx.now);
    setMeta(ctx.db, 'public_stream_state', 'connected');
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const page = await app.inject({ url: '/web', headers });
    expect(page.body).toContain('data-radar-state="syncing"');
    const initial = (await app.inject({ url: '/web/public-status', headers })).json();
    setMeta(ctx.db, 'public_scan_completed_at', ctx.now);
    setMeta(ctx.db, 'public_market_at', ctx.now);
    const live = (await app.inject({ url: '/web/public-status', headers })).json();
    expect(live.status).toBe('live');
    expect(live.revision).not.toBe(initial.revision);
    setMeta(ctx.db, 'public_market_state', 'failed');
    expect(publicHealth(ctx.db, ctx.now).status).toBe('degraded');
    expect(publicHealth(ctx.db, ctx.now + 60000).status).toBe('offline');
  });

  it('shows each public wallet once and displays per-pool bin steps and trading fees', async () => {
    const ctx = fixture(':memory:', { webPassword: await bcrypt.hash('private', 4) });
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    const position = ctx.db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(mockPosition);
    setMeta(ctx.db, 'public_snapshot_at', position.last_checked_at);
    const secondPool = 'second-pool';
    savePosition(ctx.db, { ...position, position_pubkey: 'second-position', pool: secondPool, deposit_usd: 2500 });
    snapshot(ctx.db, { address: mockPool, name: 'Same pair', binStep: 25, baseFeePct: 0.01, dynamicFeePct: 0.01875 }, ctx.now);
    snapshot(ctx.db, { address: secondPool, name: 'Same pair', binStep: 50, baseFeePct: 0.25, dynamicFeePct: 0 }, ctx.now);
    const app = createWeb(ctx);
    cleanups.push(() => app.close());
    const headers = { authorization: 'Basic ' + Buffer.from('mock:private').toString('base64') };
    const wallets = (await app.inject({ url: '/web/wallets', headers })).body;
    expect(wallets.split('data-copy="' + mockWallet + '"')).toHaveLength(2);
    expect(wallets).toContain('>2 pools</summary>');
    expect(wallets).toContain('$4,750');
    expect(wallets).toContain('dlmm/' + mockPool);
    expect(wallets).toContain('dlmm/' + secondPool);
    const pools = (await app.inject({ url: '/web/pools', headers })).body;
    expect(pools).toContain('>Bin Step</th>');
    expect(pools).toContain('>25</td><td>0.01%</td><td>0.01875%</td>');
    expect(pools).toContain('>50</td><td>0.25%</td><td>0%</td>');
  });

  it('excludes stale public positions after another snapshot refreshes the same pool', async () => {
    const ctx = fixture();
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    const old = ctx.db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(mockPosition);
    const next = old.last_checked_at + 1000;
    setMeta(ctx.db, 'public_snapshot_at', next);
    expect(whalePools(ctx.db)).toEqual([]);
    savePosition(ctx.db, { ...old, position_pubkey: 'fresh-public-position', deposit_usd: 2500,
      current_sol: 4, last_checked_at: next });
    expect(whalePools(ctx.db)).toEqual([expect.objectContaining({ address: mockPool, depositUsd: 2500, size: 4 })]);
  });

  it('requires more than $2,000 in open deposits for each wallet–pool pair', async () => {
    const ctx = fixture();
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    const p = ctx.db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(mockPosition);
    savePosition(ctx.db, { ...p, deposit_usd: 1200 });
    savePosition(ctx.db, { ...p, position_pubkey: 'small-same-pool', deposit_usd: 800 });
    savePosition(ctx.db, { ...p, position_pubkey: 'other-pool', pool: 'another-pool', deposit_usd: 1999, current_sol: 400 });
    savePosition(ctx.db, { ...p, position_pubkey: 'closed-large', status: 'closed', deposit_usd: 9000 });
    expect(whalePools(ctx.db)).toEqual([]);
    savePosition(ctx.db, { ...p, position_pubkey: 'small-same-pool', deposit_usd: 801 });
    expect(whalePools(ctx.db)).toEqual([expect.objectContaining({ address: mockPool, count: 1, depositUsd: 2001 })]);
  });

  it('skips an alert at or below the pool deposit threshold', async () => {
    const ctx = fixture();
    await discover(ctx);
    ctx.providers.activeDepositUsd = async () => ({ usd: 2000, indexed: true });
    enqueue(ctx.db, [mockSignature]);
    await processInbox(ctx);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM alerts').get().n).toBe(0);
  });
  it('aggregates tracked wallets once per pool and attaches the strategy mix', async () => {
    const ctx = fixture();
    await discover(ctx);
    await refreshWallet(ctx, mockWallet);
    const sample = ctx.db.prepare('SELECT * FROM positions WHERE position_pubkey=?').get(mockPosition);
    savePosition(ctx.db, { ...sample, position_pubkey: 'a-second-position', strategy_label: 'SPOT',
      strategy_source: 'instruction', current_sol: 2 });
    const [pool] = whalePools(ctx.db);
    expect(pool).toMatchObject({ address: mockPool, count: 1, size: 17.5, mix: { 'BIDASK+SPOT': 1 } });
    await refreshIntel(ctx);
    const [hot] = trending(ctx.db, ctx.settings);
    expect(hot.whales.count).toBe(1);
    expect(hot.score).toBeGreaterThan(trendingScore(hot, null, ctx.settings, ctx.now));
    expect(trendingScore({ ...hot, blacklisted: true }, pool, ctx.settings, ctx.now)).toBeNull();
  });

  it('serves all private pages, validates CSRF, escapes notes and protects CSV cells', async () => {
    const ctx = fixture(':memory:', { batchMs: 0, webPassword: await bcrypt.hash('private', 4) });
    await discover(ctx);
    enqueue(ctx.db, [mockSignature]);
    await processInbox(ctx);
    await flushBatches(ctx, Date.now(), true);
    await refreshWallet(ctx, mockWallet);
    await refreshIntel(ctx);
    expect(() => createWeb({ ...ctx, settings: { ...ctx.settings, webPassword: '' } })).toThrow('WEB_USER');
    const web = createWeb(ctx);
    cleanups.push(() => web.close());
    const authorization = 'Basic ' + Buffer.from('mock:private').toString('base64');
    const get = url => web.inject({ url, headers: { authorization } });
    expect((await web.inject('/web')).statusCode).toBe(401);
    for (const page of ['/web','/web/wallets','/web/wallets/' + mockWallet,'/web/leaderboard','/web/pools','/web/trending','/web/alerts']) {
      const response = await get(page);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toBeTruthy();
    }
    const profile = '/web/wallets/' + mockWallet;
    const submit = payload => web.inject({ method: 'POST', url: profile, headers: {
      authorization, 'content-type': 'application/x-www-form-urlencoded',
    }, payload: new URLSearchParams(payload).toString() });
    expect((await submit({ csrf:'invalid', note:'a', tags:'b' })).statusCode).toBe(403);
    const csrf = (await get(profile)).body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    expect((await submit({ csrf, note:'<script>bad()</script>', tags:'=1+2', favorite:'1' })).statusCode).toBe(303);
    expect((await get(profile)).body).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect((await get('/web/export.csv?table=wallets')).body).toContain('"\'=1+2"');
    const data = (await get('/web/export.json')).json();
    expect(data.alerts).toHaveLength(1);
    expect(data.positions.length).toBeGreaterThan(1);
    expect(data.position_bins.length).toBeGreaterThan(1);
  });
});

it('caches successful GETs and honors a retryable rate limit', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response('{"result":1}'));
  const request = http('mock fixture', { rpm: 60_000, fetcher });
  expect(await request('https://example.test', { ttl: 5000 })).toEqual({ result: 1 });
  expect(await request('https://example.test', { ttl: 5000 })).toEqual({ result: 1 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
