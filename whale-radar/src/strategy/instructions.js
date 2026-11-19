import { createRequire } from 'node:module';
import anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { mergeLabels } from './distribution.js';

const require = createRequire(import.meta.url);
// Anchor exposes BN through its CommonJS object, which Node may not detect as a named export.
const { BN, BorshAccountsCoder, BorshInstructionCoder } = anchor;
// The SDK's CJS entry works under Node 20+ without its extensionless ESM imports.
export const DLMM = require('@meteora-ag/dlmm');
export const { IDL } = DLMM;
export const PROGRAM = IDL.address;
export const MAX_TRANSACTION_VERSION = 1;
const coder = new BorshInstructionCoder(IDL);
const accountsCoder = new BorshAccountsCoder(IDL);
const specs = new Map(IDL.instructions.map(spec => [spec.name, spec]));
const tokenPrograms = new Set(['spl-token', 'spl-token-2022']);
const readKey = value => typeof value === 'string' ? value : value?.pubkey;

export function decodeInstruction(ix) {
  if (ix.programId !== PROGRAM || typeof ix.data !== 'string') return null;
  let decoded;
  try { decoded = coder.decode(ix.data, 'base58'); }
  catch { return null; }
  if (!decoded) return null;
  const spec = specs.get(decoded.name);
  const accounts = Object.fromEntries(spec.accounts.map((account, index) => [account.name, readKey(ix.accounts?.[index])]));
  const p = decoded.data.liquidity_parameter?.strategy_parameters;
  const variant = Object.keys(p?.strategy_type ?? {})[0]?.toLowerCase();
  const label = variant?.startsWith('bidask') ? 'BIDASK' : variant?.startsWith('spot') ? 'SPOT' : variant?.startsWith('curve') ? 'CURVE' : null;
  return { name: decoded.name, args: decoded.data, accounts, label,
    lower: p?.min_bin_id ?? decoded.data.lower_bin_id,
    upper: p?.max_bin_id ?? (decoded.data.width > 0 ? decoded.data.lower_bin_id + decoded.data.width - 1 : null) };
}

export function accountOwner(account) {
  if (account?.owner !== PROGRAM || account.data?.[1] !== 'base64') return null;
  const bytes = Buffer.from(account.data[0], 'base64');
  try {
    const name = IDL.accounts.find(entry => Buffer.from(entry.discriminator).equals(bytes.subarray(0, 8)))?.name;
    if (!['PositionV2', 'Position'].includes(name)) return null;
    return accountsCoder.decode(name, bytes).owner.toBase58();
  } catch { return null; }
}

export function isSignature(value) {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) return false;
  try { return bs58.decode(value).length === 64; }
  catch { return false; }
}

export function isAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try { return bs58.decode(value).length === 32; }
  catch { return false; }
}

function scope(tx) {
  const inner = new Map((tx.meta.innerInstructions ?? []).map(group => [group.index, group.instructions]));
  return tx.transaction.message.instructions.flatMap((instruction, index) => {
    const children = inner.get(index) ?? [];
    return [{ instruction, children }, ...children.map((child, offset) => {
      const descendants = [];
      if (child.stackHeight != null) {
        for (let i = offset + 1; i < children.length && children[i].stackHeight > child.stackHeight; i++) {
          descendants.push(children[i]);
        }
      }
      return { instruction: child, children: descendants };
    })];
  });
}

function transfers(children, accounts) {
  const pairs = [[accounts.user_token_x, accounts.reserve_x, accounts.token_x_mint],
    [accounts.user_token_y, accounts.reserve_y, accounts.token_y_mint],
    [accounts.user_token, accounts.reserve, accounts.token_mint]];
  const amounts = new Map();
  for (const ix of children) {
    if (!tokenPrograms.has(ix.program) || !['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(ix.parsed?.type)) continue;
    const info = ix.parsed.info;
    const pair = pairs.find(([source, dest, mint]) => source && dest && mint && info.source === source && info.destination === dest);
    if (!pair) continue;
    const mint = pair[2];
    if (info.mint && info.mint !== mint) continue;
    const amount = info.tokenAmount?.amount ?? info.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
    amounts.set(mint, (amounts.get(mint) ?? 0n) + BigInt(amount));
  }
  return amounts;
}

export function parsePositions(tx) {
  if (!tx?.meta || tx.meta.err || !Array.isArray(tx.transaction?.message?.instructions)) return [];
  const instructions = scope(tx).map(row => ({ ...row, decoded: decodeInstruction(row.instruction) })).filter(row => row.decoded);
  const initial = new Map(instructions.filter(row => row.decoded.name.startsWith('initialize_position'))
    .map(({ decoded }) => [decoded.accounts.position, decoded]));
  const decimals = new Map([...tx.meta.preTokenBalances ?? [], ...tx.meta.postTokenBalances ?? []]
    .filter(row => Number.isInteger(row.uiTokenAmount?.decimals)).map(row => [row.mint, row.uiTokenAmount.decimals]));
  const groups = new Map();
  for (const { decoded, children } of instructions) {
    const a = decoded.accounts;
    if (!decoded.name.startsWith('add_liquidity') || !a.position || !a.lb_pair) continue;
    const open = initial.get(a.position);
    const row = groups.get(a.position) ?? {
      position: a.position, pool: a.lb_pair, owner: open?.accounts.owner, sender: a.sender,
      kind: open ? 'opened' : 'added', lower: open?.lower ?? decoded.lower, upper: open?.upper ?? decoded.upper,
      label: null, amounts: new Map(), decimals,
    };
    row.label = mergeLabels(row.label, decoded.label);
    for (const [mint, amount] of transfers(children, a)) {
      if (amount > 0n) row.amounts.set(mint, (row.amounts.get(mint) ?? 0n) + amount);
    }
    groups.set(a.position, row);
  }
  return [...groups.values()];
}

export function openingRebalance(tx, position, step) {
  if (!tx?.meta || tx.meta.err || !Array.isArray(tx.transaction?.message?.instructions)) return null;
  const matches = scope(tx).map(row => decodeInstruction(row.instruction)).filter(row =>
    row?.name === 'rebalance_liquidity' && row.accounts.position === position.position_pubkey &&
    row.accounts.lb_pair === position.pool && row.args.params.adds.length);
  if (!matches.length) return null;
  const history = { strategy_label: 'Custom rebalance', strategy_source: 'instruction', confidence: 1 };
  const params = matches[0].args.params;
  if (matches.length !== 1 || !Number.isInteger(step) || step <= 0) return history;
  if (params.adds.reduce((width, add) => width + add.max_delta_id - add.min_delta_id + 1, 0) > DLMM.MAX_BINS_PER_POSITION.toNumber() ||
    params.adds.some(add => add.min_delta_id > add.max_delta_id)) return history;

  const bins = params.adds.flatMap(add => {
    const signed = (value, flag) => (add.bit_flag & flag) ? value.neg() : value;
    return DLMM.toAmountIntoBins(new BN(params.active_id), new BN(add.min_delta_id), new BN(add.max_delta_id),
      signed(add.delta_x, 4), signed(add.delta_y, 8), signed(add.x0, 1), signed(add.y0, 2),
      new BN(step), add.favor_x_in_active_id);
  });
  const hasX = bins.some(bin => bin.amountX.gtn(0));
  const hasY = bins.some(bin => bin.amountY.gtn(0));
  if (hasX === hasY || bins.some(bin => bin.amountX.isNeg() || bin.amountY.isNeg())) return history;
  return { ...history, one_sided: 1, openingAllocation: {
    at: tx.blockTime ? tx.blockTime * 1000 : null,
    bins: bins.map(bin => ({ id: bin.binId.toNumber(), liquidity: (hasX ? bin.amountX : bin.amountY).toString() })),
  } };
}

export function closurePositions(tx) {
  if (!tx?.meta || tx.meta.err || !Array.isArray(tx.transaction?.message?.instructions)) return [];
  return [...new Set(scope(tx).map(row => decodeInstruction(row.instruction))
    .filter(row => row?.name.startsWith('close_position') && row.accounts.position)
    .map(row => row.accounts.position))];
}
