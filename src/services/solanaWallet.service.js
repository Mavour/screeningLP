const { Connection, PublicKey } = require("@solana/web3.js");
const logger = require("../lib/logger");
const { mapLimit } = require("../lib/http");

let connection;

function getConnection() {
  if (!connection) {
    connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
      commitment: "confirmed",
    });
  }
  return connection;
}

async function getHeldMints(walletAddress) {
  const conn = getConnection();
  const owner = new PublicKey(walletAddress);
  const res = await conn.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });
  const held = new Set();
  for (const acc of res.value) {
    const info = acc.account.data.parsed?.info;
    const amount = Number(info?.tokenAmount?.uiAmount || 0);
    if (amount > 0 && info?.mint) held.add(info.mint);
  }
  try {
    const t22 = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    });
    for (const acc of t22.value) {
      const info = acc.account.data.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmount || 0);
      if (amount > 0 && info?.mint) held.add(info.mint);
    }
  } catch (err) {
    logger.warn("token-2022 accounts skip", { walletAddress, err: err.message });
  }
  return held;
}

async function scanKolHoldings(wallets) {
  const list = wallets || [];
  const concurrency = Number(process.env.KOL_RPC_CONCURRENCY || 3);
  const holdings = [];

  const results = await mapLimit(list, concurrency, async (w) => {
    const mints = await getHeldMints(w.wallet);
    return { ...w, mints };
  });

  for (const r of results) {
    if (!r.ok) {
      logger.warn("KOL wallet check failed", { err: r.error.message });
      continue;
    }
    holdings.push(r.value);
  }
  return holdings;
}

function matchKol(holdings, mint) {
  const hits = { avoid: [], greenFlag: [] };
  for (const w of holdings) {
    if (w.mints.has(mint)) {
      hits[w.list]?.push({ label: w.label, wallet: w.wallet });
    }
  }
  return hits;
}

module.exports = { getHeldMints, scanKolHoldings, matchKol, getConnection };
