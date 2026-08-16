const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

function enabled() {
  return Boolean(process.env.GMGN_API_KEY);
}

function client() {
  return createClient({
    baseURL: process.env.GMGN_API_BASE || "https://gmgn.ai",
    name: "gmgn",
    headers: { "X-APIKEY": process.env.GMGN_API_KEY },
  });
}

async function getTokenInfo(mint) {
  if (!enabled()) return null;
  try {
    return await client().get("/vas/api/v1/token/info", {
      chain: "sol",
      address: mint,
    });
  } catch (err) {
    logger.warn("gmgn skip", { mint, err: err.message });
    return null;
  }
}

module.exports = { enabled, getTokenInfo };
