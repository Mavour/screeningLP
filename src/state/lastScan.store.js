const { readJson, writeJson } = require("./jsonStore");

const FILE = "last-scan.json";

function load() {
  return readJson(FILE, {
    at: null,
    paused: false,
    heartbeat: null,
    scanned: 0,
    recommended: [],
    rejected: 0,
    errors: 0,
  });
}

function save(data) {
  writeJson(FILE, data);
  return data;
}

function setPaused(paused) {
  const cur = load();
  cur.paused = paused;
  return save(cur);
}

function heartbeat() {
  const cur = load();
  cur.heartbeat = new Date().toISOString();
  return save(cur);
}

function completeScan(summary, timeZone = "UTC") {
  const cur = load();
  const date = new Date(summary.at);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone });
  const day = formatter.format(date);
  const sameZone = cur.daily?.timeZone === timeZone;
  const trackingSince = sameZone && cur.dailyTrackingSince ? cur.dailyTrackingSince : summary.at;
  const previousScanned = sameZone && cur.daily.day === day ? cur.daily.scanned : 0;
  const previousSuccess = cur.lastSuccessAt || (!cur.errors && !cur.lastScanFailed ? cur.at : null);
  const found = new Map((cur.recommended || []).map(c => [c.poolAddress, c.foundAt || previousSuccess]));
  return save({
    ...cur,
    ...summary,
    paused: cur.paused,
    lastSuccessAt: summary.at,
    lastAttemptAt: summary.at,
    lastScanFailed: false,
    dailyTrackingSince: trackingSince,
    daily: {
      day,
      timeZone,
      scanned: (Number(previousScanned) || 0) + (Number(summary.scanned) || 0),
      complete: formatter.format(new Date(trackingSince)) !== day,
    },
    recommended: summary.recommended.map(c => ({ ...c, foundAt: found.get(c.poolAddress) || summary.at })),
  });
}

function failScan() {
  const cur = load();
  const at = new Date().toISOString();
  const lastSuccessAt = cur.lastSuccessAt || (!cur.errors && !cur.lastScanFailed ? cur.at : null);
  return save({ ...cur, lastSuccessAt, lastScanFailed: true, lastAttemptAt: at, lastErrorAt: at, errors: Math.max(1, Number(cur.errors) || 0) });
}

module.exports = { load, save, setPaused, heartbeat, completeScan, failScan };
