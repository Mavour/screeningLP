const test = require("node:test");
const assert = require("node:assert/strict");
const { readOptions, buildSnapshot, startStatusApi } = require("../src/status-api");

const now = Date.parse("2026-11-12T00:30:00.000Z");
const at = new Date(now - 300000).toISOString();
const runtime = { startedAt: at, heartbeatAt: new Date(now - 1000).toISOString(), activeScans: 0, stopping: false };
const config = { minTvlUsd: 5000, minVolume24hUsd: 1000000, minTokenAgeMinutes: 60, requireMintRevoked: true, maxTop10HolderPct: 80, apiKey: "secret-must-not-leak" };
const candidate = (overrides = {}) => ({ poolAddress: "pool-a", mint: "mint-a", symbol: "TEST", quoteSymbol: "SOL", score: 20, category: "LOW", tvl: 100000, volume24h: 2000000, fees24h: 100, marketCap: 200000, tokenAgeMinutes: 120, warnings: ["Existing scanner warning"], meteoraUrl: "https://app.meteora.ag/dlmm/pool-a", ...overrides });
const scan = { at, lastSuccessAt: at, errors: 0, scanned: 50, rejected: 49, recommended: [candidate()], dailyTrackingSince: "2026-11-11T00:00:00.000Z", daily: { day: "2026-11-12", timeZone: "UTC", scanned: 200, complete: true } };
const input = { scan, config, runtime, now };

test("maps lower risk to higher display score, preserves native risk, and caps candidates at 12", () => {
  const recommended = Array.from({ length: 20 }, (_, i) => candidate({ poolAddress: `pool-${i}`, score: i * 4 }));
  recommended.push(recommended[0]);
  const s = buildSnapshot({ ...input, scan: { ...scan, recommended } });
  assert.equal(s.status, "ok");
  assert.equal(s.metrics.passedFilters, 21);
  assert.equal(s.metrics.candidates.length, 12);
  assert.equal(s.metrics.candidates[0].score, 100);
  assert.equal(s.metrics.candidates[0].riskScore, 0);
  assert.ok(s.metrics.candidates.every(c => c.score === 100 - c.riskScore));
  assert.ok(s.metrics.candidates.every((c, i, arr) => !i || c.score <= arr[i - 1].score));
  assert.equal(new Set(s.metrics.candidates.map(c => c.id)).size, 12);
  assert.ok(!JSON.stringify(s).includes("secret-must-not-leak"));
  assert.equal(s.events.length, 0);
});

test("unknown price and FDV remain null; market cap is not substituted for FDV", () => {
  const c = buildSnapshot(input).metrics.candidates[0];
  assert.equal(c.fdvUsd, null);
  assert.equal(c.priceUsd, null);
  assert.equal(c.ageHours, 2);
  assert.equal(c.estFeeAprPct, 36.5);
  assert.equal(c.safetyAssessmentComplete, false);
  assert.deepEqual(c.riskFlags, ["Existing scanner warning"]);
  const other = buildSnapshot({ ...input, scan: { ...scan, discoveryTimeframe: "1h" } });
  assert.equal(other.metrics.candidates[0].estFeeAprPct, null);
  assert.equal(other.metrics.candidates[0].volume24hUsd, null);
  assert.equal(other.metrics.filters.fdvFilterEnabled, false);
  const missing = buildSnapshot({ ...input, scan: { ...scan, recommended: [candidate({ fees24h: 0, volume24h: 0 })] } });
  assert.equal(missing.metrics.candidates[0].estFeeAprPct, null);
  assert.equal(missing.metrics.candidates[0].volume24hUsd, null);
  const knownZero = buildSnapshot({ ...input, scan: { ...scan, recommended: [candidate({ fees24h: 0, fees24hKnown: true })] } });
  assert.equal(knownZero.metrics.candidates[0].estFeeAprPct, 0);
});

test("candidate IDs and discovery times stay stable across HTTP polls", () => {
  const a = buildSnapshot(input);
  const b = buildSnapshot({ ...input, now: now + 20000 });
  assert.equal(a.metrics.candidates[0].id, b.metrics.candidates[0].id);
  assert.equal(a.metrics.candidates[0].foundAt, b.metrics.candidates[0].foundAt);
  assert.equal(a.updatedAt, b.updatedAt, "HTTP GET must not advance the process heartbeat");
});

test("bad scores or identity are excluded rather than silently labeled safe", () => {
  const s = buildSnapshot({ ...input, scan: { ...scan, recommended: [candidate({ score: null }), candidate({ score: false }), candidate({ score: " " }), candidate({ score: -1 }), candidate({ mint: "" })] } });
  assert.equal(s.status, "warn");
  assert.equal(s.metrics.candidates.length, 0);
  assert.ok(s.alerts.some(a => a.id === "candidate-data-invalid"));
});

test("scan cadence is separate from heartbeat; pause, failure, stale data and shutdown are visible", () => {
  assert.equal(buildSnapshot(input).status, "ok", "five-minute scans must not trip Dorm's two-minute stale timeout");
  assert.equal(buildSnapshot({ ...input, scan: { ...scan, paused: true } }).status, "warn");
  assert.equal(buildSnapshot({ ...input, scan: { ...scan, lastScanFailed: true } }).status, "warn");
  assert.equal(buildSnapshot({ ...input, scan: { ...scan, errors: 1 } }).status, "warn");
  assert.equal(buildSnapshot({ ...input, scan: { ...scan, lastSuccessAt: new Date(now - 1201000).toISOString() } }).status, "error");
  assert.equal(buildSnapshot({ ...input, runtime: { ...runtime, heartbeatAt: new Date(now - 91000).toISOString() } }).status, "error");
  assert.equal(buildSnapshot({ ...input, runtime: { ...runtime, stopping: true } }).status, "offline");
  const starting = buildSnapshot({ ...input, scan: {} });
  assert.equal(starting.status, "warn");
  assert.equal(starting.metrics.lastScanAt, null);
  assert.equal(starting.metrics.scannedToday, null);
});

test("daily counts use their persisted timezone and do not reuse yesterday's total", () => {
  assert.equal(buildSnapshot(input).metrics.scannedToday, 200);
  assert.equal(buildSnapshot({ ...input, scan: { ...scan, daily: { ...scan.daily, day: "2026-11-11" } } }).metrics.scannedToday, 0);
  assert.equal(buildSnapshot({ ...input, dayTimeZone: "Asia/Makassar" }).metrics.scannedToday, null);
});

test("HTTP requires Bearer auth and rejects control requests; failures are sanitized", async (t) => {
  let failed = false;
  const server = await startStatusApi({ host: "127.0.0.1", port: 0, apiKey: "test-key" }, () => {
    if (failed) throw new Error("private-provider-key");
    return buildSnapshot(input);
  });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: "Bearer test-key" };
  assert.equal((await fetch(base + "/status")).status, 401);
  assert.equal((await fetch(base + "/status", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const res = await fetch(base + "/status", { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).agentId, "alert");
  assert.equal((await fetch(base + "/health", { headers })).status, 200);
  assert.equal((await fetch(base + "/scan", { method: "POST", headers })).status, 405);
  assert.equal((await fetch(base + "/unknown", { headers })).status, 404);
  failed = true;
  const error = await fetch(base + "/status", { headers });
  assert.equal(error.status, 503);
  assert.ok(!(await error.text()).includes("private-provider"));
});

test("configuration defaults do not collide with ExitBot and unsafe public binds are rejected", () => {
  assert.equal(readOptions({}).port, 9001);
  assert.equal(readOptions({}).host, "127.0.0.1");
  assert.throws(() => readOptions({ STATUS_API_HOST: "0.0.0.0" }), /STATUS_API_KEY/);
  assert.throws(() => readOptions({ STATUS_API_PORT: "not-a-port" }));
  assert.throws(() => readOptions({ STATUS_API_SCAN_STALE_AFTER_SEC: "10" }));
  assert.throws(() => readOptions({ STATUS_API_DAY_TIMEZONE: "Bad/Zone" }));
});
