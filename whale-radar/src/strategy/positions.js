import { PublicKey } from '@solana/web3.js';
import { DLMM, PROGRAM, accountOwner, openingRebalance, parsePositions } from './instructions.js';
import { distribution, priceRange } from './distribution.js';

export function positionTools(providers, settings, archive) {
  let connection;
  const readConnection = () => connection ??= providers.connection();
  return {
    async owner(position) {
      if (providers.positionOwner) return providers.positionOwner(position);
      const result = await providers.rpc('getAccountInfo', [position, { encoding: 'base64', commitment: 'confirmed' }], true);
      return accountOwner(result?.value);
    },
    async bins(wallet) {
      if (providers.bins) return providers.bins(wallet);
      const pools = await DLMM.getAllLbPairPositionsByUser(readConnection(), new PublicKey(wallet), {
        programId: new PublicKey(PROGRAM),
      });
      const result = new Map();
      for (const pool of pools.values()) {
        for (const row of pool.lbPairPositionsData) {
          const p = row.positionData;
          result.set(row.publicKey.toBase58(), {
            active: pool.lbPair.activeId, lower: p.lowerBinId, upper: p.upperBinId,
            step: pool.lbPair.binStep, dx: pool.tokenX.mint.decimals, dy: pool.tokenY.mint.decimals,
            bins: p.positionBinData.map(bin => ({
              id: bin.binId, x: bin.positionXAmount, y: bin.positionYAmount, liquidity: bin.positionLiquidity,
            })),
          });
        }
      }
      return result;
    },
    async positionBins(position) {
      if (providers.bins) return (await providers.bins(position.wallet)).get(position.position_pubkey);
      const pool = await DLMM.create(readConnection(), new PublicKey(position.pool), { programId: new PublicKey(PROGRAM) });
      const { positionData: row } = await pool.getPosition(new PublicKey(position.position_pubkey));
      if (row.owner.toBase58() !== position.wallet) throw new Error('Wallet does not own this position');
      return { active: pool.lbPair.activeId, lower: row.lowerBinId, upper: row.upperBinId, step: pool.lbPair.binStep,
        dx: pool.tokenX.mint.decimals, dy: pool.tokenY.mint.decimals,
        bins: row.positionBinData.map(bin => ({ id: bin.binId, x: bin.positionXAmount,
          y: bin.positionYAmount, liquidity: bin.positionLiquidity })) };
    },
    applyBins(position, snapshot) {
      if (!snapshot) return position;
      const { active, lower, upper, step, dx, dy, bins } = snapshot;
      const result = distribution(bins, settings.strategy);
      return { ...position, lower_bin_id: lower, upper_bin_id: upper, bin_step: step,
        active_bin_id: active, in_range: Number(active >= lower && active <= upper), observeRange: true,
        ...priceRange(lower, upper, step, dx, dy),
        strategy_label: result.label, strategy_source: result.source, confidence: result.confidence, one_sided: result.oneSided };
    },
    async historicalStrategy(position) {
      const signature = await providers.openingSignature?.(position.position_pubkey);
      if (!signature) return null;
      let tx = await providers.transaction(signature, false).catch(error => {
        if (!archive) throw error;
        return null;
      });
      if (!tx && archive) tx = await archive.transaction(signature, false);
      if (tx?.transaction?.signatures?.[0] !== signature) return null;
      const decoded = parsePositions(tx).find(row => row.position === position.position_pubkey && row.pool === position.pool);
      if (!decoded?.label) {
        const rebalance = openingRebalance(tx, position, position.bin_step);
        if (rebalance) return { ...rebalance, openingSignature: signature };
      }
      if (!decoded) return null;
      return { strategy_label: decoded.label, strategy_source: decoded.label ? 'instruction' : null,
        confidence: decoded.label ? 1 : null, one_sided: decoded.amounts.size ? Number(decoded.amounts.size === 1) : null,
        openingSignature: signature };
    },
  };
}
