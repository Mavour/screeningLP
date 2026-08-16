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

module.exports = { load, save, setPaused, heartbeat };
