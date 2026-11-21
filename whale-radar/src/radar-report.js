import { PUBLIC_OPENING_MIN_USD, SOL, WHALE_DEPOSIT_USD } from './config.js';
import { getMeta, latestPools, publicActivity } from './db.js';
import { whalePools } from './intel/pools.js';
import { publicSmartLpReport } from './discovery/public-leaderboard.js';
import { smartLpStatus } from './discovery/smart-lp.js';
import { relativePriceRange } from './strategy/distribution.js';
import { isAddress } from './strategy/instructions.js';

const iso = value => value > 0 ? new Date(value).toISOString() : null;
const numeric = value => Number.isFinite(value) ? value : null;
const metaNumber = (db, key) => Number(getMeta(db, key)) || null;
const meteoraUrl = address => 'https://app.meteora.ag/dlmm/' + encodeURIComponent(address);

export function publicHealth(db, now = Date.now()) {
  const heartbeat = metaNumber(db, 'public_worker_heartbeat');
  const running = heartbeat != null && now - heartbeat < 45000;
  const queue = db.prepare(`SELECT count(CASE WHEN done_at IS NULL THEN 1 END) AS pending,
    count(CASE WHEN done_at IS NOT NULL AND last_error IS NULL THEN 1 END) AS processed,
    count(CASE WHEN done_at IS NOT NULL AND last_error IS NOT NULL THEN 1 END) AS unresolved FROM event_inbox`).get();
  const scanAt = metaNumber(db, 'public_scan_completed_at') ?? metaNumber(db, 'public_snapshot_at');
  const marketAt = metaNumber(db, 'public_market_at');
  const walletsAt = metaNumber(db, 'public_wallets_at');
  const scanState = getMeta(db, 'public_scan_state') ?? null;
  const marketState = getMeta(db, 'public_market_state') ?? null;
  const walletsState = getMeta(db, 'public_wallets_state') ?? null;
  const websocket = running ? getMeta(db, 'public_stream_state') ?? 'starting' : 'offline';
  const scanInterval = metaNumber(db, 'public_discovery_interval_ms') ?? 900000;
  const discoveryStale = !scanAt || now - scanAt > 3 * scanInterval;
  const marketStale = !marketAt || now - marketAt > 360000;
  const walletsStale = walletsAt != null && now - walletsAt > 600000;
  const smart = getMeta(db, 'public_smart_lp_health') ?? '';
  const followup = db.prepare('SELECT max(checked_at) AS at FROM smart_lp_evaluations').get().at;
  const revision = [scanAt, marketAt, walletsAt, getMeta(db, 'public_last_verified_at'), getMeta(db, 'leaderboard_at'), smart, followup].join('|');
  const latestDataAt = Math.max(scanAt ?? 0, marketAt ?? 0, walletsAt ?? 0, metaNumber(db, 'public_last_verified_at') ?? 0) || null;
  const status = !running ? 'offline' : !scanAt && scanState !== 'failed' ? 'syncing' :
    websocket !== 'connected' || discoveryStale || marketStale || walletsStale || scanState === 'failed' ||
    ['partial', 'failed'].includes(marketState) || ['partial', 'failed'].includes(walletsState) ? 'degraded' : 'live';
  return {
    running, websocket, status, revision, latestDataAt, marketAt, walletsAt, marketState, walletsState,
    discoveryStale, marketStale, walletsStale,
    subscribedPools: running ? (metaNumber(db, 'public_stream_pools') ?? 0) : 0,
    snapshotAt: metaNumber(db, 'public_snapshot_at'), scanStartedAt: metaNumber(db, 'public_scan_started_at'),
    scanCompletedAt: metaNumber(db, 'public_scan_completed_at'), scanState,
    lastPollAt: metaNumber(db, 'public_last_poll_at'), lastTransactionAt: metaNumber(db, 'public_last_rpc_processed_at'),
    lastVerifiedAt: metaNumber(db, 'public_last_verified_at'), queue,
    telegram: { state: getMeta(db, 'public_telegram_state') ?? 'unknown',
      lastDeliveredAt: db.prepare('SELECT max(sent_at) FROM public_telegram_delivery').pluck().get() },
  };
}

export function radarReport(db, now = Date.now()) {
  return db.transaction(() => {
    const health = publicHealth(db, now);
    const smartLp = publicSmartLpReport(db, now);
    const details = new Map(latestPools(db).map(pool => [pool.address, pool]));
    const whales = whalePools(db);
    const marketFacts = (address, row) => {
      const stats = details.get(address);
      const tokens = ['X', 'Y'].map(side => {
        const mint = stats?.['token' + side];
        const symbol = stats?.['token' + side + 'Symbol'] ?? (mint === stats?.tokenMint ? stats?.tokenSymbol : null);
        return { mint, symbol: symbol ?? null, side };
      }).filter(token => isAddress(token.mint));
      return {
        poolAddress: address, pair: stats?.name || row?.name || address, tokens,
        whaleWallets: row?.count ?? 0, depositUsd: row?.depositUsd ?? 0, binStep: numeric(stats?.binStep),
        baseFeePct: numeric(stats?.baseFeePct), dynamicFeePct: numeric(stats?.dynamicFeePct),
        tvlUsd: numeric(stats?.tvl), volume24hUsd: numeric(stats?.volume24), fdvUsd: numeric(stats?.fdv),
        feeTvlPct: stats?.feeTvl == null ? null : stats.feeTvl * 100,
        observedAt: iso(stats?.takenAt), poolUrl: meteoraUrl(address),
      };
    };
    const pools = whales.map(row => marketFacts(row.address, row))
      .sort((a,b) => b.depositUsd - a.depositUsd || a.poolAddress.localeCompare(b.poolAddress));
    const byPool = new Map(pools.map(pool => [pool.poolAddress, pool]));
    const openings = publicActivity(db).map(event => {
      const pool = byPool.get(event.pool) ?? marketFacts(event.pool);
      const evaluation = smartLpStatus(db, event.wallet, now);
      const depositedMints = new Set(event.transfers?.filter(transfer => Number(transfer.amount) > 0).map(transfer => transfer.mint));
      const depositSide = depositedMints.size > 1 ? 'double' : depositedMints.has(SOL) ? 'sol' : depositedMints.size ? 'token' : null;
      const bins = event.openingBins;
      // For SOL pairs, quote the other token in SOL regardless of Meteora's X/Y order.
      const openingRangePct = bins && pool.tokens.length === 2 ? relativePriceRange(bins.lower, bins.upper, bins.active,
        pool.binStep, pool.tokens.some(token => token.side === 'X' && token.mint === SOL)) : null;
      return {
        id: event.signature + ':' + event.position, signature: event.signature, position: event.position,
        wallet: event.wallet, at: iso(event.timestamp), strategy: event.label ?? null,
        strategySource: event.label ? 'instruction' : null,
        verification: 'observed_whale', smartLpStatus: evaluation.cohort === 'candidate' ? evaluation.status : null,
        walletDepositUsd: event.depositUsd ?? null, openingDepositUsd: event.openingDepositUsd, depositSide, openingRangePct,
        alertMarket: event.alertMarket ?? null, pool,
        transactionUrl: 'https://solscan.io/tx/' + encodeURIComponent(event.signature),
      };
    });
    const stats = db.prepare('SELECT coalesce(sum(active_positions),0) AS activePositions FROM whale_deposits').get();
    return {
      version: 1, source: 'Solana RPC + Meteora DLMM Data API', mode: 'public', thresholdUsd: WHALE_DEPOSIT_USD,
      openingThresholdUsd: PUBLIC_OPENING_MIN_USD,
      heartbeatAt: iso(metaNumber(db, 'public_worker_heartbeat')), health,
      totals: { wallets: new Set(whales.flatMap(row => row.wallets.map(wallet => wallet.wallet))).size,
        pools: pools.length, activePositions: stats.activePositions, depositUsd: pools.reduce((sum, row) => sum + row.depositUsd, 0),
        confirmedOpenings: openings.length },
      pools, openings, smartLp,
    };
  })();
}

export function agentDormSnapshot(report) {
  const updatedAt = report.heartbeatAt ?? iso(report.health.snapshotAt) ?? '1970-01-01T00:00:00.000Z';
  const { status: radarStatus } = report.health;
  const status = radarStatus === 'offline' ? 'offline' : radarStatus === 'live' ? 'ok' : 'warn';
  return {
    agentId: 'alert', status, updatedAt, headline: `Whale Radar · ${report.totals.wallets} wallet teramati`,
    metrics: { lastScanAt: iso(report.health.scanCompletedAt ?? report.health.snapshotAt), scannedToday: null,
      passedFilters: 0, filters: { minLiquidityUsd: 0, minVolume24hUsd: 0, maxFdvUsd: 0, minAgeHours: 0 }, candidates: [],
      whaleRadar: { ...report, pools: report.pools.slice(0,12), openings: report.openings.slice(0,12) } },
    alerts: [], events: [],
  };
}
