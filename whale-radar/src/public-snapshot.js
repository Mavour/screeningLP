import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { SOL, USDC, DAY, PUBLIC_OPENING_MIN_USD, WHALE_DEPOSIT_USD, finite } from './config.js';
import { http, parallel, url } from './clients/http.js';
import { normalizePool } from './clients/providers.js';
import { getMeta, latestPools, openDb, publicActivity, refreshProfile, savePublicOpening, savePublicPosition, setMeta, snapshot, touchWallet } from './db.js';
import { DLMM, MAX_TRANSACTION_VERSION, PROGRAM, isAddress, parsePositions } from './strategy/instructions.js';
import { classifyOpeningMarket, openingMarketLookup } from './opening-market.js';

const endpoint = 'https://dlmm.datapi.meteora.ag';
const rpcEndpoint = process.env.RADAR_PUBLIC_RPC_URL || 'https://solana-rpc.publicnode.com';
const meteora = http('meteora public API', { rpm: 300, timeout: 6000, retries: 1 });
const solana = http('solana public RPC', { rpm: 100, timeout: 6000, retries: 0 });
const positionRpc = http('solana public position RPC', { rpm: 30, timeout: 12000, retries: 0 });
const get = (path, params) => meteora(url(endpoint, path, params));
const addEventsQuery = { event_type: 'add', order_direction: 'asc' };
const rpc = async (method, params) => {
  const data = await solana(rpcEndpoint, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
  if (data.error) throw new Error('Public RPC rejected ' + method);
  return data.result;
};

export function publicDatabasePath() {
  return process.env.RADAR_DB || fileURLToPath(new URL('../data/public-preview.sqlite', import.meta.url));
}

export function assertPublicDatabase(db) {
  if (!getMeta(db, 'public_snapshot_at') && db.prepare('SELECT 1 FROM wallets LIMIT 1').get()) {
    throw new Error('Set RADAR_DB to a separate public preview database');
  }
}

export function openingDepositUsd(events, signature, position, pool, wallet) {
  if (!Array.isArray(events)) return null;
  const amounts = new Map();
  for (const event of events) {
    if (event.eventType !== 'add' || event.signature !== signature || event.positionAddress !== position ||
      event.poolAddress !== pool || event.userAddress !== wallet) continue;
    const usd = finite(event.totalUsd);
    if (usd == null || usd < 0 || !Number.isInteger(event.ixIndex)) return null;
    if (amounts.has(event.ixIndex) && amounts.get(event.ixIndex) !== usd) return null;
    amounts.set(event.ixIndex, usd);
  }
  const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
  return amounts.size && Number.isFinite(total) ? total : null;
}

export function serializePublicOpening(event, wallet, signature, timestamp) {
  return {
    wallet, pool: event.pool, position: event.position, label: event.label, signature, timestamp, kind: event.kind,
    openingBins: { lower: event.lower ?? null, upper: event.upper ?? null, active: event.activeBin },
    transfers: [...event.amounts].map(([mint, amount]) => ({
      mint, amount: amount.toString(), decimals: event.decimals.get(mint) ?? null,
    })),
  };
}

export function publicStreamProviders(signal) {
  const liveSolana = http('solana public live RPC', { rpm: 180, timeout: 6500, retries: 1, signal });
  const liveMeteora = http('meteora public live API', { rpm: 120, timeout: 6500, retries: 1, signal });
  const rpcUrl = process.env.RADAR_PUBLIC_RPC_URL || rpcEndpoint;
  let id = 0;
  const confirmed = new Map();
  const read = async (method, params) => {
    signal?.throwIfAborted();
    const data = await liveSolana(rpcUrl, { method: 'POST', body: { jsonrpc: '2.0', id: ++id, method, params } });
    if (data.error || !Object.hasOwn(data, 'result')) {
      const code = Number.isInteger(data.error?.code) ? ' (' + data.error.code + ')' : '';
      throw new Error('Public RPC rejected ' + method + code);
    }
    return data.result;
  };
  const readIndex = (path, params, ttl = 0) => {
    signal?.throwIfAborted();
    return liveMeteora(url(endpoint, path, params), { ttl });
  };
  return {
    openingMarkets: openingMarketLookup(signal),
    websocketUrl: () => process.env.RADAR_PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com',
    signatures: (address, options) => read('getSignaturesForAddress', [address, { ...options, commitment: 'confirmed' }]),
    async transaction(signature) {
      const cached = confirmed.get(signature);
      if (cached?.until > Date.now()) return cached.tx;
      const tx = await read('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed',
        maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION }]);
      if (tx?.transaction?.signatures?.[0] === signature) {
        if (confirmed.size >= 500) confirmed.delete(confirmed.keys().next().value);
        confirmed.set(signature, { tx, until: Date.now() + 120000 });
      }
      return tx;
    },
    account: address => read('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]),
    async marketPools() {
      const data = await readIndex('/pools', { page_size: 24, sort_by: 'volume_24h:desc',
        filter_by: 'is_blacklisted=false && tvl>=10000' });
      if (!Array.isArray(data.data) || !data.data.length) throw new Error('No current Meteora market pools');
      return data.data;
    },
    marketPool: address => readIndex('/pools/' + address, {}),
    async positionAdds(position) {
      const data = await readIndex('/positions/' + position + '/historical', addEventsQuery);
      return data.events;
    },
    async volume5m(address, now) {
      const end = Math.floor(now / 300000) * 300;
      const data = await readIndex('/pools/' + address + '/volume/history',
        { timeframe: '5m', start_time: end - 600, end_time: end - 1 });
      return finite(data.data?.find(row => Number(row.timestamp) === end - 300)?.volume);
    },
    async openPoolPositions(wallet, address, now) {
      const info = await readIndex('/pools/' + address, {}, 120000);
      const pair = { poolAddress: address, binStep: info.pool_config?.bin_step, tokenX: info.token_x?.symbol,
        tokenY: info.token_y?.symbol, tokenXMint: info.token_x?.address, tokenYMint: info.token_y?.address };
      const positions = new Map();
      for (let page = 1; page <= 5; page++) {
        const data = await readIndex('/positions/' + address + '/pnl', { user: wallet, status: 'open', page, page_size: 100 });
        if (!Array.isArray(data.positions) || typeof data.hasNext !== 'boolean') throw new Error('Invalid public pool index response');
        for (const row of data.positions) {
          if (row.isClosed !== false || !isAddress(row.positionAddress)) throw new Error('Incomplete public open position');
          positions.set(row.positionAddress, {
            position: normalizePosition(row, pair, wallet, new Map(), now),
            indexedAt: (row.updatedAt ?? row.createdAt ?? 0) * 1000,
          });
        }
        if (!data.hasNext) return { positions, pool: poolData(info, now) };
      }
      throw new Error('Public open position page limit reached');
    },
  };
}

async function verifyStoredOpenings({ db, providers, logger, signal }, now) {
  const pending = db.prepare(`SELECT e.signature,e.position,json_extract(e.detail,'$.pool') AS pool,w.address AS wallet
    FROM public_activity_events e JOIN wallets w ON w.address=json_extract(e.detail,'$.wallet') AND w.is_blacklisted=0
    WHERE json_extract(e.detail,'$.openingDepositUsd') IS NULL
      AND coalesce(json_extract(e.detail,'$.openingDepositCheckedAt'),0)<=?
    ORDER BY json_extract(e.detail,'$.openingDepositCheckedAt'),e.happened_at DESC LIMIT 12`).all(now - 15 * 60000);
  if (!pending.length) return;
  const results = await parallel(pending, 4, async ({ position, signature, pool, wallet }) => {
    const events = await providers.positionAdds(position);
    return openingDepositUsd(events, signature, position, pool, wallet);
  });
  signal?.throwIfAborted();
  const update = db.prepare(`UPDATE public_activity_events
    SET detail=json_set(detail,'$.openingDepositCheckedAt',?,'$.openingDepositUsd',?)
    WHERE signature=? AND position=? AND json_extract(detail,'$.openingDepositUsd') IS NULL`);
  db.transaction(() => {
    let qualified = false;
    for (const [i, { signature, position }] of pending.entries()) {
      const amount = results[i].value ?? null;
      const { changes } = update.run(now, amount, signature, position);
      if (changes && amount >= PUBLIC_OPENING_MIN_USD) qualified = true;
    }
    if (qualified) setMeta(db, 'public_last_verified_at', Date.now());
  }).immediate();
  const failed = results.filter(row => row.error).length;
  if (failed) logger.warn({ failed, checked: pending.length }, 'Stored opening verification incomplete');
}

export async function refreshPublicMarket({ db, providers, logger, signal }, now = Date.now()) {
  const listed = await providers.marketPools();
  const pools = new Map(listed.map(row => [row.address, row]));
  const tracked = db.prepare('SELECT DISTINCT pool FROM whale_deposits ORDER BY pool').pluck().all();
  const rows = await parallel([...new Set([...pools.keys(), ...tracked])], 4, async address => {
    const raw = pools.get(address) ?? await providers.marketPool(address);
    if (!isAddress(raw.address) || raw.address !== address) throw new Error('Invalid Meteora market pool');
    return { raw, metrics: { ...poolData(raw, now),
      volume5: await providers.volume5m(address, now).catch(() => null) } };
  });
  signal?.throwIfAborted();
  const results = rows.flatMap(row => row.value ? [row.value] : []);
  if (!results.length) throw new Error('No market updates available');
  await verifyStoredOpenings({ db, providers, logger, signal }, now);
  const pending = publicActivity(db).filter(event => event.alertMarket?.marketCapUsd == null);
  const metadata = new Map([...latestPools(db), ...results.map(row => row.metrics)].map(pool => [pool.address, pool]));
  const pendingPools = [...new Set(pending.map(event => event.pool))].map(address => metadata.get(address)).filter(Boolean);
  const markets = pendingPools.length ? await providers.openingMarkets(pendingPools).catch(error => {
    logger.warn({ reason: error.message }, 'Opening market cap refresh unavailable');
    return new Map(pendingPools.map(pool => [pool.address, classifyOpeningMarket(pool)]));
  }) : new Map();
  signal?.throwIfAborted();
  db.transaction(() => {
    for (const { metrics } of results) snapshot(db, metrics, now);
    const categorize = db.prepare(`UPDATE public_activity_events SET detail=json_set(detail,'$.alertMarket',json(?))
      WHERE signature=? AND position=? AND (json_extract(detail,'$.alertMarket') IS NULL OR
        (json_extract(detail,'$.alertMarket.marketCapUsd') IS NULL AND json_extract(detail,'$.alertMarket.mint')=? AND ? IS NOT NULL))`);
    for (const event of pending) {
      const market = markets.get(event.pool);
      if (market) categorize.run(JSON.stringify(market), event.signature, event.position, market.mint, market.marketCapUsd);
    }
    const tokens = results.flatMap(({ raw }) => [raw.token_x, raw.token_y]);
    for (const [mint, key] of [[SOL, 'sol_usd'], [USDC, 'usdc_usd']]) {
      const token = tokens.find(item => item?.address === mint && finite(item.price) > 0);
      if (token) setMeta(db, key, finite(token.price));
    }
    setMeta(db, 'public_market_at', now);
    setMeta(db, 'public_market_state', results.length === rows.length ? 'complete' : 'partial');
  }).immediate();
  if (results.length !== rows.length) logger.warn({ missing: rows.length - results.length }, 'Public market data incomplete');
}

function poolData(row, now) {
  const pool = normalizePool(row);
  const token = row.token_x?.address === SOL ? row.token_y : row.token_x;
  const p = finite(token?.price);
  const supply = finite(token?.total_supply);
  return { ...pool, fdv: p > 0 && supply > 0 ? p * supply : null, fdvSource: 'Meteora',
    tokenSymbol: token?.symbol, volume30: finite(row.volume?.['30m']), takenAt: now };
}

function distinctPools(rows, used, limit) {
  const mints = new Set();
  return rows.filter(row => {
    if (used.has(row.address)) return false;
    const mint = row.token_x?.address === SOL ? row.token_y?.address : row.token_x?.address;
    if (!mint || mints.has(mint)) return false;
    mints.add(mint);
    return true;
  }).slice(0, limit);
}

async function sampledOwners(pool, now) {
  const keys = await positionRpc(process.env.RADAR_PUBLIC_POSITION_RPC_URL || 'https://api.mainnet-beta.solana.com', {
    method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [PROGRAM, {
      commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 40, length: 32 },
      filters: [DLMM.positionV2Filter(), DLMM.positionLbPairFilter(new PublicKey(pool.address))],
    }] },
  });
  if (!Array.isArray(keys.result)) throw new Error('Public RPC does not supply position accounts');
  const counts = new Map();
  for (const { account } of keys.result) {
    if (account?.owner !== PROGRAM || account.data?.[1] !== 'base64') continue;
    const bytes = Buffer.from(account.data[0], 'base64');
    if (bytes.length !== 32) continue;
    const owner = bs58.encode(bytes);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  const highCount = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const seed = pool.address + ':' + Math.floor(now / DAY);
  const hash = address => createHash('sha256').update(seed + ':' + address).digest('hex');
  const sampled = [...counts.keys()].filter(address => address !== highCount)
    .map(owner => ({ owner, order: hash(owner) })).sort((a, b) => a.order.localeCompare(b.order));
  return [highCount, ...sampled.slice(0, 4).map(row => row.owner)].filter(Boolean);
}

async function samplePoolWhales(groups, now) {
  const selected = groups.flatMap(([group, pools]) => pools.map(pool => ({ group, pool })));
  const accounts = await parallel(selected, 3, async ({ group, pool }) =>
    ({ group, pool, owners: await sampledOwners(pool, now) }));
  const available = accounts.map(row => row.value).filter(Boolean);
  const pairs = available.flatMap(({ group, pool, owners }) => owners.map(owner => ({ group, pool, owner })));
  const candidates = await parallel(pairs, 6, async ({ group, pool, owner }) => {
    const pair = { poolAddress: pool.address, binStep: pool.pool_config?.bin_step, tokenX: pool.token_x?.symbol,
      tokenY: pool.token_y?.symbol, tokenXMint: pool.token_x?.address, tokenYMint: pool.token_y?.address };
    const positions = [];
    for (let page = 1; page <= 2; page++) {
      const result = await get('/positions/' + pool.address + '/pnl', { user: owner, status: 'open', page, page_size: 100 });
      const rows = result.positions.filter(row => row.isClosed === false && isAddress(row.positionAddress));
      positions.push(...rows.map(row => normalizePosition(row, pair, owner, new Map(), now)));
      if (!result.hasNext) break;
    }
    const unique = [...new Map(positions.map(row => [row.position_pubkey, row])).values()];
    const total = unique.reduce((sum, row) => sum + (row.deposit_usd ?? 0), 0);
    return total > WHALE_DEPOSIT_USD ? { group, owner, total, positions: unique } : null;
  });
  const buckets = new Map(groups.map(([name]) => [name, []]));
  for (const item of candidates.map(row => row.value).filter(Boolean)) buckets.get(item.group).push(item);
  for (const rows of buckets.values()) rows.sort((a, b) => b.total - a.total);
  const wallets = new Set();
  while (wallets.size < 12 && [...buckets.values()].some(rows => rows.length)) {
    for (const rows of buckets.values()) {
      if (rows.length) wallets.add(rows.shift().owner);
      if (wallets.size === 12) break;
    }
  }
  return { wallets: [...wallets], pairs: pairs.length,
    owners: [...new Set(available.flatMap(row => row.owners))],
    positions: candidates.flatMap(row => wallets.has(row.value?.owner) ? row.value.positions : []),
    groups: [...new Set(available.map(item => item.group))], pools: available.length };
}

async function sampledActivity(pools) {
  const work = await parallel(pools, 4, async pool => {
    const signatures = await rpc('getSignaturesForAddress', [pool.address, { limit: 7, commitment: 'confirmed' }]);
    return (signatures ?? []).filter(row => !row.err).map(row => row.signature);
  });
  const signatures = [...new Set(work.flatMap(row => row.value ?? []))];
  const actions = [];
  for (let i = 0; i < signatures.length && new Set(actions.map(row => row.wallet)).size < 8; i += 10) {
    const results = await parallel(signatures.slice(i, i + 10), 4, async signature => {
      const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed',
        maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION }]);
      if (tx?.transaction?.signatures?.[0] !== signature || !tx.blockTime) return [];
      return parsePositions(tx).filter(event => event.kind === 'opened' && event.owner && event.amounts.size)
        .map(event => serializePublicOpening(event, event.owner, signature, tx.blockTime * 1000));
    });
    actions.push(...results.flatMap(result => result.value ?? []));
  }
  return actions.sort((a, b) => b.timestamp - a.timestamp);
}

export function normalizePosition(raw, pair, wallet, activity, now) {
  const pnl = raw.unrealizedPnl;
  const opened = activity.get(raw.positionAddress);
  const priceLow = finite(raw.minPrice);
  const priceHigh = finite(raw.maxPrice);
  const fees = [pnl?.unclaimedFeeTokenX, pnl?.unclaimedFeeTokenY].map(row => finite(row?.amountSol));
  return { position_pubkey: raw.positionAddress, wallet, pool: pair.poolAddress,
    token_mint: pair.tokenXMint === SOL ? pair.tokenYMint : pair.tokenXMint,
    pool_name: [pair.tokenX, pair.tokenY].filter(Boolean).join('–'),
    status: raw.isClosed ? 'closed' : 'open', opened_at: raw.createdAt ? raw.createdAt * 1000 : null,
    closed_at: raw.closedAt ? raw.closedAt * 1000 : null, lower_bin_id: finite(raw.lowerBinId),
    upper_bin_id: finite(raw.upperBinId), active_bin_id: finite(raw.poolActiveBinId), bin_step: finite(pair.binStep),
    deposit_sol: finite(raw.allTimeDeposits?.total?.sol), deposit_usd: finite(raw.allTimeDeposits?.total?.usd),
    withdraw_sol: finite(raw.allTimeWithdrawals?.total?.sol),
    fees_sol: finite(raw.allTimeFees?.total?.sol), pnl_sol: finite(raw.pnlSol), pnl_usd: finite(raw.pnlUsd),
    current_sol: finite(pnl?.balancesSol), unclaimed_sol: fees.every(value => value != null) ? fees[0] + fees[1] : null,
    in_range: typeof raw.isOutOfRange === 'boolean' ? Number(!raw.isOutOfRange) : null,
    strategy_label: opened?.label, strategy_source: opened?.label ? 'instruction' : null,
    confidence: opened?.label ? 1 : null, one_sided: opened ? Number(opened.transfers.length === 1) : null,
    width_pct: priceLow > 0 && priceHigh > 0 ? (priceHigh / priceLow - 1) * 100 : null,
    min_price: priceLow, max_price: priceHigh, last_checked_at: now,
  };
}

async function walletPositions(address, activity, now) {
  const query = { user: address, page: 1, page_size: 20 };
  const [open, closed] = await Promise.all([
    get('/portfolio/open', query), get('/portfolio', { ...query, days_back: 30 }),
  ]);
  const pools = new Map([...open.pools, ...closed.pools.filter(row => !open.pools.some(pool => pool.poolAddress === row.poolAddress))]
    .map(row => [row.poolAddress, row]));
  const result = await parallel([...pools.values()].slice(0, 12), 5, async pair => {
    const rows = [];
    for (let page = 1; page <= 2; page++) {
      const data = await get('/positions/' + pair.poolAddress + '/pnl', { user: address, page, page_size: 50 });
      rows.push(...data.positions.map(row => normalizePosition(row, pair, address, activity, now)));
      if (!data.hasNext) break;
    }
    return rows.filter(row => row.status === 'open' || row.closed_at >= now - 30 * DAY);
  });
  return { solPrice: finite(open.solPrice), positions: result.flatMap(row => row.value ?? []) };
}

async function qualifyingOpenings(positions, observed) {
  const groups = new Map();
  for (const row of positions.filter(row => row.status === 'open')) {
    const key = row.wallet + ':' + row.pool;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const eligible = [...groups.values()].flatMap(rows => {
    const depositUsd = rows.reduce((sum, row) => sum + (row.deposit_usd ?? 0), 0);
    return depositUsd >= PUBLIC_OPENING_MIN_USD ? rows.map(row => ({ row, depositUsd })) : [];
  });
  const results = await parallel(eligible.slice(0, 24), 4, async ({ row, depositUsd }) => {
    const result = await get('/positions/' + row.position_pubkey + '/historical', addEventsQuery);
    const initial = result.events?.find(event => event.eventType === 'add' && event.signature);
    if (!initial) return null;
    const amount = openingDepositUsd(result.events, initial.signature, row.position_pubkey, row.pool, row.wallet);
    if (amount == null || amount < PUBLIC_OPENING_MIN_USD) return null;
    const sampled = observed.get(row.position_pubkey);
    if (sampled?.signature === initial.signature && sampled.wallet === row.wallet && sampled.pool === row.pool) {
      return { ...sampled, depositUsd, openingDepositUsd: amount };
    }
    const tx = await rpc('getTransaction', [initial.signature, { encoding: 'jsonParsed', commitment: 'confirmed',
      maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION }]);
    if (tx?.transaction?.signatures?.[0] !== initial.signature || !tx.blockTime) return null;
    const opening = parsePositions(tx).find(event => event.kind === 'opened' && event.amounts.size &&
      event.position === row.position_pubkey && event.pool === row.pool && event.owner === row.wallet);
    if (!opening) return null;
    return { ...serializePublicOpening(opening, row.wallet, initial.signature, tx.blockTime * 1000),
      depositUsd, openingDepositUsd: amount };
  });
  return results.map(result => result.value).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

export async function refreshPublicSnapshot(db, { signal } = {}) {
  const now = Date.now();
  signal?.throwIfAborted();
  assertPublicDatabase(db);
  const [liquid, recent, middle, quieter, thin] = await Promise.all([
    get('/pools', { page_size: 24, sort_by: 'volume_24h:desc', filter_by: 'is_blacklisted=false && tvl>=10000' }),
    get('/pools', { page_size: 16, sort_by: 'pool_created_at:desc', filter_by: 'is_blacklisted=false && tvl>=1000 && volume_24h>=50000' }),
    get('/pools', { page_size: 16, sort_by: 'volume_24h:desc', filter_by: 'is_blacklisted=false && tvl>=5000 && volume_24h>=10000 && volume_24h<250000' }),
    get('/pools', { page_size: 16, sort_by: 'pool_created_at:desc', filter_by: 'is_blacklisted=false && tvl>=1000 && volume_24h>=1000 && volume_24h<10000' }),
    get('/pools', { page_size: 10, sort_by: 'pool_created_at:desc', filter_by: 'is_blacklisted=false && tvl>50 && volume_24h<100' }),
  ]);
  const active = liquid.data.map(row => poolData(row, now));
  const uniquePools = new Set();
  const groups = [
    ['Established active', liquid.data.filter(row => now - Number(row.created_at) >= 7 * DAY)],
    ['New active', recent.data], ['Mid-volume', middle.data], ['Lower-volume', quieter.data],
  ].map(([name, rows]) => {
    const selected = distinctPools(rows, uniquePools, 3);
    for (const pool of selected) uniquePools.add(pool.address);
    return [name, selected];
  });
  const scan = await samplePoolWhales(groups, now);
  const fallback = !scan.wallets.length;
  const events = fallback ? await sampledActivity(thin.data) : [];
  const wallets = fallback ? [...new Set(events.map(event => event.wallet))].slice(0, 8) : scan.wallets;
  if (!wallets.length) throw new Error('No candidates found in this public RPC sample; previous snapshot retained');
  const activity = new Map(events.map(event => [event.position, event]));
  const portfolios = await parallel(wallets, 3, address => walletPositions(address, activity, now));
  const positions = [...new Map([...scan.positions, ...portfolios.flatMap(row => row.value?.positions ?? [])]
    .map(row => [row.position_pubkey, row])).values()];
  const openings = await qualifyingOpenings(positions, activity);
  const openingByPosition = new Map(openings.map(event => [event.position, event]));
  const sampledPools = (fallback ? thin.data : groups.flatMap(([, rows]) => rows)).map(row => poolData(row, now));
  const allPools = new Map([...active, ...sampledPools].map(pool => [pool.address, pool]));
  const otherPools = [...new Set(positions.map(position => position.pool))]
    .filter(address => !allPools.has(address));
  const details = await parallel(otherPools, 6, address => get('/pools/' + address));
  for (const row of details) if (row.value) allPools.set(row.value.address, poolData(row.value, now));
  signal?.throwIfAborted();
  db.transaction(() => {
    for (const pool of allPools.values()) snapshot(db, pool, now);
    for (const wallet of wallets) {
      touchWallet(db, wallet, now);
      const walletRows = positions.filter(row => row.wallet === wallet);
      for (const row of walletRows) {
        const event = openingByPosition.get(row.position_pubkey);
        savePublicPosition(db, event?.label ? { ...row, strategy_label: event.label, strategy_source: 'instruction',
          confidence: 1, one_sided: Number(event.transfers.length === 1) } : row);
      }
      const closed = walletRows.filter(row => row.status === 'closed');
      const priced = closed.filter(row => row.pnl_sol != null && row.deposit_sol > 0);
      const pnl = priced.reduce((sum, row) => sum + row.pnl_sol, 0);
      const capital = priced.reduce((sum, row) => sum + row.deposit_sol, 0);
      db.prepare(`UPDATE wallets SET validation='public_sample',realized_pnl_sol=?,roi=?,win_rate=?,n_closed=?,
        avg_position_sol=? WHERE address=? AND current_rank IS NULL`).run(priced.length ? pnl : null, capital ? pnl / capital : null,
        priced.length ? priced.filter(row => row.pnl_sol > 0).length / priced.length : null, closed.length,
        priced.length ? capital / priced.length : null, wallet);
      refreshProfile(db, wallet, now);
    }
    const tokens = liquid.data.flatMap(pool => [pool.token_x, pool.token_y]);
    const sol = portfolios.find(row => row.value?.solPrice > 0)?.value.solPrice ??
      finite(tokens.find(token => token?.address === SOL)?.price);
    if (sol > 0) setMeta(db, 'sol_usd', sol);
    const usdc = finite(tokens.find(token => token?.address === USDC && finite(token.price) > 0)?.price);
    if (usdc > 0) setMeta(db, 'usdc_usd', usdc);
    setMeta(db, 'public_snapshot_at', now);
    setMeta(db, 'public_sample_pool_count', fallback ? thin.data.length : scan.pools);
    setMeta(db, 'public_sample_groups', JSON.stringify(fallback ? ['Recent low-activity fallback'] : scan.groups));
    setMeta(db, 'public_sample_pairs', scan.pairs);
    setMeta(db, 'public_sample_owners', JSON.stringify(scan.owners));
    setMeta(db, 'public_watch_pools', JSON.stringify(sampledPools.map(pool => pool.address)));
    for (const event of openings) savePublicOpening(db, event);
  }).immediate();
  return { pools: allPools.size, wallets: wallets.length,
    positions: positions.length, openings: openings.length, scannedPools: scan.pools, sampledPairs: scan.pairs, fallback };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const db = openDb(publicDatabasePath());
  refreshPublicSnapshot(db).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.close());
}
