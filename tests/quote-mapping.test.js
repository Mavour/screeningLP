const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../src/lib/http");
let pairs = [];
http.createClient = () => ({ get: async () => pairs });
const { bestPairLiquidity } = require("../src/services/dexscreener.service");

test("USD price and FDV are exported only for the requested Solana base mint", async () => {
  pairs = [{ pairAddress: "pool", chainId: "solana", baseToken: { address: "target" }, priceUsd: "1.25", fdv: 2000000, liquidity: { usd: 100000 } }];
  const right = await bestPairLiquidity("target", "pool");
  assert.equal(right.priceUsd, 1.25);
  assert.equal(right.fdvUsd, 2000000);
  const wrong = await bestPairLiquidity("other-mint", "pool");
  assert.equal(wrong.priceUsd, null);
  assert.equal(wrong.fdvUsd, null);
  pairs[0].chainId = "ethereum";
  assert.equal((await bestPairLiquidity("target", "pool")).priceUsd, null);
});

test("missing USD values stay unknown instead of being coerced to zero", async () => {
  pairs = [{ pairAddress: "pool", chainId: "solana", baseToken: { address: "target" }, priceUsd: null, fdv: null }];
  const value = await bestPairLiquidity("target", "pool");
  assert.equal(value.priceUsd, null);
  assert.equal(value.fdvUsd, null);
});
