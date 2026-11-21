const { readJson, writeJson } = require("./jsonStore");

const TIERS = ["DEGEN", "SEMI", "SAVE"];
const FILE = "radar-alert-filters.json";

function load() {
  const saved = readJson(FILE, {}) ?? {};
  return Object.fromEntries(TIERS.map(tier => [tier, {
    enabled: saved[tier]?.enabled !== false,
    enabledAt: Number.isSafeInteger(saved[tier]?.enabledAt) ? saved[tier].enabledAt : 0,
  }]));
}

function toggle(tier) {
  const filters = load();
  if (!TIERS.includes(tier)) return filters;
  const enabled = !filters[tier].enabled;
  filters[tier] = { enabled, enabledAt: enabled ? Date.now() : filters[tier].enabledAt };
  writeJson(FILE, filters);
  return filters;
}

module.exports = { TIERS, load, toggle };
