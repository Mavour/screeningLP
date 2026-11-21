import { SOL, USDC, finite } from './config.js';
import { http } from './clients/http.js';
import { isAddress } from './strategy/instructions.js';

const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const stableMints = new Set([USDC, USDT]);
const majorMints = new Map([[SOL, 'SOL'], [USDC, 'USDC'], [USDT, 'USDT'],
  ['98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', 'HYPE']]);

function marketMints(pool) {
  const mints = [pool.tokenX, pool.tokenY];
  if (!mints.every(isAddress) || mints[0] === mints[1]) return [];
  const nonStable = mints.filter(mint => !stableMints.has(mint));
  if (nonStable.length === 2 && nonStable.includes(SOL)) return nonStable.filter(mint => mint !== SOL);
  return nonStable.length ? nonStable : mints;
}

const indexedCap = (pool, mint) => mint === pool.tokenX ? pool.marketCapXUsd : pool.marketCapYUsd;

export function classifyOpeningMarket(pool, caps = new Map()) {
  const markets = marketMints(pool).map(mint => {
    const token = caps.get(mint);
    const isMajor = majorMints.has(mint);
    const meteoraCap = indexedCap(pool, mint);
    const cap = meteoraCap > 0 ? meteoraCap : token?.marketCapUsd ?? null;
    const marketCapSource = meteoraCap > 0 ? 'Meteora' : cap > 0 ? 'DEX Screener' : null;
    const tier = isMajor || cap > 50_000_000 ? 'SAVE' : cap >= 10_000_000 ? 'SEMI' : cap > 0 ? 'DEGEN' : null;
    const symbol = majorMints.get(mint) || (mint === pool.tokenX ? pool.tokenXSymbol : pool.tokenYSymbol) || token?.symbol || null;
    return { mint, symbol, marketCapUsd: cap, marketCapSource, tier, isMajor };
  });
  if (!markets.length || markets.some(market => !market.tier)) return null;
  // For a pair of non-quote assets, the smaller exposure drives the category.
  return markets.sort((a, b) => Number(a.isMajor) - Number(b.isMajor) ||
    (a.isMajor ? 0 : a.marketCapUsd - b.marketCapUsd))[0];
}

export function openingMarketLookup(signal) {
  const request = http('dex screener market cap', { rpm: 120, timeout: 4000, retries: 1, signal });
  return async pools => {
    const mints = [...new Set(pools.flatMap(pool => marketMints(pool).filter(mint => !(indexedCap(pool, mint) > 0))))].sort();
    const caps = new Map();
    for (let offset = 0; offset < mints.length; offset += 30) {
      const batch = mints.slice(offset, offset + 30);
      const pairs = await request('https://api.dexscreener.com/tokens/v1/solana/' + batch.join(','), { ttl: 60000 });
      if (!Array.isArray(pairs)) throw new Error('Invalid DEX Screener token response');
      for (const pair of pairs) {
        if (pair?.chainId !== 'solana') continue;
        const mint = pair.baseToken?.address;
        const cap = finite(pair.marketCap);
        const liquidity = finite(pair.liquidity?.usd) ?? 0;
        if (!batch.includes(mint) || !(cap > 0) || liquidity <= (caps.get(mint)?.liquidity ?? -1)) continue;
        caps.set(mint, { marketCapUsd: cap, symbol: pair.baseToken.symbol, liquidity });
      }
    }
    return new Map(pools.map(pool => [pool.address, classifyOpeningMarket(pool, caps)]));
  };
}
