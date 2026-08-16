const { readJson, writeJson } = require("./jsonStore");

const FILE = "seen-pools.json";

function load() {
  const data = readJson(FILE, { pools: {} });
  return data.pools || {};
}

function has(poolAddress) {
  return Boolean(load()[poolAddress]);
}

function mark(poolAddress, extra = {}) {
  const pools = load();
  pools[poolAddress] = { seenAt: new Date().toISOString(), ...extra };
  writeJson(FILE, { pools });
}

function clear() {
  writeJson(FILE, { pools: {} });
}

function size() {
  return Object.keys(load()).length;
}

module.exports = { load, has, mark, clear, size };
