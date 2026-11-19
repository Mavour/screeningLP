import { setTimeout as delay } from 'node:timers/promises';

export class ProviderError extends Error {
  constructor(provider, status, reason = '') {
    super(provider + ' ' + (status || reason || 'network failure'));
    this.provider = provider;
    this.status = status;
  }
}

export function http(provider, { rpm, timeout = 8000, retries = 2, fetcher = fetch, signal }) {
  let next = 0;
  let blockedUntil = 0;
  let turn = Promise.resolve();
  const cache = new Map();

  async function request(url, { method = 'GET', headers, body, ttl = 0, key = String(url), retry = true } = {}) {
    const existing = ttl && cache.get(key);
    if (existing && existing.until > Date.now()) return existing.promise;
    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        const slot = turn.then(async () => {
          while (Math.max(next, blockedUntil) > Date.now()) {
            await delay(Math.max(next, blockedUntil) - Date.now(), undefined, { signal });
          }
          next = Date.now() + 60000 / rpm;
        });
        turn = slot.catch(() => {});
        await slot;
        try {
          const deadline = AbortSignal.timeout(timeout);
          const response = await fetcher(url, {
            method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          });
          if (!response.ok) {
            if (response.status === 429) {
              const after = response.headers.get('retry-after');
              const ms = after && (Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now());
              blockedUntil = Math.max(blockedUntil, Date.now() + (Number.isFinite(ms) ? Math.max(250, ms) : 1000));
            }
            await response.body?.cancel();
            throw new ProviderError(provider, response.status);
          }
          return await response.json();
        } catch (error) {
          const status = error.status;
          if (signal?.aborted || !retry || attempt >= retries || (status && status !== 429 && status < 500)) {
            throw new ProviderError(provider, status);
          }
          await delay(250 * 2 ** attempt + Math.random() * 200, undefined, { signal });
        }
      }
    })();
    if (ttl) {
      if (cache.size >= 2000) cache.delete(cache.keys().next().value);
      cache.set(key, { until: Date.now() + ttl, promise });
      promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
    }
    return promise;
  }

  return request;
}

export function url(base, path, params = {}) {
  const value = new URL(base + path);
  for (const [key, item] of Object.entries(params)) {
    if (item != null) value.searchParams.set(key, item);
  }
  return value;
}

export async function parallel(items, concurrency, operation) {
  let index = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      try { results[i] = { value: await operation(items[i], i) }; }
      catch (error) { results[i] = { error }; }
    }
  });
  await Promise.all(workers);
  return results;
}
