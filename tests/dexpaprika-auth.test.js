const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const paprika = require("../src/services/dexpaprika.service");

test("DexPaprika sends the raw API key on all endpoints and omits auth without a key", async () => {
  const previousKey = process.env.DEXPAPRIKA_API_KEY;
  const previousUrl = process.env.DEXPAPRIKA_URL;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.DEXPAPRIKA_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DEXPAPRIKA_API_KEY = "api_fixture_only_not_a_real_key";
  try {
    await paprika.getPool("fixture-pool");
    await paprika.getToken("fixture-token");
    await paprika.getOhlcv("fixture-pool", { start: "2026-11-12T00:00:00Z" });
    assert.equal(requests.length, 3);
    assert.ok(requests.every((req) => req.authorization === "api_fixture_only_not_a_real_key"));
    assert.match(requests[0].url, /^\/networks\/solana\/pools\/fixture-pool$/);
    assert.match(requests[1].url, /^\/networks\/solana\/tokens\/fixture-token$/);
    assert.match(requests[2].url, /^\/networks\/solana\/pools\/fixture-pool\/ohlcv\?/);
    delete process.env.DEXPAPRIKA_API_KEY;
    await paprika.getPool("fixture-pool");
    assert.equal(requests[3].authorization, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.DEXPAPRIKA_API_KEY;
    else process.env.DEXPAPRIKA_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.DEXPAPRIKA_URL;
    else process.env.DEXPAPRIKA_URL = previousUrl;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
