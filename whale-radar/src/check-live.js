import pino from 'pino';
import { DAY, config } from './config.js';
import { createProviders } from './clients/providers.js';
import { verification } from './discovery/leaderboard.js';

async function main() {
  const settings = config();
  const usingPublicRpc = !settings.rpcUrl && !settings.heliusKey;
  if (usingPublicRpc) settings.rpcUrl = 'https://api.mainnet-beta.solana.com';
  const providers = createProviders(settings, pino({ level: 'silent' }), AbortSignal.timeout(120000));
  let failed = false;

  async function check(name, probe) {
    try {
      const { value, detail } = await probe();
      console.log('PASS ' + name + ' · ' + detail);
      return value;
    } catch (error) {
      failed = true;
      console.error('FAIL ' + name + ' · ' + error.message);
      return null;
    }
  }

  const [pools] = await Promise.all([
    check('Meteora pool discovery', async () => {
      const value = (await providers.poolList()).filter(pool => pool.address && !pool.blacklisted &&
        pool.volume24 >= settings.minVolume && pool.tvl >= settings.minTvl && pool.fees24 >= settings.minFees);
      if (!value.length) throw new Error('no eligible pools returned');
      return { value, detail: value.length + ' eligible pools' };
    }),
    check(usingPublicRpc ? 'Solana public RPC (probe only)' : 'Solana configured RPC', async () => {
      const slot = await providers.rpc('getSlot', [{ commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('invalid confirmed slot');
      return { detail: 'confirmed slot ' + slot };
    }),
  ]);
  const candidates = pools && await check('LP Agent top-lpers', async () => {
    let lastError;
    for (const pool of pools.slice(0, 3)) {
      try {
        const { ranks } = await providers.topLpers(pool.address);
        if (ranks.length) return { value: ranks, detail: ranks.length + ' owners from ' + pool.address };
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          const reason = !settings.lpKey ? 'LP_AGENT_API_KEY is missing' :
            'check API key validity and top-lpers entitlement';
          throw new Error('HTTP ' + error.status + ' (' + reason + ')');
        }
        lastError = error;
      }
    }
    throw lastError ?? new Error('no ranked owners in the first three eligible pools');
  });
  if (candidates) {
    const sample = await check('LP Agent closed positions', async () => {
      for (const { owner } of candidates.slice(0, 3)) {
        const rows = await providers.closedPositions(owner, Date.now() - settings.windowDays * DAY);
        const positions = rows.filter(row => Number.isFinite(row.pnl_sol) && row.deposit_sol > 0).slice(0, 5);
        if (positions.length) return { value: { owner, positions }, detail: rows.length + ' closed positions for ' + owner };
      }
      throw new Error('no priced closed positions in the top three sampled owners');
    });
    if (sample) await check('Meteora position PnL cross-check', async () => {
      const matches = await providers.crossCheck(sample.owner, sample.positions);
      const result = verification(matches, sample.positions.length, settings.pnlTolerance);
      const detail = matches.length + '/' + sample.positions.length + ' matched position IDs';
      if (result !== 'matched') throw new Error(result + ' (' + detail + ')');
      return { detail };
    });
    else console.log('SKIP Meteora position PnL cross-check · no priced LP Agent positions');
  } else {
    if (!pools) console.log('SKIP LP Agent top-lpers · no Meteora pools to probe');
    console.log('SKIP LP Agent history and Meteora position PnL · no candidates to probe');
  }
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('FAIL live preflight · ' + error.message);
  process.exitCode = 1;
});
