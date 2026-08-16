const defaults = require("../../config/indicators.default");
const { readJson, writeJson } = require("./jsonStore");

const FILE = "user-config.json";

function load() {
  const saved = readJson(FILE, {});
  return { ...defaults, ...saved };
}

function save(config) {
  writeJson(FILE, config);
  return config;
}

function set(key, value) {
  const config = load();
  config[key] = value;
  return save(config);
}

function reset() {
  return save({ ...defaults });
}

module.exports = { load, save, set, reset };
