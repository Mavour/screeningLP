import { mergeLabels } from '../strategy/distribution.js';

const n = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '–';
const short = value => value.slice(0, 4) + '…' + value.slice(-4);
const poolUrl = value => 'https://app.meteora.ag/dlmm/' + encodeURIComponent(value);
const usd = value => Number.isFinite(value) ? 'US$' + n(value) : '–';
const pct = value => Number.isFinite(value) ? n(value, 6) + '%' : '–';

export function poolFacts(info) {
  return [
    'Bin Step ' + n(info.binStep, 0) + ' · Base fee ' + pct(info.baseFeePct) + ' · Dynamic fee ' + pct(info.dynamicFeePct),
    'TVL ' + usd(info.tvlUsd) + ' · Vol 24j ' + usd(info.volume24hUsd),
  ];
}

export function telegramMessages(alerts, publicUrl) {
  const groupSize = 12;
  const messages = [];
  for (let start = 0; start < alerts.length; start += groupSize) {
    const rows = alerts.slice(start, start + groupSize);
    const enriched = rows.map(row => ({ ...row, data: JSON.parse(row.detail) }));
    const first = enriched[0];
    const { data } = first;
    const group = new Map();
    for (const row of enriched) {
      const list = group.get(row.wallet) ?? [];
      list.push(row.data.label);
      group.set(row.wallet, list);
    }
    const label = enriched.every(row => row.data.smartLp) ? 'Smart LP' : 'tracked wallet';
    const heading = '🔔 ' + group.size + ' ' + label + (group.size > 1 ? 's' : '') + ' in ' + (data.name || short(first.pool));
    const lines = enriched.map(row => {
      const { data } = row;
      const label = mergeLabels(...group.get(row.wallet));
      const range = data.min_price && data.max_price ? 'range ' + n(data.min_price, 10) + '–' + n(data.max_price, 10) : 'range –';
      const qualification = data.walletDepositUsd == null ? '' : ' · $' + n(data.walletDepositUsd) + ' pool deposits';
      return (row.rank_at_alert ? 'Radar #' + row.rank_at_alert + ' ' : '') + short(row.wallet) + ' ' + data.kind + ' ' +
        (data.fullyPriced ? '' : '≥') + n(row.size_sol) + ' SOL · ' + range + ' · ' + (label || '–') +
        (data.strategySource === 'distribution' ? ' (estimated)' : '') + (data.oneSided ? ' · one-sided' : '') + qualification +
        (data.smartLp ? ' · Smart LP' : '');
    });
    const info = data.poolInfo;
    const text = [heading, ...lines, '', ...poolFacts({ ...info, tvlUsd: info.tvl, volume24hUsd: info.volume24 }),
      'Coin CA: ' + (data.tokenMint || '–'), 'FDV ' + usd(info.fdv) + ' · fee/TVL ' +
      (info.feeTvl == null ? '–' : n(info.feeTvl * 100) + '%'),
      'Risk flags: ' + (info.risks?.join(', ') || '–'), poolUrl(first.pool)].join('\n');
    const buttons = [{ text: 'Open pool', url: poolUrl(first.pool) }];
    if (data.tokenMint) {
      buttons.push({ text: 'Copy CA', copy_text: { text: data.tokenMint } },
        { text: 'Coin on GMGN', url: 'https://gmgn.ai/sol/token/' + encodeURIComponent(data.tokenMint) });
    }
    if (publicUrl) buttons.push({ text: 'Wallet profile', url: publicUrl.replace(/\/$/, '') + '/web/wallets/' + first.wallet });
    messages.push({ rows, message: { text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [buttons] } } });
  }
  return messages;
}
