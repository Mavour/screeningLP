const { QUOTE_MINTS } = require("./constants");

function pickBaseToken(tokenX, tokenY) {
  if (!tokenX) return tokenY;
  if (!tokenY) return tokenX;
  if (QUOTE_MINTS.has(tokenX.address) && !QUOTE_MINTS.has(tokenY.address)) return tokenY;
  return tokenX;
}

function pickQuoteToken(tokenX, tokenY) {
  const base = pickBaseToken(tokenX, tokenY);
  return base === tokenX ? tokenY : tokenX;
}

function ageMinutes(createdAt) {
  if (createdAt == null) return null;
  const n = Number(createdAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  return Math.max(0, (Date.now() - ms) / 60000);
}

function parseIsoAgeMinutes(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 60000);
}

function fmtUsd(n, digits = 0) {
  if (n == null || Number.isNaN(Number(n))) return "n/a";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(digits || 2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtPct(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return "n/a";
  return `${Number(n).toFixed(digits)}%`;
}

function fmtAge(minutes) {
  if (minutes == null) return "n/a";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(Number(n))) return "n/a";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function riskBadge(category) {
  if (category === "LOW") return "🟢 LOW";
  if (category === "HIGH") return "🔴 HIGH";
  return "🟡 MEDIUM";
}

function shortAddr(addr) {
  if (!addr) return "n/a";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  pickBaseToken,
  pickQuoteToken,
  ageMinutes,
  parseIsoAgeMinutes,
  fmtUsd,
  fmtPct,
  fmtAge,
  fmtNum,
  riskBadge,
  shortAddr,
  escapeHtml,
};
