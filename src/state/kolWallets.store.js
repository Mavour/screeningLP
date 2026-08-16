const fs = require("fs");
const path = require("path");
const { readJson, writeJson } = require("./jsonStore");

const FILE = "kol-wallets.json";
const SEED = path.join(__dirname, "..", "..", "config", "kol-wallets.json");

function seedIfMissing() {
  const existing = readJson(FILE, null);
  if (existing) return existing;
  let seed = { avoid: [], greenFlag: [] };
  if (fs.existsSync(SEED)) {
    try {
      seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
    } catch {
      /* use empty */
    }
  }
  writeJson(FILE, seed);
  return seed;
}

function load() {
  const data = seedIfMissing();
  return {
    avoid: Array.isArray(data.avoid) ? data.avoid : [],
    greenFlag: Array.isArray(data.greenFlag) ? data.greenFlag : [],
  };
}

function save(data) {
  writeJson(FILE, data);
  return data;
}

function add({ label, wallet, list }) {
  const data = load();
  const target = list === "greenFlag" ? "greenFlag" : "avoid";
  const other = target === "avoid" ? "greenFlag" : "avoid";
  data[other] = data[other].filter((w) => w.wallet !== wallet);
  data[target] = data[target].filter((w) => w.wallet !== wallet);
  data[target].push({ label, wallet });
  return save(data);
}

function remove(wallet) {
  const data = load();
  data.avoid = data.avoid.filter((w) => w.wallet !== wallet);
  data.greenFlag = data.greenFlag.filter((w) => w.wallet !== wallet);
  return save(data);
}

function allTagged() {
  const data = load();
  return [
    ...data.avoid.map((w) => ({ ...w, list: "avoid" })),
    ...data.greenFlag.map((w) => ({ ...w, list: "greenFlag" })),
  ];
}

module.exports = { load, save, add, remove, allTagged };
