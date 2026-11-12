const axios = require("axios");
const logger = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient({ baseURL, timeout = 20000, headers = {}, name = "http", retryDelayMs = 400 }) {
  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      Accept: "application/json",
      "User-Agent": "solana-lp-scanner/1.0",
      ...headers,
    },
  });

  async function request(config, attempt = 1) {
    try {
      const res = await client.request(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.headers?.["retry-after"];
      const seconds = retryAfter == null ? NaN : Number(retryAfter);
      const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
      const retryAfterMs = status === 429 && Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
      const retryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (retryable && attempt < 3) {
        const delay = Math.max(retryAfterMs, retryDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
        logger.warn(`${name} retry ${attempt} after ${delay}ms`, {
          url: config.url,
          status: status || err.code,
        });
        await sleep(delay);
        return request(config, attempt + 1);
      }
      // Queued callers may move to a fallback after this failure. Respect the
      // server cooldown even when the final retry has already been consumed.
      if (retryAfterMs > 0) await sleep(retryAfterMs);
      const message = err.response?.data?.message || err.message;
      const wrapped = new Error(`${name} ${config.method || "GET"} ${config.url} failed: ${message}`);
      wrapped.status = status;
      wrapped.cause = err;
      throw wrapped;
    }
  }

  return {
    get: (url, params, extra = {}) => request({ method: "GET", url, params, ...extra }),
    post: (url, data, extra = {}) => request({ method: "POST", url, data, ...extra }),
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { createClient, mapLimit, sleep };
