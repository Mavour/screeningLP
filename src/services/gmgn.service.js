const { createClient } = require("../lib/http");
const logger = require("../lib/logger");

let disabledReason = null;

function enabled() {
  return Boolean(process.env.GMGN_API_KEY) && !disabledReason;
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
    const status = err.status || err.cause?.response?.status;
    if (status === 401 || status === 403) {
      disabledReason = status;
      logger.warn("gmgn disabled for this process (no API access)", { status });
      return null;
    }
    logger.warn("gmgn skip", { mint, err: err.message });
    return null;
  }
}

module.exports = { enabled, getTokenInfo };
