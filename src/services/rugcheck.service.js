const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

function client() {
  const headers = {};
  if (process.env.RUGCHECK_API_KEY) {
    headers["X-API-KEY"] = process.env.RUGCHECK_API_KEY;
  }
  return createClient({
    baseURL: process.env.RUGCHECK_URL || "https://api.rugcheck.xyz",
    name: "rugcheck",
    headers,
  });
}

async function getReport(mint) {
  return client().get(`/v1/tokens/${mint}/report`);
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
