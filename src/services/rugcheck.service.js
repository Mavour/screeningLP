const { createClient, sleep } = require("../lib/http");
const logger = require("../lib/logger");

// Public API: at most one request per second, including concurrent scans/retries.
const PUBLIC_INTERVAL_MS = 1100;
let publicQueue = Promise.resolve();
let nextPublicAt = 0;

function client() {
  const headers = {};
  const key = process.env.RUGCHECK_API_KEY?.trim();
  if (key) headers["X-API-KEY"] = key;
  return createClient({
    baseURL: process.env.RUGCHECK_URL || "https://api.rugcheck.xyz",
    name: "rugcheck",
    headers,
    retryDelayMs: key ? 400 : PUBLIC_INTERVAL_MS,
  });
}

async function getReport(mint) {
  if (process.env.RUGCHECK_API_KEY?.trim()) return client().get(`/v1/tokens/${mint}/report`);
  const request = publicQueue.then(async () => {
    await sleep(Math.max(0, nextPublicAt - Date.now()));
    try {
      return await client().get(`/v1/tokens/${mint}/report`);
    } finally {
      nextPublicAt = Date.now() + PUBLIC_INTERVAL_MS;
    }
  });
  // A failed report must not block the next token in the queue.
  publicQueue = request.catch(() => {});
  return request;
}

function summarize(report) {
  if (!report) return null;
  const supply = Number(report.token?.supply || 0);
  const creatorBal = Number(report.creatorBalance || 0);
  const creatorPct = supply > 0 ? (creatorBal / supply) * 100 : 0;

  const topHolders = Array.isArray(report.topHolders) ? report.topHolders : [];
  const known = report.knownAccounts || {};
  const top10NoAmm = topHolders
    .filter((h) => {
      const typ = known[h.address]?.type || known[h.owner]?.type;
      return typ !== "AMM" && typ !== "LOCKER";
    })
    .slice(0, 10)
    .reduce((sum, h) => sum + Number(h.pct || 0), 0);

  const lockers = report.lockers || {};
  const lockedUsd = Object.values(lockers).reduce((s, l) => s + Number(l.usdLocked || l.lockedUsd || 0), 0);

  return {
    score: num(report.score),
    scoreNormalised: num(report.score_normalised),
    rugged: !!report.rugged,
    mintAuthority: report.mintAuthority ?? report.token?.mintAuthority ?? null,
    freezeAuthority: report.freezeAuthority ?? report.token?.freezeAuthority ?? null,
    creator: report.creator || null,
    creatorBalance: creatorBal,
    creatorPct,
    topHolders,
    top10HolderPct: top10NoAmm,
    totalLpProviders: num(report.totalLPProviders),
    graphInsidersDetected: num(report.graphInsidersDetected) || 0,
    lockedUsd,
    risks: Array.isArray(report.risks) ? report.risks : [],
  };
}

async function safeReport(mint) {
  try {
    const report = await getReport(mint);
    return summarize(report);
  } catch (err) {
    logger.warn("rugcheck skip", { mint, err: err.message });
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getReport, summarize, safeReport };
