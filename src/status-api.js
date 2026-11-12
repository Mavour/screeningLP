const { createServer } = require("node:http");
const { createHash, timingSafeEqual } = require("node:crypto");

function readOptions(env = process.env) {
  const enabled = env.STATUS_API_ENABLED || "true";
  if (!["true", "false", "1", "0"].includes(enabled)) throw new Error("Invalid STATUS_API_ENABLED");
  const host = env.STATUS_API_HOST || "127.0.0.1";
  const port = Number(env.STATUS_API_PORT || 9001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid STATUS_API_PORT");
  const apiKey = env.STATUS_API_KEY || "";
  const scanStaleAfterSec = Number(env.STATUS_API_SCAN_STALE_AFTER_SEC || 1200);
  if (!Number.isFinite(scanStaleAfterSec) || scanStaleAfterSec < 60) throw new Error("Invalid STATUS_API_SCAN_STALE_AFTER_SEC");
  const dayTimeZone = env.STATUS_API_DAY_TIMEZONE || "UTC";
  new Intl.DateTimeFormat("en-CA", { timeZone: dayTimeZone }).format();
  const options = { enabled: enabled === "true" || enabled === "1", host, port, apiKey, scanStaleAfterSec, dayTimeZone };
  if (options.enabled) checkBinding(options);
  return options;
}

function checkBinding({ host, apiKey }) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !apiKey.trim()) {
    throw new Error("STATUS_API_KEY is required for a non-loopback STATUS_API_HOST");
  }
}

function number(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function text(value, max = 180) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function buildSnapshot({ scan = {}, config = {}, runtime, now = Date.now(), dayTimeZone = "UTC", scanStaleAfterSec = 1200 }) {
  const updatedAt = iso(runtime.heartbeatAt) || iso(runtime.startedAt) || "1970-01-01T00:00:00.000Z";
  const lastScanAt = iso(scan.lastSuccessAt) || (!scan.lastScanFailed && !scan.errors ? iso(scan.at) : null);
  const validLastScanAt = lastScanAt && Date.parse(lastScanAt) <= now ? lastScanAt : null;
  const alerts = [];
  const addAlert = (id, level, message, at = updatedAt) => alerts.push({ id, level, message, ts: at });
  let status = "ok";
  if (!validLastScanAt) {
    status = "warn";
    addAlert("scan-starting", "warn", "Menunggu hasil scan berhasil pertama");
  }
  if (scan.paused) {
    status = "warn";
    addAlert("scan-paused", "info", "Scanner dijeda melalui bot");
  }
  if (scan.lastScanFailed || Number(scan.errors) > 0) {
    status = "warn";
    addAlert("scan-errors", "warn", "Scan terakhir gagal atau sebagian sumber data bermasalah", iso(scan.lastErrorAt) || updatedAt);
  }
  if (validLastScanAt && now - Date.parse(validLastScanAt) > scanStaleAfterSec * 1000) {
    status = scan.paused ? "warn" : "error";
    addAlert("scan-stale", scan.paused ? "warn" : "critical", "Hasil screening sudah basi", validLastScanAt);
  }
  if (runtime.activeScans > 0 && iso(runtime.lastScanStartedAt) && now - Date.parse(runtime.lastScanStartedAt) > scanStaleAfterSec * 1000) {
    status = "error";
    addAlert("scan-stalled", "critical", "Scan berlangsung terlalu lama");
  }
  if (now - Date.parse(updatedAt) > 90_000) {
    status = "error";
    addAlert("worker-stale", "critical", "Heartbeat proses scanner basi");
  }
  if (runtime.stopping) status = "offline";

  const recommendations = Array.isArray(scan.recommended) ? scan.recommended : [];
  const seen = new Set();
  const candidates = [];
  let invalidCandidates = 0;
  const timeframe = scan.discoveryTimeframe || "24h";
  for (const c of recommendations) {
    const riskScore = number(c?.score);
    if (!c || !text(c.poolAddress) || !text(c.mint) || riskScore === null || riskScore < 0 || riskScore > 100) {
      invalidCandidates += 1;
      continue;
    }
    if (seen.has(c.poolAddress)) continue;
    seen.add(c.poolAddress);
    const foundAt = iso(c.foundAt) || validLastScanAt;
    if (!foundAt) continue;
    const tvl = number(c.tvl);
    const fees = number(c.fees24h);
    const feesKnown = c.fees24hKnown !== false && (c.fees24hKnown === true || fees > 0);
    const volume = number(c.volume24h);
    const volumeKnown = c.volume24hKnown !== false && (c.volume24hKnown === true || volume > 0);
    const apr = timeframe === "24h" && tvl > 0 && feesKnown && fees !== null && fees >= 0 ? fees / tvl * 365 * 100 : null;
    const quote = text(c.quoteSymbol, 40);
    const symbol = text(c.symbol || c.name, 60) || text(c.mint, 12);
    candidates.push({
      id: `pool-${text(c.poolAddress, 100)}`,
      poolAddress: text(c.poolAddress, 100),
      symbol,
      pair: quote ? `${symbol}/${quote}` : text(c.name, 100) || symbol,
      mint: text(c.mint, 100),
      ageHours: number(c.tokenAgeMinutes) === null ? null : number(c.tokenAgeMinutes) / 60,
      priceUsd: number(c.priceUsd) > 0 ? number(c.priceUsd) : null,
      liquidityUsd: tvl,
      volume24hUsd: timeframe === "24h" && volumeKnown ? volume : null,
      fdvUsd: number(c.fdvUsd) > 0 ? number(c.fdvUsd) : null,
      estFeeAprPct: apr === null || !Number.isFinite(apr) ? null : Math.round(apr * 100) / 100,
      aprBasis: "annualized_pool_fees_over_tvl_estimate",
      score: 100 - riskScore,
      riskScore,
      riskCategory: ["LOW", "MEDIUM", "HIGH"].includes(c.category) ? c.category : "UNKNOWN",
      safetyAssessmentComplete: false,
      reasons: ["Lolos filter scanner pada scan terakhir"],
      riskFlags: (Array.isArray(c.warnings) ? c.warnings : []).filter(w => typeof w === "string").slice(0, 12).map(w => text(w)),
      foundAt,
      url: /^https:\/\//.test(c.meteoraUrl || "") ? text(c.meteoraUrl, 300) : "",
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (invalidCandidates) {
    if (status === "ok") status = "warn";
    addAlert("candidate-data-invalid", "warn", `${invalidCandidates} kandidat tidak memiliki identitas atau skor risiko valid`);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: dayTimeZone }).format(new Date(now));
  const daily = scan.daily && scan.daily.timeZone === dayTimeZone ? scan.daily : null;
  const scannedToday = daily ? daily.day === today ? number(daily.scanned) : 0 : null;
  const filters = {
    minLiquidityUsd: number(config.minTvlUsd) ?? 0,
    minVolume24hUsd: number(config.minVolume24hUsd) ?? 0,
    maxFdvUsd: 0,
    fdvFilterEnabled: false,
    minAgeHours: (number(config.minTokenAgeMinutes) ?? 0) / 60,
    maxTokenAgeHours: (number(config.maxTokenAgeMinutes) ?? 0) / 60,
    maxTop10HolderPct: number(config.maxTop10HolderPct),
    maxDevBalancePct: number(config.maxDevBalancePct),
    maxRugcheckScore: number(config.maxRugcheckScore),
    requireMintRevoked: config.requireMintRevoked === true,
    requireFreezeRevoked: config.requireFreezeRevoked === true,
    rejectMeteoraBlacklisted: config.rejectMeteoraBlacklisted === true,
  };
  return {
    agentId: "alert",
    status,
    updatedAt,
    headline: (runtime.stopping ? "Scanner berhenti" : scan.paused ? "Scanner dijeda" : runtime.activeScans > 0 ? "Screening pool sedang berjalan" : `${recommendations.length} pool lolos screening terakhir`).slice(0, 80),
    metrics: {
      lastScanAt: validLastScanAt,
      lastAttemptAt: iso(scan.lastAttemptAt) || iso(scan.at),
      scannedToday,
      dailyTrackingSince: iso(scan.dailyTrackingSince),
      dailyCountComplete: !!daily && daily.day === today && daily.complete === true,
      dayTimeZone,
      scannedLastCycle: number(scan.scanned),
      passedFilters: recommendations.length,
      rejectedLastCycle: number(scan.rejected),
      errorsLastCycle: number(scan.errors),
      paused: !!scan.paused,
      scanning: runtime.activeScans > 0,
      scoreBasis: "100_minus_scanner_heuristic_risk",
      filters,
      candidates: candidates.slice(0, 12),
    },
    alerts,
    // Dorm derives coin_found from new candidate IDs; no duplicate explicit events.
    events: [],
  };
}

async function startStatusApi(options, getSnapshot) {
  checkBinding(options);
  const expected = createHash("sha256").update(`Bearer ${options.apiKey}`).digest();
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); };
    const actual = createHash("sha256").update(req.headers.authorization || "").digest();
    if (options.apiKey && !timingSafeEqual(actual, expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      send(401, { error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      send(405, { error: "Read-only API; use GET" });
      return;
    }
    const route = (req.url || "").split("?")[0];
    if (route !== "/status" && route !== "/health") { send(404, { error: "Not found" }); return; }
    try {
      const snapshot = getSnapshot();
      if (route === "/status") send(200, snapshot);
      else send(snapshot.status === "ok" ? 200 : 503, { ok: snapshot.status === "ok", agentId: "alert", status: snapshot.status, updatedAt: snapshot.updatedAt });
    } catch {
      send(503, { error: "Status unavailable" });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); });
  });
  return server;
}

module.exports = { readOptions, buildSnapshot, startStatusApi };
