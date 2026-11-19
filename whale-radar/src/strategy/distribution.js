import { finite } from '../config.js';

const mean = values => values.reduce((sum, item) => sum + item, 0) / values.length;
const unknown = { label: null, source: null, confidence: null };

export function distribution(bins, settings) {
  const ordered = [...bins].sort((a, b) => a.id - b.id);
  const oneSided = ordered.length && ordered.some(bin => finite(bin.x) > 0 || finite(bin.y) > 0)
    ? Number(!ordered.some(bin => finite(bin.x) > 0) || !ordered.some(bin => finite(bin.y) > 0)) : null;
  const all = ordered.map(bin => finite(bin.liquidity));
  const first = all.findIndex(value => value > 0);
  const last = all.findLastIndex(value => value > 0);
  const values = all.slice(first, last + 1);
  if (values.length < 5 || values.some(value => value == null || value < 0)) return { ...unknown, oneSided };
  const avg = mean(values);
  const cv = Math.sqrt(mean(values.map(value => (value - avg) ** 2))) / avg;
  const n = Math.max(1, Math.floor(values.length / 3));
  const centers = values.slice(n, -n);
  const left = mean(values.slice(0, n));
  const right = mean(values.slice(-n));
  const center = mean(centers);
  let label = 'MIXED';
  if (cv <= settings.uniform) label = 'SPOT';
  else if (center >= Math.max(left, right) * settings.concentration) label = 'CURVE';
  else if (Math.min(left, right) >= center * settings.concentration) label = 'BIDASK';
  return { label, source: 'distribution', confidence: label === 'MIXED' ? 0.45 : 0.7, oneSided };
}

export function binPrice(id, step, decimalsX, decimalsY) {
  if (![id, step, decimalsX, decimalsY].every(Number.isInteger) || step <= 0 || decimalsX < 0 || decimalsY < 0) return null;
  const price = Math.exp(id * Math.log1p(step / 10000)) * 10 ** (decimalsX - decimalsY);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function priceRange(lower, upper, step, dx, dy) {
  const low = binPrice(lower, step, dx, dy);
  const high = binPrice(upper, step, dx, dy);
  return { min_price: low, max_price: high, width_pct: low && high ? 100 * (high / low - 1) : null };
}

export function mergeLabels(...labels) {
  const parts = new Set(labels.filter(Boolean).flatMap(label => label.split('+')));
  return ['BIDASK', 'CURVE', 'SPOT', 'MIXED'].filter(part => parts.has(part)).join('+') || null;
}
