import { Connection } from '@solana/web3.js';
import { DAY, SOL, WHALE_DEPOSIT_USD, finite } from '../config.js';
import { http, url, ProviderError, parallel } from './http.js';
import { MAX_TRANSACTION_VERSION } from '../strategy/instructions.js';

const lpBase = 'https://api.lpagent.io/open-api/v1';
const meteoraBase = 'https://dlmm.datapi.meteora.ag';
const jupiterBase = 'https://api.jup.ag';
const solana = { chain: 'SOL', platform: 'meteora' };
const minute = 60000;
const poolPath = address => '/pools/' + encodeURIComponent(address);
const timestamp = value => typeof value === 'string' && !/^\d+$/.test(value)
  ? finite(Date.parse(value)) : finite(value) === null ? null : Number(value) * (Number(value) < 1e12 ? 1000 : 1);
const marketMint = (x, y) => x === SOL ? y : x;
const list = (data, provider) => {
  if (!Array.isArray(data)) throw new ProviderError(provider, null, 'response schema');
  return data;
};

export function normalizeLpPosition(row, wallet, status) {
  const opened = timestamp(row.createdAt);
  const closed = timestamp(row.closeAt ?? row.close_At);
  const position = row.tokenId;
  if (row.protocol !== 'meteora' || row.owner !== wallet || !position || !row.pool) return null;
  if (status === 'closed' && (!closed || !opened || closed < opened)) return null;
  return {
    position_pubkey: position, wallet, pool: row.pool, pool_name: row.pairName,
    token_mint: marketMint(row.token0, row.token1), status, opened_at: opened, closed_at: closed,
    lower_bin_id: finite(row.tickLower), upper_bin_id: finite(row.tickUpper),
    bin_step: finite(row.poolInfo?.tickSpacing), deposit_sol: finite(row.inputNative), deposit_usd: finite(row.inputValue),
    withdraw_sol: finite(row.outputNative), fees_sol: finite(row.collectedFeeNative),
    pnl_sol: finite(row.pnl?.valueNative ?? row.pnlNative), pnl_usd: finite(row.pnl?.value),
    current_sol: status === 'open' ? finite(row.valueNative) : null,
    unclaimed_sol: status === 'open' ? finite(row.unCollectedFeeNative) : null,
    in_range: status === 'open' && typeof row.inRange === 'boolean' ? Number(row.inRange) : null,
    decimalsX: finite(row.decimal0), decimalsY: finite(row.decimal1),
  };
}

export function normalizePool(row) {
  const x = row.token_x;
  const y = row.token_y;
  const token = x?.address === SOL ? y : x;
  const tvl = finite(row.tvl);
  const fees1 = finite(row.fees?.['1h']);
  const fees24 = finite(row.fees?.['24h']);
  const risks = [];
  if (row.is_blacklisted === true) risks.push('Meteora blacklist');
  if (token?.freeze_authority_disabled === false) risks.push('Freeze authority');
  return {
    address: row.address, name: row.name, tokenMint: token?.address, tokenX: x?.address, tokenY: y?.address,
    tokenXSymbol: x?.symbol, tokenYSymbol: y?.symbol,
    marketCapXUsd: finite(x?.market_cap), marketCapYUsd: finite(y?.market_cap),
    decimalsX: finite(x?.decimals), decimalsY: finite(y?.decimals), tvl, fees1, fees24,
    volume1: finite(row.volume?.['1h']), volume24: finite(row.volume?.['24h']),
    feeTvl: tvl > 0 && fees24 != null ? fees24 / tvl : null,
    feeTvl1: tvl > 0 && fees1 != null ? fees1 / tvl : null,
    apr: tvl > 0 && fees24 != null ? fees24 / tvl * 365 : null,
    createdAt: timestamp(row.created_at), binStep: finite(row.pool_config?.bin_step),
    baseFeePct: finite(row.pool_config?.base_fee_pct), dynamicFeePct: finite(row.dynamic_fee_pct),
    supply: finite(token?.total_supply), currentPrice: finite(row.current_price), risks,
    blacklisted: row.is_blacklisted === true,
  };
}

export function createProviders(settings, logger, signal) {
  const lpRequest = http('lpagent', { rpm: settings.lpRpm, timeout: 15000, signal });
  const mdRequest = http('meteora', { rpm: 240, signal });
  const jupRequest = http('jupiter', { rpm: settings.jupiterKey ? 60 : 30, timeout: 3000, retries: 1, signal });
  const helius = http('helius webhook management', { rpm: 60, signal });
  // Separate background and real-time RPC lanes, bounded to 9 requests/second combined.
  const urgentRpc = http('solana rpc', { rpm: 360, timeout: 5000, retries: 1, signal });
  const backgroundRpc = http('solana rpc background', { rpm: 180, timeout: 10000, signal });
  const telegram = http('telegram', { rpm: 30, timeout: 8000, retries: 0, signal });
  const webhookEndpoint = 'https://api-mainnet.helius-rpc.com/v0/webhooks/' + encodeURIComponent(settings.webhookId);
  const heliusHeaders = { authorization: 'Bearer ' + settings.heliusKey };
  const lp = (path, params, ttl = minute) => lpRequest(url(lpBase, path, params), {
    headers: { 'x-api-key': settings.lpKey }, ttl,
  });
  const md = (path, params, ttl = minute) => mdRequest(url(meteoraBase, path, params), { ttl });
  const jup = (path, params) => jupRequest(url(jupiterBase, path, params), {
    headers: settings.jupiterKey ? { 'x-api-key': settings.jupiterKey } : {}, ttl: minute,
  });
  const endpoint = settings.rpcUrl || (settings.heliusKey
    ? url('https://mainnet.helius-rpc.com', '/', { 'api-key': settings.heliusKey }).href : '');
  let rpcId = 0;
  const rpc = async (method, params, priority = false) => {
    const response = await (priority ? urgentRpc : backgroundRpc)(endpoint, {
      method: 'POST', body: { jsonrpc: '2.0', id: ++rpcId, method, params },
    });
    if (response.error || !Object.hasOwn(response, 'result')) throw new ProviderError('solana rpc', null, 'RPC response');
    return response.result;
  };

  async function openPositions(owner) {
    const response = await lp('/lp-positions/open', { ...solana, owner });
    return list(response.data, 'lpagent open').map(row => normalizeLpPosition(row, owner, 'open')).filter(Boolean);
  }

  async function closedPositions(owner, since) {
    const rows = [];
    for (let page = 1; page <= settings.historyPages; page++) {
      const response = await lp('/lp-positions/historical', { ...solana, owner, page, pageSize: 100 });
      const pageRows = list(response.data?.data, 'lpagent history');
      rows.push(...pageRows.map(row => normalizeLpPosition(row, owner, 'closed')).filter(row => row && (!since || row.closed_at >= since)));
      const total = response.data?.pagination?.totalPages;
      if (!Number.isSafeInteger(total) || total < 0) throw new ProviderError('lpagent history', null, 'pagination');
      if (page >= total) return [...new Map(rows.map(row => [row.position_pubkey, row])).values()];
    }
    throw new ProviderError('lpagent history', null, 'history page cap reached');
  }

  async function crossCheck(owner, positions) {
    const byPool = Map.groupBy ? Map.groupBy(positions, row => row.pool) : positions.reduce((result, row) => {
      if (!result.has(row.pool)) result.set(row.pool, []);
      result.get(row.pool).push(row);
      return result;
    }, new Map());
    const results = await parallel([...byPool], settings.concurrency, async ([pool, rows]) => {
      const targets = new Map(rows.map(row => [row.position_pubkey, row]));
      const matches = [];
      for (let page = 1; page <= settings.historyPages && targets.size; page++) {
        const data = await md('/positions/' + encodeURIComponent(pool) + '/pnl', { user: owner, status: 'closed', page, page_size: 100 });
        for (const p of list(data.positions, 'meteora pnl')) {
          const original = targets.get(p.positionAddress);
          if (!original || p.isClosed !== true || Math.abs((timestamp(p.closedAt) ?? 0) - original.closed_at) > minute) continue;
          const value = finite(p.pnlSol);
          if (value == null) continue;
          matches.push([original.pnl_sol, value, p, { tokenX: data.tokenX, tokenY: data.tokenY }]);
          targets.delete(p.positionAddress);
        }
        if (!data.hasNext) break;
      }
      return matches;
    });
    if (results.some(row => row.error)) throw results.find(row => row.error).error;
    return results.flatMap(row => row.value);
  }

  async function poolList() {
    const results = [];
    for (let page = 1; page <= settings.poolPages; page++) {
      try {
        const response = await md('/pools', { page, page_size: 100, sort_by: 'volume_24h:desc',
          filter_by: 'is_blacklisted=false && volume_24h>=' + settings.minVolume + ' && tvl>=' + settings.minTvl });
        results.push(...list(response.data, 'meteora pools').map(normalizePool));
        if (page >= response.pages) break;
      } catch (error) {
        if (!results.length) throw error;
        logger.warn({ reason: error.message, page }, 'Pool listing stopped after a provider error');
        break;
      }
    }
    return results;
  }

  async function tokenInfo(mint) {
    if (!mint) return null;
    const data = await jup('/tokens/v2/search', { query: mint });
    return list(data, 'jupiter tokens').find(item => item.id === mint) ?? null;
  }

  async function prices(mints) {
    const ids = [...new Set(mints)].sort().join(',');
    if (!ids) return {};
    return jup('/price/v3', { ids });
  }

  async function poolDetails(pool, include5m = false) {
    const result = await Promise.allSettled([tokenInfo(pool.tokenMint), prices([pool.tokenMint].filter(Boolean)),
      include5m ? volume5m(pool.address) : Promise.resolve(null)]);
    const [token, quoted, volume5] = result.map(row => row.value);
    const p = finite(quoted?.[pool.tokenMint]?.usdPrice);
    const supply = finite(token?.totalSupply);
    const risk = [...pool.risks];
    if (token?.audit?.mintAuthorityDisabled === false) risk.push('Mint authority');
    if (token?.audit?.freezeAuthorityDisabled === false && !risk.includes('Freeze authority')) risk.push('Freeze authority');
    if (finite(token?.audit?.topHoldersPercentage) > 40) risk.push('Top holders >40%');
    return { ...pool, fdv: p > 0 && supply > 0 ? p * supply : null, organic: finite(token?.organicScore),
      volume5: volume5 ?? null, risks: risk, riskVerified: Boolean(token?.audit), takenAt: Date.now() };
  }

  async function volume5m(pool) {
    const end = Math.floor(Date.now() / 300000) * 300;
    const response = await md(poolPath(pool) + '/volume/history', { timeframe: '5m', start_time: end - 600, end_time: end - 1 });
    const last = list(response.data, 'meteora volume history').find(row => timestamp(row.timestamp) === (end - 300) * 1000);
    return finite(last?.volume);
  }

  return {
    poolList, poolDetails, openPositions, closedPositions, crossCheck, prices, rpc,
    async activeDepositUsd(wallet, pool, eventPosition, eventTime) {
      let sum = 0;
      let indexed = false;
      for (let page = 1; page <= 10; page++) {
        const response = await md('/positions/' + encodeURIComponent(pool) + '/pnl',
          { user: wallet, status: 'open', page, page_size: 100 }, 0);
        for (const position of list(response.positions, 'meteora open positions')) {
          if (position.isClosed !== false) continue;
          sum += Math.max(0, finite(position.allTimeDeposits?.total?.usd) ?? 0);
          if (position.positionAddress === eventPosition && (!eventTime || (position.updatedAt ?? position.createdAt ?? 0) * 1000 >= eventTime)) {
            indexed = true;
          }
        }
        if (sum > WHALE_DEPOSIT_USD || response.hasNext !== true) break;
      }
      return { usd: sum, indexed };
    },
    pool: async address => normalizePool(await md(poolPath(address))),
    async topLpers(pool, sample = 0) {
      const ranks = [];
      let totalPages = 0;
      const read = page => lp(poolPath(pool) + '/top-lpers', { ...solana, page, limit: 20,
        order_by: 'total_pnl_native', sort_order: 'desc' });
      const rows = (response, page) => list(response.data, 'lpagent top-lpers').flatMap((row, i) =>
        row.chain === 'SOL' && row.protocol === 'meteora' ? [{ owner: row.owner, rank: (page - 1) * 20 + i + 1 }] : []);
      for (let page = 1; page <= settings.lpPages; page++) {
        const response = await read(page);
        totalPages = response.pagination?.totalPages ?? 0;
        ranks.push(...rows(response, page));
        if (response.pagination?.hasNextPage !== true) break;
      }
      const comparison = [];
      if (totalPages > settings.lpPages) {
        const page = settings.lpPages + 1 + sample % (totalPages - settings.lpPages);
        try {
          const candidates = rows(await read(page), page);
          if (candidates.length) comparison.push(candidates[sample % candidates.length]);
        } catch (error) {
          logger.warn({ pool, reason: error.message }, 'Comparison pool sample unavailable');
        }
      }
      return { ranks, comparison };
    },
    async candles(pool, timeframe, start, end, ttl = 15 * minute) {
      const response = await md(poolPath(pool) + '/ohlcv',
        { timeframe, start_time: Math.floor(start / 1000), end_time: Math.floor(end / 1000) }, ttl);
      return list(response.data, 'meteora OHLCV').flatMap(row => {
        const at = timestamp(row.timestamp);
        const close = finite(row.close);
        return at != null && close > 0 ? [{ at, close }] : [];
      }).sort((a, b) => a.at - b.at);
    },
    async positionEvents(position) {
      const response = await md('/positions/' + encodeURIComponent(position) + '/historical', { order_direction: 'asc' }, 60 * minute);
      return list(response.events, 'meteora position history');
    },
    async verifyClosedUniverse(owner, startsAt, endsAt, expected) {
      const days = Math.ceil((Date.now() - startsAt) / DAY) + 1;
      if (days > 365) return false;
      const pools = new Set();
      for (let page = 1; ; page++) {
        if (page > settings.historyPages) return false;
        const data = await md('/portfolio', { user: owner, days_back: Math.max(1, days), page, page_size: 50 });
        if (typeof data.hasNext !== 'boolean') return false;
        for (const row of list(data.pools, 'meteora closed portfolio')) {
          if (!row.poolAddress) return false;
          pools.add(row.poolAddress);
        }
        if (!data.hasNext) break;
      }
      const results = await parallel([...pools], settings.concurrency, async pool => {
        const ids = [];
        for (let page = 1; ; page++) {
          if (page > settings.historyPages) throw new Error('Meteora closed universe page limit');
          const data = await md('/positions/' + pool + '/pnl', { user: owner, status: 'closed', page, page_size: 100 });
          for (const row of list(data.positions, 'meteora closed universe')) {
            const closed = timestamp(row.closedAt);
            if (!row.positionAddress || row.isClosed !== true || closed == null) throw new Error('Incomplete closed position');
            if (closed > startsAt && closed <= endsAt) ids.push(row.positionAddress);
          }
          if (data.hasNext === false) return ids;
          if (data.hasNext !== true) throw new Error('Incomplete closed universe pagination');
        }
      });
      if (results.some(row => row.error)) return false;
      const seen = new Set(results.flatMap(row => row.value));
      return seen.size === expected.size && [...expected].every(id => seen.has(id));
    },
    connection: () => new Connection(endpoint, {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: async (input, init) => {
        const data = await backgroundRpc(input, { method: 'POST', body: JSON.parse(init.body) });
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      },
    }),
    websocketUrl: () => {
      if (settings.wsUrl) return settings.wsUrl;
      const url = new URL(endpoint);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    },
    async syncWebhook(wallets) {
      return helius(webhookEndpoint, {
        method: 'PUT', headers: heliusHeaders,
        body: { webhookURL: settings.webhookUrl, webhookType: 'enhanced', authHeader: settings.webhookSecret,
          accountAddresses: wallets, transactionTypes: ['ANY'] },
      });
    },
    webhookStatus: () => helius(webhookEndpoint, { headers: heliusHeaders }),
    async sendTelegram(message) {
      const data = await telegram('https://api.telegram.org/bot' + settings.telegramToken + '/sendMessage', {
        method: 'POST', body: { chat_id: settings.chatId, ...message }, retry: false,
      });
      if (data.ok !== true) throw new ProviderError('telegram', null, 'sendMessage failed');
    },
    async transaction(signature, priority = true) {
      return rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed',
        maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION }], priority);
    },
    async openingSignature(position) {
      const data = await md('/positions/' + encodeURIComponent(position) + '/historical',
        { event_type: 'add', order_direction: 'asc' }, 30 * minute);
      return list(data.events, 'meteora position events').find(event => event.eventType === 'add')?.signature;
    },
    async signatures(wallet, options) {
      return rpc('getSignaturesForAddress', [wallet, { ...options, commitment: 'confirmed' }]);
    },
    lookback: now => now - settings.windowDays * DAY,
  };
}
