import WebSocket from 'ws';
import { getMeta, setMeta, watchlist } from '../db.js';
import { parallel } from '../clients/http.js';
import { enqueue } from './worker.js';
import { PROGRAM } from '../strategy/instructions.js';

export function watchActivity(ctx, options = {}) {
  const { db, providers, settings, logger } = ctx;
  const addresses = options.addresses ?? (() => watchlist(db));
  const accepts = options.accepts ?? (logs => logs.some(line => line.startsWith('Program ' + PROGRAM + ' invoke')));
  const state = options.state ?? (() => {});
  const cursorPrefix = options.cursorPrefix ?? 'ws';
  const pageLimit = options.pageLimit ?? 10;
  const pageSize = options.pageSize ?? 100;
  let socket;
  let reconnect;
  let heartbeat;
  let lastPong = 0;
  let stopped = false;
  let watching = '';
  let configured = null;
  let lastStatus = 0;
  let syncing;
  const pending = new Set();

  function closeSocket() {
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    const old = socket;
    socket = undefined;
    if (old) old.terminate();
    watching = '';
  }

  async function reconcile(wallets) {
    return parallel(wallets, settings.concurrency, async wallet => {
      try {
        const key = cursorPrefix + '-cursor:' + wallet;
        const slotKey = cursorPrefix + '-slot:' + wallet;
        const previous = getMeta(db, key);
        let before;
        let newest;
        const signatures = [];
        for (let page = 0; page < pageLimit; page++) {
          const rows = await providers.signatures(wallet, { limit: pageSize, until: previous, before });
          if (!Array.isArray(rows)) throw new Error('Invalid signature page');
          if (!rows.length) break;
          newest ||= rows[0];
          // A new subscription starts at the current tip. Older history is indexed by backfill.
          if (!previous) break;
          signatures.push(...rows.filter(row => !row.err).map(row => row.signature));
          before = rows.at(-1).signature;
          if (rows.length < pageSize) break;
          if (page === pageLimit - 1 && !options.bounded) throw new Error('Reconnect reconciliation exceeded its page cap');
        }
        db.transaction(() => {
          enqueue(db, signatures.reverse());
          if (newest) {
            setMeta(db, key, newest.signature);
            if (newest.slot != null) setMeta(db, slotKey, newest.slot);
          }
        }).immediate();
        return true;
      } catch (error) {
        logger.warn({ wallet, reason: error.message }, 'WebSocket catch-up failed');
        return false;
      }
    });
  }

  function fallback(wallets) {
    const fingerprint = wallets.join(',');
    if (socket && fingerprint === watching) return;
    closeSocket();
    if (!wallets.length || stopped) return;
    watching = fingerprint;
    state('connecting', wallets.length);
    const stream = socket = new WebSocket(providers.websocketUrl(), { handshakeTimeout: 8000 });
    const subscriptions = new Map();
    const caughtUp = new Set();
    const received = new Map();
    stream.on('open', () => {
      lastPong = Date.now();
      for (const [i, wallet] of wallets.entries()) {
        stream.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe',
          params: [{ mentions: [wallet] }, { commitment: 'confirmed' }] }));
      }
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 45000 || subscriptions.size < wallets.length) stream.terminate();
        else {
          stream.ping();
          state('connected', wallets.length);
        }
      }, 30000);
    });
    stream.on('pong', () => { lastPong = Date.now(); });
    stream.on('message', data => {
      if (socket !== stream) return;
      let payload;
      try { payload = JSON.parse(data.toString()); }
      catch { return; }
      if (payload.id && payload.error) {
        logger.warn('RPC rejected a wallet subscription');
        stream.terminate();
        return;
      }
      if (wallets[payload.id - 1] && Number.isInteger(payload.result) && !subscriptions.has(payload.result)) {
        subscriptions.set(payload.result, wallets[payload.id - 1]);
        if (subscriptions.size === wallets.length) {
          state('connected', wallets.length);
          const work = reconcile(wallets).then(results => {
            if (socket !== stream) return;
            results.forEach((result, index) => {
              if (!result.value) return;
              const wallet = wallets[index];
              caughtUp.add(wallet);
              const latest = received.get(wallet);
              if (latest && latest.slot != null) {
                const key = cursorPrefix + '-slot:' + wallet;
                db.transaction(() => {
                  if (latest.slot > Number(getMeta(db, key) ?? 0)) {
                    setMeta(db, cursorPrefix + '-cursor:' + wallet, latest.signature);
                    setMeta(db, key, latest.slot);
                  }
                }).immediate();
              }
            });
          }).catch(error => logger.warn({ reason: error.message }, 'WebSocket cursor update failed'))
            .finally(() => pending.delete(work));
          pending.add(work);
        }
      }
      const value = payload.params?.result?.value;
      const wallet = subscriptions.get(payload.params?.subscription);
      if (!value || !wallet) return;
      const slot = payload.params.result.context?.slot;
      if (slot != null && slot > (received.get(wallet)?.slot ?? 0)) received.set(wallet, { signature: value.signature, slot });
      db.transaction(() => {
        if (!value.err && accepts(value.logs ?? [])) enqueue(db, [value.signature]);
        if (caughtUp.has(wallet) && slot != null) {
          const key = cursorPrefix + '-slot:' + wallet;
          if (slot > Number(getMeta(db, key) ?? 0)) {
            setMeta(db, cursorPrefix + '-cursor:' + wallet, value.signature);
            setMeta(db, key, slot);
          }
        }
      }).immediate();
    });
    stream.on('error', () => logger.warn('RPC WebSocket disconnected'));
    stream.on('close', () => {
      if (socket !== stream) return;
      clearInterval(heartbeat);
      socket = undefined;
      watching = '';
      if (!stopped) {
        state('reconnecting', 0);
        reconnect = setTimeout(() => fallback(addresses()), 5000);
      }
    });
  }

  async function sync() {
    const wallets = addresses();
    const fingerprint = wallets.join(',');
    if (!wallets.length) {
      closeSocket();
      state('idle', 0);
      return;
    }
    if (settings.webhookUrl) {
      try {
        let remote;
        if (configured !== fingerprint) {
          remote = await providers.syncWebhook(wallets);
          configured = fingerprint;
          lastStatus = 0;
          logger.info({ wallets: wallets.length }, 'Helius watchlist synchronized');
        } else if (Date.now() - lastStatus < 15 * 60000) {
          if (socket) fallback(wallets);
          return;
        } else {
          remote = await providers.webhookStatus();
          lastStatus = Date.now();
        }
        if (remote?.active !== false) {
          closeSocket();
          return;
        }
        logger.warn('Helius webhook is disabled; starting WebSocket fallback');
      } catch (error) {
        configured = null;
        logger.warn({ reason: error.message }, 'Watchlist sync failed; starting WebSocket fallback');
      }
    }
    fallback(wallets);
  }

  return {
    async sync() {
      if (settings.mock || stopped) return;
      syncing ??= sync().finally(() => { syncing = null; });
      return syncing;
    },
    async close() {
      stopped = true;
      closeSocket();
      await Promise.allSettled(pending);
    },
  };
}
