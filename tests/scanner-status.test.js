const test = require("node:test");
const assert = require("node:assert/strict");

// In-memory stores + stub providers: no runtime data, Telegram or network is touched.
const json = require("../src/state/jsonStore");
const data = new Map();
json.readJson = (name, fallback) => structuredClone(data.has(name) ? data.get(name) : fallback);
json.writeJson = (name, value) => data.set(name, structuredClone(value));
const logger = require("../src/lib/logger");
for (const key of ["info", "warn", "error", "debug"]) logger[key] = () => {};
const lastScan = require("../src/state/lastScan.store");
const runtime = require("../src/status-runtime");
const meteora = require("../src/services/meteora.service");
const paprika = require("../src/services/dexpaprika.service");
const rug = require("../src/services/rugcheck.service");
const dex = require("../src/services/dexscreener.service");
const gmgn = require("../src/services/gmgn.service");
const solana = require("../src/services/solanaWallet.service");
const pool = {
  pool_address: "fixture-pool", name: "TEST-SOL", pool_type: "dlmm", tvl: 100000,
  volume: 2000000, total_lps: 3, fee: 100, is_blacklisted: false,
  token_x: { address: "fixture-mint", symbol: "TEST", name: "Test", has_mint_authority: false, has_freeze_authority: false, dev_balance_pct: 0, top_holders_pct: 20 },
  token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
};
meteora.fetchDiscoveryPools = async () => [pool];
paprika.enrichPool = async () => ({ source: "token", lastPriceUsd: 1.2, volumes: {} });
rug.safeReport = async () => ({ scoreNormalised: 8, graphInsidersDetected: 0, rugged: false });
dex.bestPairLiquidity = async () => ({ priceUsd: 1.3, fdvUsd: 2000000 });
gmgn.getTokenInfo = async () => null;
solana.scanKolHoldings = async () => [];
solana.matchKol = () => ({ avoid: [], greenFlag: [] });
const { runScan } = require("../src/scanner");

test("scanner persists API fields without changing its native risk score or sending alerts", async () => {
  data.clear();
  const result = await runScan({ alert: false });
  assert.equal(result.scanned, 1);
  assert.equal(result.recommended.length, 1);
  assert.equal(result.recommended[0].verdict.score, 22);
  assert.equal(result.freshAlerts.length, 0);
  const saved = lastScan.load();
  assert.equal(saved.recommended[0].score, 22);
  assert.equal(saved.recommended[0].quoteSymbol, "SOL");
  assert.equal(saved.recommended[0].priceUsd, 1.3);
  assert.equal(saved.recommended[0].fdvUsd, 2000000);
  assert.equal(saved.daily.scanned, 1);
  assert.equal(saved.lastSuccessAt, saved.at);
  assert.equal(saved.daily.complete, false);
  assert.equal(runtime.get().activeScans, 0);
});

test("a failed scan preserves the last successful timestamp and candidates", async () => {
  const before = lastScan.load();
  const original = meteora.fetchDiscoveryPools;
  meteora.fetchDiscoveryPools = async () => { throw new Error("fixture-discovery-error"); };
  try { await assert.rejects(runScan({ alert: false }), /fixture-discovery-error/); }
  finally { meteora.fetchDiscoveryPools = original; }
  const after = lastScan.load();
  assert.equal(after.lastSuccessAt, before.lastSuccessAt);
  assert.deepEqual(after.recommended, before.recommended);
  assert.equal(after.lastScanFailed, true);
  assert.equal(after.daily.scanned, before.daily.scanned);
  assert.equal(runtime.get().activeScans, 0);
});

test("daily tracking accumulates, rolls over, and keeps discovery times stable", () => {
  data.clear();
  const summary = { at: "2026-11-11T18:00:00.000Z", scanned: 10, errors: 0, recommended: [{ poolAddress: "a" }], paused: false };
  const first = lastScan.completeScan(summary, "Asia/Makassar");
  assert.equal(first.daily.day, "2026-11-12");
  const second = lastScan.completeScan({ ...summary, at: "2026-11-11T19:00:00.000Z", scanned: 20 }, "Asia/Makassar");
  assert.equal(second.daily.scanned, 30);
  assert.equal(second.recommended[0].foundAt, first.recommended[0].foundAt);
  const next = lastScan.completeScan({ ...summary, at: "2026-11-12T18:00:00.000Z", scanned: 5 }, "Asia/Makassar");
  assert.equal(next.daily.scanned, 5);
  assert.equal(next.daily.complete, true);
  lastScan.setPaused(true);
  lastScan.completeScan({ ...summary, at: "2026-11-12T19:00:00.000Z" }, "Asia/Makassar");
  assert.equal(lastScan.load().paused, true, "a completed scan must not undo a user's pause");
});
