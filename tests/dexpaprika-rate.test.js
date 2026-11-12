const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const paprika = require("../src/services/dexpaprika.service");

test("DexPaprika serializes endpoints, honors Retry-After, survives quota failures and paces keyless calls", { timeout: 30000 }, async () => {
  const oldKey = process.env.DEXPAPRIKA_API_KEY;
  const oldUrl = process.env.DEXPAPRIKA_URL;
  const requests = [];
  let retried = false;
  const server = createServer((req, res) => {
    requests.push({ at: Date.now(), url: req.url, key: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/pools/retry") && !retried) {
      retried = true;
      res.setHeader("Retry-After", "3");
      res.writeHead(429); res.end('{"message":"rate limited"}');
    } else if (req.url.includes("/quota")) {
      res.writeHead(402); res.end('{"message":"credits exhausted"}');
    } else {
      res.end('{"ok":true}');
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.DEXPAPRIKA_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DEXPAPRIKA_API_KEY = "api_fixture_only";
  try {
    const results = await Promise.allSettled([
      paprika.getPool("retry"), paprika.getToken("quota"), paprika.getOhlcv("success"),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.status, 402);
    assert.equal(results[2].status, "fulfilled");
    assert.equal(requests.length, 4, "402 is not retried; failed requests do not poison the queue");
    assert.ok(requests[1].at - requests[0].at >= 2900, "Retry-After exceeds the normal two-second interval");
    for (let i = 2; i < requests.length; i++) assert.ok(requests[i].at - requests[i - 1].at >= 2000);
    assert.ok(requests.every((req) => req.key === "api_fixture_only"));
    delete process.env.DEXPAPRIKA_API_KEY;
    await paprika.getPool("anonymous");
    assert.equal(requests[4].key, undefined);
    assert.ok(requests[4].at - requests[3].at >= 4000, "keyless calls respect the lower 15/minute limit");
  } finally {
    if (oldKey === undefined) delete process.env.DEXPAPRIKA_API_KEY;
    else process.env.DEXPAPRIKA_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.DEXPAPRIKA_URL;
    else process.env.DEXPAPRIKA_URL = oldUrl;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
