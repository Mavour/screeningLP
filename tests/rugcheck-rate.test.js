const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const rugcheck = require("../src/services/rugcheck.service");

test("public Rugcheck spaces concurrent calls and retries, recovers after failures, and preserves keyed auth", { timeout: 15000 }, async () => {
  const oldKey = process.env.RUGCHECK_API_KEY;
  const oldUrl = process.env.RUGCHECK_URL;
  const requests = [];
  let retried = false;
  const server = createServer((req, res) => {
    requests.push({ at: Date.now(), key: req.headers["x-api-key"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/retry/") && !retried) {
      retried = true;
      res.writeHead(429); res.end('{"message":"rate limited"}');
    } else if (req.url.includes("/failure/")) {
      res.writeHead(400); res.end('{"message":"test failure"}');
    } else if (req.headers["x-api-key"] === "fixture-invalid") {
      res.writeHead(401); res.end('{"message":"unauthorized"}');
    } else {
      res.end('{"score":123}');
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.RUGCHECK_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RUGCHECK_API_KEY = "  ";
  try {
    const results = await Promise.allSettled([
      rugcheck.getReport("retry"), rugcheck.getReport("failure"), rugcheck.getReport("success"),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[2].status, "fulfilled");
    assert.equal(results[2].value.score, 123);
    assert.equal(requests.length, 4);
    for (let i = 1; i < requests.length; i++) assert.ok(requests[i].at - requests[i - 1].at >= 1000, "every attempt respects public rate limit");
    assert.ok(requests.every((req) => req.key === undefined));
    process.env.RUGCHECK_API_KEY = "fixture-key";
    assert.equal((await rugcheck.getReport("keyed")).score, 123);
    assert.equal(requests[4].key, "fixture-key");
    process.env.RUGCHECK_API_KEY = "fixture-invalid";
    await assert.rejects(rugcheck.getReport("keyed"), (error) => error.status === 401);
    assert.equal(requests.length, 6, "invalid credentials are not silently retried anonymously");
  } finally {
    if (oldKey === undefined) delete process.env.RUGCHECK_API_KEY;
    else process.env.RUGCHECK_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.RUGCHECK_URL;
    else process.env.RUGCHECK_URL = oldUrl;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
