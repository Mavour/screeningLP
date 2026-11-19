import { readFileSync } from 'node:fs';
import anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { SOL, USDC, DAY } from '../config.js';
import { IDL, PROGRAM } from '../strategy/instructions.js';
import { normalizeLpPosition, normalizePool } from './providers.js';

const { BN, BorshInstructionCoder } = anchor;
const scenario = JSON.parse(readFileSync(new URL('../../fixtures/scenario.json', import.meta.url)));
const address = (number, suffix = 0) => {
  const b = Buffer.alloc(32, number);
  b.writeUInt32LE(suffix, 28);
  return bs58.encode(b);
};
export const mockSignature = bs58.encode(Buffer.alloc(64, 72));
export const mockWallet = address(scenario.wallets[0].seed);
export const mockPool = address(22);
export const mockPosition = address(23);
const mint = address(24);
const source = address(25);
const reserve = address(26);
const coder = new BorshInstructionCoder(IDL);

function instruction(name, args, keys) {
  const spec = IDL.instructions.find(item => item.name === name);
  return { programId: PROGRAM, accounts: spec.accounts.map(({ name }, index) => keys[name] ?? address(40 + index)),
    data: bs58.encode(coder.encode(name, args)) };
}

export function mockTransaction(now = Date.now()) {
  return {
    blockTime: Math.floor(now / 1000),
    transaction: { signatures: [mockSignature], message: { instructions: [
      instruction('initialize_position', { lower_bin_id: -6, width: 8 }, { position: mockPosition, lb_pair: mockPool, owner: mockWallet }),
      instruction('add_liquidity_by_strategy', { liquidity_parameter: {
        amount_x: new BN(0), amount_y: new BN(scenario.depositSol * 1e9), active_id: 2, max_active_bin_slippage: 2,
        strategy_parameters: { min_bin_id: -6, max_bin_id: 1, strategy_type: { BidAskOneSide: {} }, parameteres: Array(64).fill(0) },
      } }, { position: mockPosition, lb_pair: mockPool, sender: mockWallet,
        user_token_y: source, reserve_y: reserve, token_x_mint: mint, token_y_mint: SOL }),
    ] } },
    meta: { err: null, innerInstructions: [{ index: 1, instructions: [
      { program: 'spl-token', parsed: { type: 'transferChecked', info: { source, destination: reserve,
        mint: SOL, tokenAmount: { amount: String(scenario.depositSol * 1e9), decimals: 9 } } } },
    ] }], postTokenBalances: [{ mint: SOL, uiTokenAmount: { decimals: 9 } }] },
  };
}

export function mockProviders(now = Date.now()) {
  const wallets = new Map(scenario.wallets.map(row => [address(row.seed), row]));
  const samplePool = normalizePool({ address: mockPool, name: scenario.name, tvl: 70000,
    created_at: now - 15 * DAY, fees: { '1h': 320, '24h': 2200 }, volume: { '1h': 45000, '24h': 250000 },
    pool_config: { bin_step: scenario.binStep, base_fee_pct: 1 }, dynamic_fee_pct: 1.2, current_price: 0.001,
    token_x: { address: mint, decimals: 6, total_supply: 90000000, freeze_authority_disabled: true },
    token_y: { address: SOL, decimals: 9, freeze_authority_disabled: true } });
  const open = {
    tokenId: mockPosition, pool: mockPool, pairName: scenario.name, token0: mint, token1: SOL,
    tickLower: -6, tickUpper: 1, decimal0: 6, decimal1: 9, poolInfo: { tickSpacing: scenario.binStep },
    inputNative: scenario.depositSol, inputValue: scenario.depositSol * 150,
    valueNative: scenario.depositSol + 0.5, pnl: { valueNative: 0.5, value: 75 },
    unCollectedFeeNative: 0.02, protocol: 'meteora', owner: mockWallet, createdAt: new Date(now).toISOString(), inRange: false,
  };
  return {
    poolList: async () => [samplePool], pool: async () => samplePool,
    poolDetails: async pool => ({ ...pool, volume5: 4300, fdv: 1500000, organic: 80, takenAt: now, riskVerified: true }),
    topLpers: async () => ({ ranks: [...wallets.keys()].map((owner, i) => ({ owner, rank: i + 1 })), comparison: [] }),
    candles: async () => [],
    verifyClosedUniverse: async () => false,
    openPositions: async owner => owner === mockWallet ? [normalizeLpPosition(open, owner, 'open')] : [],
    closedPositions: async owner => {
      const wallet = wallets.get(owner);
      if (!wallet) return [];
      return Array.from({ length: wallet.closed }, (_, i) => {
        const closed = now - (1 + i) * DAY;
        const value = i % 5 === 0 ? -wallet.pnl / 3 : wallet.pnl * (1 - i / 100);
        return normalizeLpPosition({ ...open, owner, tokenId: address(wallet.seed + 70, i + 1),
          inputNative: wallet.deposit, outputNative: wallet.deposit + value, collectedFeeNative: 0.2,
          pnl: { valueNative: value, value: value * 150 }, closeAt: new Date(closed).toISOString(),
          createdAt: new Date(closed - DAY / 4).toISOString() }, owner, 'closed');
      });
    },
    crossCheck: async (_owner, rows) => rows.map(row => [row.pnl_sol, row.pnl_sol]),
    prices: async mints => Object.fromEntries(mints.map(m => [m, { usdPrice: m === SOL ? 150 : m === USDC ? 1 : 0.02 }])),
    activeDepositUsd: async (wallet, pool) => ({ usd: wallet === mockWallet && pool === mockPool ? open.inputValue : 0, indexed: true }),
    positionOwner: async position => position === mockPosition ? mockWallet : null,
    transaction: async signature => signature === mockSignature ? mockTransaction(now) : null,
    openingSignature: async position => position === mockPosition ? mockSignature : null,
    bins: async wallet => wallet === mockWallet ? new Map([[mockPosition, { active: 2, lower: -6, upper: 1,
      dx: 6, dy: 9, step: scenario.binStep,
      bins: scenario.bins.map((liquidity, i) => ({ id: i - 6, x: '0', y: String(liquidity), liquidity: String(liquidity) })),
    }]]) : new Map(),
    syncWebhook: async () => {},
    sendTelegram: async () => { throw new Error('Mock must use dry-run delivery'); },
  };
}
