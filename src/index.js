require("dotenv").config();

const cron = require("node-cron");
const logger = require("./lib/logger");
const telegram = require("./services/telegram.service");
const { startBot } = require("./bot");
const { runScan } = require("./scanner");
const lastScan = require("./state/lastScan.store");
const rpc = require("./lib/rpc");
const userConfig = require("./state/userConfig.store");
const runtime = require("./status-runtime");
const { readOptions, buildSnapshot, startStatusApi } = require("./status-api");

const ONCE = process.argv.includes("--once");

async function startDashboardApi() {
  const options = readOptions();
  if (!options.enabled) return;
  try {
    runtime.heartbeat();
    const server = await startStatusApi(options, () => buildSnapshot({
      scan: lastScan.load(),
      config: userConfig.load(),
      runtime: runtime.get(),
      dayTimeZone: options.dayTimeZone,
      scanStaleAfterSec: options.scanStaleAfterSec,
    }));
    const heartbeat = setInterval(runtime.heartbeat, 30000);
    heartbeat.unref();
    server.on("error", (err) => logger.error("status API server error", { code: err.code || "UNKNOWN" }));
    const stop = () => {
      runtime.stopping();
      clearInterval(heartbeat);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    logger.info("read-only status API listening", { host: options.host, port: options.port });
  } catch (err) {
    logger.error("status API failed to start; scanner continues", { code: err.code || "CONFIG" });
  }
}

async function cycle() {
  try {
    const result = await runScan({ alert: true });
    if (result.paused) return;
    for (const item of result.freshAlerts || []) {
      try {
        await telegram.send(null, telegram.formatAlert(item));
      } catch (err) {
        logger.error("alert send failed", { err: err.message, pool: item.token?.poolAddress });
      }
    }
  } catch (err) {
    logger.error("scan cycle failed", { err: err.message });
    try {
      await telegram.send(null, `Scan cycle error: ${err.message}`);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  lastScan.heartbeat();
  logger.info("rpc endpoints", { urls: rpc.endpointList().map(rpc.label) });

  if (ONCE) {
    logger.info("single scan");
    const result = await runScan({ alert: false, force: true });
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          recommended: (result.recommended || []).map((r) => ({
            symbol: r.token.symbol,
            pool: r.token.poolAddress,
            vol24h: r.token.volume24h,
            volumes: r.token.volumes,
            tvl: r.token.tvl,
            totalLps: r.token.totalLps,
            volatility: r.token.volatility,
            dev: r.token.devBalancePct,
            score: r.verdict.score,
            category: r.verdict.category,
          })),
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.error("TELEGRAM_BOT_TOKEN missing — copy .env.example to .env");
    process.exit(1);
  }

  await startDashboardApi();
  startBot();

  const expr = process.env.SCAN_CRON || "*/5 * * * *";
  const timezone = resolveTimezone(process.env.SCAN_TIMEZONE);
  cron.schedule(
    expr,
    () => {
      cycle();
    },
    { timezone }
  );
  logger.info(`cron scheduled ${expr}`, { timezone });

  // first pass shortly after boot so /pools has data
  setTimeout(() => cycle(), 3000);
}

const OFFSET_TZ = {
  "UTC+7": "Asia/Jakarta",
  "UTC-7": "America/Denver",
  "GMT+7": "Asia/Jakarta",
  "UTC+8": "Asia/Singapore",
  "GMT+8": "Asia/Singapore",
  "UTC+9": "Asia/Tokyo",
  "GMT+9": "Asia/Tokyo",
  WIB: "Asia/Jakarta",
  WITA: "Asia/Makassar",
  WIT: "Asia/Jayapura",
};

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezone(raw) {
  const input = String(raw || "UTC").trim();
  const mapped = OFFSET_TZ[input.toUpperCase()] || OFFSET_TZ[input] || input;
  if (isValidTimezone(mapped)) return mapped;
  logger.warn(`invalid SCAN_TIMEZONE "${input}", falling back to UTC`);
  return "UTC";
}

main().catch((err) => {
  logger.error("fatal", { err: err.message });
  process.exit(1);
});
