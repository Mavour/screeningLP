function ts() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const line = extra !== undefined ? `${ts()} [${level}] ${msg} ${safe(extra)}` : `${ts()} [${level}] ${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function safe(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  info: (msg, extra) => log("INFO", msg, extra),
  warn: (msg, extra) => log("WARN", msg, extra),
  error: (msg, extra) => log("ERROR", msg, extra),
  debug: (msg, extra) => {
    if (process.env.DEBUG) log("DEBUG", msg, extra);
  },
};
