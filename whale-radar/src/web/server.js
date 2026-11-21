import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import bcrypt from 'bcryptjs';
import radarAlertFilters from '../../../src/state/radarAlertFilters.store.js';
import { DAY } from '../config.js';
import { getMeta, latestPools, publicActivity, scheduleWallet } from '../db.js';
import { trending, whalePools } from '../intel/pools.js';
import { isAddress, isSignature } from '../strategy/instructions.js';
import { smartLpStatus } from '../discovery/smart-lp.js';
import { publicSmartLpReport, resetSmartLpFavorite } from '../discovery/public-leaderboard.js';
import { agentDormSnapshot, publicHealth, radarReport } from '../radar-report.js';
import { enqueue, webhookSignatures } from '../realtime/worker.js';

const css = readFileSync(new URL('./radar.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('./radar.js', import.meta.url), 'utf8');
const escape = input => String(input ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const num = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '–';
const pct = (value, digits = 2) => value == null ? '–' : num(value, digits) + '%';
const usd = n => n == null ? '–' : '$' + num(n);
const when = time => time ? new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–';
const age = value => value ? num((Date.now() - value) / DAY, 1) + ' d' : '–';
const metric = (text, source) => '<span title="' + escape(source) + '">' + text + '</span>';
const raw = value => escape(value ?? '–');
const displayUnit = value => value === 'USDC' || value === 'USD' ? 'USDC' : 'SOL';
const labels = ['SPOT', 'CURVE', 'BIDASK', 'MIXED'];
const tabs = [['Overview', ''], ['Wallets', '/wallets'], ['Smart LP', '/leaderboard'],
  ['Pools', '/pools'], ['Trending', '/trending'], ['Alerts', '/alerts']];
const symbols = ['◫', '◎', '★', '◈', '↗', '◷'];
const exportTables = ['wallets', 'positions', 'alerts', 'position_bins', 'wallet_strategy_profile', 'pool_snapshots',
  'pool_rank_observations', 'smart_lp_evaluations'];
const metricSources = {
  Rank: 'Whale Radar ranking', Score: 'Whale Radar scoring', PnL: 'Position provider realized or unrealized PnL',
  ROI: 'Whale Radar from SOL PnL and deposits', 'Win rate': 'Whale Radar from available closed positions',
  Closed: 'Closed positions in the available history', 'Avg size': 'SOL-equivalent deposits', 'Avg width': 'Meteora DLMM bin bounds',
  Strategy: 'Meteora DLMM instruction or bin distribution', Distribution: 'Meteora DLMM on-chain position bins',
  'Strategy / range': 'Meteora DLMM instructions and active bin', 'Strategy mix': 'Whale Radar from tracked position strategies',
  'Current size': 'Current SOL-equivalent position values', Deposits: 'Position deposits',
  Withdrawals: 'Position withdrawals', 'Claimed / unclaimed': 'Position fees',
  Size: 'Solana SPL transfers and Jupiter Price V3', FDV: 'Indexed token price multiplied by total supply',
  TVL: 'Meteora DLMM Data API', 'Volume 5m': 'Meteora last completed 5-minute volume candle',
  'Volume 1h': 'Meteora DLMM Data API', 'Volume 24h': 'Meteora DLMM Data API', 'Fees 24h': 'Meteora DLMM Data API',
  'Fee/TVL': 'Meteora 24-hour fees divided by current TVL', 'Fee APR est.': 'Whale Radar annualized 24-hour fee/TVL',
  'Bin Step': 'Meteora DLMM bin step. A value of 25 means 0.25% between adjacent bins.', 'Base / dynamic fee': 'Meteora DLMM Data API',
  'Base fee': 'Meteora DLMM base trading fee',
  'Dynamic fee': 'Meteora DLMM reported fee at the time of the snapshot, including base and variable fees',
  'Risk flags': 'Available token audit and pool flags', 'Tracked wallets': 'Whale Radar SQLite activity',
  'Deposit USD': 'USD deposits recorded by the position data provider',
  'Opening deposit': 'USD deposited into this position in its opening transaction, as indexed by Meteora',
};

function equal(a, b) {
  const one = Buffer.from(a);
  const two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}

const table = (headings, rows, positionTable = false) =>
  '<div class="scroll' + (positionTable ? ' position-table' : '') + '"><table><thead><tr>' +
  headings.map(name => '<th scope="col"' + (metricSources[name] ? ' title="' + escape(metricSources[name]) + '"' : '') +
    '>' + escape(name) + '</th>').join('') + '</tr></thead><tbody>' +
  (rows.length ? rows.map(row => '<tr>' + row.map((value, index) =>
    '<td' + (positionTable ? ' data-label="' + escape(headings[index]) + '"' : '') + '>' + value + '</td>').join('') + '</tr>').join('')
    : '<tr><td colspan="' + headings.length + '">No records found.</td></tr>') + '</tbody></table></div>';

const descriptions = {
  Overview: 'Meteora DLMM liquidity and wallet activity at a glance.',
  Wallets: 'Explore LP performance and open positions by wallet.',
  'Wallet profile': 'Position history, ranges, and liquidity strategy.',
  'Pools with tracked wallets': 'Open liquidity positions grouped by pool.',
  'Trending pools': 'Pools ranked by fees, volume momentum, liquidity, and wallet activity.',
  Alerts: 'Position openings and liquidity additions recorded by Whale Radar.',
  'Observed openings': 'Confirmed Meteora position openings sampled directly from Solana.',
  'Smart LP leaderboard': 'Radar ranking, source ranks, and results from the fixed follow-up window.',
};

function main(req, title, contents) {
  const unit = displayUnit(req.query.unit);
  const current = new URL(req.url, 'http://localhost');
  const path = current.pathname;
  const unitLinks = ['SOL', 'USDC'].map(option => {
    current.searchParams.set('unit', option);
    return '<a href="' + escape(path + current.search) + '"' + (option === unit ? ' aria-current="true"' : '') +
      (option === 'USDC' ? ' title="USDC equivalent at the latest available USDC/USD quote"' : '') + '>' + option + '</a>';
  }).join('');
  const health = req.publicHealth;
  const mode = health ? ({ live: 'LIVE · SOLANA', syncing: 'SYNCING', degraded: 'PARTIAL DATA', offline: 'WORKER OFFLINE' })[health.status] :
    req.radarMock ? 'MOCK DATA' : 'RADAR';
  const dashboardTabs = req.publicMode ? [...tabs.slice(0, -1), ['Openings', '/alerts']] : tabs;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escape(title) + ' · Whale Radar</title><link rel="stylesheet" href="/web/radar.css"><script defer src="/web/radar.js"></script></head>' +
    '<body' + (health ? ' data-radar-revision="' + escape(health.revision) + '"' : '') +
    '><aside class="rail"><a class="brand" href="/web"><span class="brand-mark" aria-hidden="true"><i></i></span>' +
    '<span>Whale Radar<small>METEORA DLMM</small></span></a><nav aria-label="Dashboard">' +
    dashboardTabs.map(([label, route], i) => '<a href="/web' + route + '?unit=' + unit + '"' +
      (path === '/web' + route || (route === '/wallets' && path.startsWith('/web/wallets/')) ? ' aria-current="page"' : '') +
      '><span aria-hidden="true" class="nav-symbol">' + symbols[i] + '</span>' + label + '</a>').join('') +
    '</nav><div class="rail-foot"><span class="network-dot"></span> Solana mainnet</div></aside>' +
    '<div class="workspace"><header class="topbar"><span class="scope"' +
    (health ? ' data-radar-state="' + health.status + '"' : '') + '><span class="network-dot"></span><span class="radar-state">' + mode +
    '</span>' + (health ? '<time title="Latest confirmed data update">' + when(health.latestDataAt) + '</time>' : '') + '</span>' +
    '<nav class="unit-switch" aria-label="PnL currency">' + unitLinks + '</nav></header>' +
    '<main><div class="page-heading"><h1>' + escape(title) + '</h1><p>' + escape(descriptions[title] || '') + '</p></div>' +
    contents + '</main></div></body></html>';
}

function linkWallet(wallet, req, tab) {
  return '<a class="mono" href="/web/wallets/' + encodeURIComponent(wallet) + '?unit=' +
    displayUnit(req.query.unit) + (tab ? '&amp;tab=' + tab : '') + '">' + escape(wallet.slice(0, 6) + '…' + wallet.slice(-5)) + '</a>' +
    ' <button type="button" class="copy" data-copy="' + escape(wallet) + '" aria-label="Copy wallet address">Copy</button>';
}
const poolLink = (address, name) => '<a href="https://app.meteora.ag/dlmm/' + encodeURIComponent(address) +
  '" rel="noreferrer">' + escape(name || address.slice(0, 10)) + '</a>';

function poolIdentity(address, name) {
  const short = address.slice(0, 4) + '…' + address.slice(-4);
  return poolLink(address, name) + '<br><small class="mono" title="' + escape(address) + '">' + escape(short) + '</small>';
}

function moneyValue(unit, db, sol, dollars) {
  if (unit === 'SOL') return sol;
  const solUsd = Number(getMeta(db, 'sol_usd'));
  const usdcUsd = Number(getMeta(db, 'usdc_usd'));
  const valueUsd = dollars ?? (sol != null && solUsd > 0 ? sol * solUsd : null);
  return valueUsd != null && usdcUsd > 0 ? valueUsd / usdcUsd : null;
}

function money(req, db, sol, dollars, tint = false) {
  const unit = displayUnit(req.query.unit);
  const value = moneyValue(unit, db, sol, dollars);
  const content = Number.isFinite(value) ? num(value) + ' ' + unit : '–';
  return tint ? signed(value, content) : content;
}

const source = req => req.publicMode ? 'Meteora DLMM Data API' : 'LP Agent';
const compactUsd = value => Number.isFinite(value) ? '$' +
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value) : '–';
const signed = (value, content) => value > 0 ? '<span class="gain">' + content + '</span>' :
  value < 0 ? '<span class="loss">' + content + '</span>' : content;

function publicActivityTable(req, rows, pools) {
  return table(['Wallet', 'Pool', 'LP coin', 'Opening deposit', 'Strategy', 'Time', 'Transaction'], rows.map(row => [
    linkWallet(row.wallet, req), poolLink(row.pool, pools.get(row.pool)?.name),
    row.alertMarket ? raw(row.alertMarket.symbol || row.alertMarket.mint) + ' <span class="badge">' + raw(row.alertMarket.tier) + '</span>' +
      (row.alertMarket.marketCapUsd == null ? '' : ' ' + compactUsd(row.alertMarket.marketCapUsd)) : '–',
    '<span class="gain">' + usd(row.openingDepositUsd) + '</span>',
    row.label ? '<span class="badge">' + raw(row.label) + '</span>' : '–', when(row.timestamp),
    '<a class="external" href="https://solscan.io/tx/' + encodeURIComponent(row.signature) + '" rel="noreferrer">Solscan ↗</a>',
  ]));
}

function publicWhaleList(db, req) {
  const pools = new Map(latestPools(db).map(pool => [pool.address, pool]));
  const wallets = new Map();
  for (const row of db.prepare('SELECT * FROM whale_deposits ORDER BY deposit_usd DESC,pool').all()) {
    if (!wallets.has(row.wallet)) wallets.set(row.wallet, { depositUsd: 0, positions: 0, pools: [] });
    const wallet = wallets.get(row.wallet);
    wallet.depositUsd += row.deposit_usd;
    wallet.positions += row.active_positions;
    wallet.pools.push(row);
  }
  const rows = [...wallets].sort(([a, left], [b, right]) => right.depositUsd - left.depositUsd || a.localeCompare(b));
  const note = '<p class="source-note">Expand each wallet’s pool list to see its deposits by pool. Totals include pools with more than US$2,000 in open-position deposits.</p>';
  return note + table(['Wallet', 'Qualifying pools', 'Total deposit USD', 'Active positions', 'Verification'], rows.map(([wallet, group]) => {
    const list = group.pools.map(row => '<li>' + poolIdentity(row.pool, pools.get(row.pool)?.name) +
      ' <span class="gain">' + usd(row.deposit_usd) + '</span></li>').join('');
    return [linkWallet(wallet, req), '<details class="wallet-pools"><summary>' + group.pools.length +
      (group.pools.length === 1 ? ' pool' : ' pools') + '</summary><ul>' + list + '</ul></details>',
      '<strong class="gain">' + usd(group.depositUsd) + '</strong>', num(group.positions), 'Observed whale'];
  }));
}

function poolRankRows(db, address) {
  return db.prepare(`SELECT r.* FROM pool_rank_observations r JOIN (
    SELECT pool,max(observed_at) AS latest FROM pool_rank_observations WHERE wallet=? GROUP BY pool
    ) t ON r.pool=t.pool AND r.observed_at=t.latest WHERE wallet=? ORDER BY rank,pool`).all(address, address);
}

function verificationLabel(evaluation) {
  if (evaluation.cohort === 'comparison') return 'Comparison cohort';
  if (evaluation.status === 'verified') return '<span class="badge">Verified Smart LP</span>';
  return ({ candidate: 'Candidate', pending: 'Candidate · in evaluation', insufficient: 'Insufficient evidence',
    inconclusive: 'Inconclusive', not_qualified: 'Did not qualify', stale: 'Verification expired' })[evaluation.status] ?? 'Unverified';
}

function evidencePanels(db, req, address) {
  const ranks = poolRankRows(db, address);
  const pools = new Map(latestPools(db).map(pool => [pool.address, pool.name]));
  const evaluation = smartLpStatus(db, address);
  const measurements = JSON.parse(evaluation.evidence ?? '{}');
  const history = db.prepare('SELECT * FROM smart_lp_evaluations WHERE wallet=? ORDER BY starts_at DESC').all(address);
  const result = '<p class="source-note">' + verificationLabel(evaluation) +
    (measurements.reason ? ' · ' + raw(measurements.reason.replaceAll('_', ' ')) : '') + '</p>';
  const periods = table(['Cohort','Start','End','Result','Excess vs hold','Positive weeks','Audited positions'], history.map(row => {
    const details = JSON.parse(row.evidence ?? '{}');
    return [raw(row.cohort), when(row.starts_at), when(row.ends_at), raw(row.status.replaceAll('_', ' ')),
      money(req, db, details.netExcess), num(details.positiveWeeks), num(details.benchmarked)];
  }));
  return result + '<div class="overview-grid">' + panel('Pool ranks', '', table(['Pool','Rank','Metric','Source','Observed'],
    ranks.map(rank => [poolLink(rank.pool, pools.get(rank.pool)), '#' + num(rank.rank), 'Total native PnL',
      raw(rank.provider), when(rank.observed_at)]))) + panel('Follow-up performance', '', periods) + '</div>';
}

function smartLeaderboard(db, req) {
  if (req.publicMode) {
    const { health, leaderboardAt, wallets, favorites } = publicSmartLpReport(db);
    const coverage = health ? num(health.measured) + ' / ' + num(health.candidates) + ' wallets measured · ' +
      num(health.incomplete) + ' incomplete · ' + num(health.eligible) + ' eligible · scan ' + raw(health.state) :
      'Waiting for the first Smart LP scan';
    const favoriteStatus = { queued: 'Queued for evaluation', history_unavailable: 'History unavailable · will retry',
      did_not_qualify: 'Ranking criteria not met', eligible: 'Eligible · unranked' };
    const favoriteRows = favorites.map(row => [linkWallet(row.wallet, req), favoriteStatus[row.status]]);
    return '<p class="source-note">Radar ranks Solana wallets using closed-position PnL from Meteora. ' +
      'Each ranked candidate is evaluated on a separate follow-up period.</p>' +
      '<p class="source-note">' + coverage + (health ? ' · ' + num(health.windowDays) + ' days · minimum ' +
        num(health.minClosed) + ' closes' : '') + ' · ranked ' + when(leaderboardAt) + '</p>' +
      (favoriteRows.length ? panel('Favorite wallets', '', table(['Wallet', 'Smart LP screening'], favoriteRows)) : '') +
      table(['Wallet','Radar rank','Score','Realized PnL','ROI','Win rate','Closed','Smart LP status'], wallets.map(row =>
        [linkWallet(row.wallet, req, 'closed') + (row.favorite ? ' <span title="Favorite">★</span>' : ''),
          num(row.rank), num(row.score), money(req, db, row.pnlSol, null, true),
          pct(row.roi * 100), pct(row.winRate * 100), num(row.closedPositions), verificationLabel(row)]));
  }
  const rows = db.prepare(`SELECT * FROM wallets WHERE is_blacklisted=0 AND (current_rank IS NOT NULL OR
    EXISTS(SELECT 1 FROM smart_lp_evaluations WHERE wallet=wallets.address AND cohort='candidate'))
    ORDER BY current_rank IS NULL,current_rank,address LIMIT 200`).all();
  const names = new Map(latestPools(db).map(pool => [pool.address, pool.name]));
  const comparative = db.prepare(`SELECT cohort,
    sum(status='verified') AS passed, sum(status IN ('verified','not_qualified')) AS conclusive,
    sum(status IN ('insufficient','inconclusive')) AS incomplete, sum(status='pending') AS pending
    FROM smart_lp_evaluations GROUP BY cohort ORDER BY cohort`).all();
  return table(['Wallet','Radar rank','Radar score','LP Agent pool rank','Rank observed','PnL cross-check','Smart LP status'], rows.map(row => {
    const best = poolRankRows(db, row.address)[0];
    return [linkWallet(row.address, req), num(row.current_rank), num(row.current_rank == null ? null : row.score),
      best ? '#' + num(best.rank) + ' · ' + poolLink(best.pool, names.get(best.pool)) : '–',
      when(best?.observed_at), raw(row.validation?.replaceAll('_', ' ')), verificationLabel(smartLpStatus(db, row.address))];
  })) + '<div class="overview-grid">' + panel('Follow-up outcomes by group', '',
    table(['Group','Passed','Conclusive','Incomplete','Pending'], comparative.map(group =>
      [raw(group.cohort), num(group.passed), num(group.conclusive), num(group.incomplete), num(group.pending)]))) + '</div>';
}

function panel(title, link, html) {
  return '<section class="panel"><div class="panel-heading"><h2>' + title + '</h2>' + link + '</div>' + html + '</section>';
}

function marketTable(pools) {
  const maximum = Math.max(1, ...pools.map(pool => pool.volume24 ?? 0));
  return table(['Pool', 'Volume 24h', 'TVL', 'Fee/TVL'], pools.map(pool => [
    '<div class="pool-name"><span class="pool-token" aria-hidden="true">' +
      raw((pool.tokenSymbol || pool.name || '?').slice(0, 2).toUpperCase()) + '</span> ' + poolLink(pool.address, pool.name) + '</div>',
    '<div class="bar-value">' + compactUsd(pool.volume24) + '<meter min="0" max="100" value="' +
      Math.round((pool.volume24 ?? 0) * 100 / maximum) + '"></meter></div>',
    compactUsd(pool.tvl), '<span class="gain">' + pct(pool.feeTvl == null ? null : pool.feeTvl * 100) + '</span>',
  ]));
}

function binRange(position) {
  const lo = position.lower_bin_id;
  const hi = position.upper_bin_id;
  const active = position.status !== 'closed' && Number.isInteger(position.active_bin_id) ? position.active_bin_id : null;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return '<div class="bin-range"><small>Range unavailable</small></div>';
  const min = Math.min(lo, active ?? lo) - 0.5;
  const max = Math.max(hi, active ?? hi) + 0.5;
  const offset = id => (100 * (id - min) / (max - min)).toFixed(3) + '%';
  const step = position.bin_step;
  const label = id => {
    if (active == null || !(step > 0)) return 'Bin ' + num(id, 0);
    const delta = Math.expm1((id - active) * Math.log1p(step / 10000)) * 100;
    if (!Number.isFinite(delta)) return 'Bin ' + num(id, 0);
    return (delta > 0 ? '+' : '') + pct(delta);
  };
  const outOfRange = active != null && (active < lo || active > hi);
  const state = position.status === 'closed' ? 'Closed' : active == null ? 'Active bin unavailable' :
    outOfRange ? 'Out of range' : 'In range';
  return '<div class="bin-range' + (outOfRange ? ' is-out-of-range' : '') +
    '"><div class="range-bounds"><span>' + label(lo) + '</span><span>' + label(hi) + '</span></div>' +
    '<div class="range-track" role="img" aria-label="' + escape('Bins ' + lo + ' to ' + hi +
      (active == null ? '' : ', active bin ' + active) + ', ' + state) + '">' +
    '<i class="range-fill" style="--lo:' + offset(lo - 0.5) + ';--hi:' + offset(hi + 0.5) + '"></i>' +
    (active == null ? '' : '<i class="range-marker" title="Active bin ' + active + '" style="--x:' + offset(active) + '"></i>') +
    '</div><small><span class="range-status">' + state + '</span>' +
    (active == null ? '' : ' · Active bin ' + num(active, 0)) + '</small></div>';
}

function liquidityChart(position, bins, observedAt, metric = 'Relative position liquidity') {
  const { lower_bin_id: lo, upper_bin_id: hi } = position;
  const active = position.status !== 'closed' && Number.isInteger(position.active_bin_id) ? position.active_bin_id : null;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) return '<small>Bin distribution unavailable</small>';
  const stride = Math.ceil((hi - lo + 1) / 110);
  const groups = Array.from({ length: Math.ceil((hi - lo + 1) / stride) }, (_, index) => ({
    lo: lo + index * stride, hi: Math.min(hi, lo + (index + 1) * stride - 1), liquidity: 0,
  }));
  for (const bin of bins) {
    const value = Number(bin.liquidity);
    if (Number.isInteger(bin.id) && bin.id >= lo && bin.id <= hi && Number.isFinite(value) && value > 0) {
      groups[Math.floor((bin.id - lo) / stride)].liquidity += value;
    }
  }
  const max = Math.max(...groups.map(group => group.liquidity));
  if (!max) return '<small>No liquidity currently funded in bins ' + num(lo, 0) + ' to ' + num(hi, 0) + '</small>';
  const outside = active != null && (active < lo || active > hi);
  const edge = active < lo ? 'left' : 'right';
  const marker = outside ? '<i class="bin-chart-marker ' + edge + '" title="Active bin ' + active +
    ' · ' + (edge === 'left' ? 'below' : 'above') + ' range"></i>' : '';
  const summary = metric + ' by ' + (stride === 1 ? 'bin' : 'bin group') +
    (outside ? ', active bin ' + active + (edge === 'left' ? ' below' : ' above') + ' range' : '');
  return '<div class="bin-chart" role="img" aria-label="' + escape(summary) + '">' + groups.map(group => {
    const relation = !Number.isInteger(active) ? '' : active > group.hi ? ' below' : active < group.lo ? ' above' : ' active';
    const title = 'Bin ' + group.lo + (group.hi === group.lo ? '' : ' to ' + group.hi) + ' · ' +
      pct(group.liquidity / max * 100, 1) + ' of peak';
    return '<i class="liquidity-bar' + relation + '" style="--weight:' + (group.hi - group.lo + 1) +
      ';--height:' + (group.liquidity / max * 100).toFixed(3) + '%" title="' + escape(title) + '"></i>';
  }).join('') + marker + '</div><small>Bins ' + num(lo, 0) + ' to ' + num(hi, 0) +
    (stride > 1 ? ' · grouped up to ' + stride + ' per bar' : '') + ' · ' + when(observedAt) + '</small>';
}

function positionStrategy(position) {
  const label = position.strategy_label?.replaceAll('BIDASK', 'BID-ASK');
  return label ? '<span class="badge">' + escape(label) + '</span>' +
    (position.strategy_source === 'instruction' ? (isSignature(position.openingSignature) ?
      ' <small><a href="https://solscan.io/tx/' + escape(position.openingSignature) +
      '" rel="noreferrer">Opening deposit</a></small>' : ' <small>Instruction</small>') :
      position.strategy_source === 'distribution' ? ' <small>Estimated from bins</small>' : '') :
    '<small>Strategy unknown</small>';
}

function positionRange(position, savedBins, canRead) {
  const actionable = position.status === 'open' && canRead;
  const lastSeen = savedBins[0]?.snapshot_at;
  return '<div class="position-range"><div class="range-strategy">' + positionStrategy(position) + '</div>' + binRange(position) +
    (actionable || savedBins.length ? '<details class="bin-details"' + (actionable ? ' data-position-bins="' +
      escape(position.position_pubkey) + '"' : '') + '><summary>' + (actionable ? 'On-chain bins' : 'Saved bin snapshot') +
      '</summary><div class="bin-detail-content" aria-live="polite">' +
      (savedBins.length ? liquidityChart(position, savedBins, lastSeen) : '') + '</div></details>' :
      '<small class="bin-unavailable">Bin snapshot unavailable</small>') + '</div>';
}

function alertsTable(db, req, rows) {
  return table(['Time', 'Wallet', 'Pool', 'Activity', 'Size', 'Strategy', 'Transaction'], rows.map(row => {
    const detail = JSON.parse(row.detail);
    return [when(row.sent_at ?? row.ready_at), linkWallet(row.wallet, req) + (detail.smartLp ? ' <span class="badge">Smart LP</span>' : ''), poolLink(row.pool, detail.name),
      raw(detail.kind), metric((detail.fullyPriced ? '' : '≥') + money(req, db, row.size_sol), 'Solana RPC · Jupiter Price'),
      raw(detail.label), '<a href="https://solscan.io/tx/' + encodeURIComponent(row.signature) + '" rel="noreferrer">Solscan</a>'];
  }));
}

function walletList(db, req) {
  const q = req.query;
  const sortKeys = { rank: 'coalesce(w.current_rank,999999)', score: 'w.score DESC',
    pnl: 'w.realized_pnl_sol DESC', roi: 'w.roi DESC', win: 'w.win_rate DESC', size: 'w.avg_position_sol DESC', seen: 'w.last_seen_at DESC' };
  const predicates = [];
  const args = [];
  if (q.q?.length) {
    predicates.push('(instr(w.address,?)>0 OR instr(lower(w.tags),lower(?))>0)');
    args.push(String(q.q).slice(0, 128), String(q.q).slice(0, 128));
  }
  const strategy = labels.indexOf(q.strategy);
  if (strategy >= 0) {
    const field = 's.pct_' + labels[strategy].toLowerCase();
    predicates.push(field + '>0 AND ' + field + '>=max(s.pct_spot,s.pct_curve,s.pct_bidask,s.pct_mixed)');
  }
  if (q.favorites === '1') predicates.push('w.is_favorite=1');
  if (q.hide === '1') predicates.push('w.is_blacklisted=0');
  if (q.inRange === '1') predicates.push("EXISTS(SELECT 1 FROM positions p WHERE p.wallet=w.address AND p.status='open' AND p.in_range=1)");
  for (const [key, column] of [['score', 'w.score'], ['size', 'w.avg_position_sol']]) {
    if (q[key] !== '' && Number.isFinite(Number(q[key]))) {
      predicates.push(column + '>=?');
      args.push(Number(q[key]));
    }
  }
  const page = Math.min(100000, Math.max(1, Math.trunc(Number(q.page) || 1)));
  const where = predicates.length ? 'WHERE ' + predicates.join(' AND ') : '';
  const sort = Object.hasOwn(sortKeys, q.sort) ? sortKeys[q.sort] : sortKeys.rank;
  const rows = db.prepare(`SELECT w.*,s.pct_spot,s.pct_curve,s.pct_bidask,s.pct_mixed,s.avg_width_pct FROM wallets w
     LEFT JOIN wallet_strategy_profile s ON s.wallet=w.address ${where} ORDER BY ${sort},w.address LIMIT 51 OFFSET ?`)
    .all(...args, (page - 1) * 50);
  const option = (value, text, selected) => '<option value="' + escape(value) + '"' + (selected ? ' selected' : '') + '>' + escape(text) + '</option>';
  const check = (key, label) => '<label class="check"><input type="checkbox" name="' + key + '" value="1"' +
    (q[key] === '1' ? ' checked' : '') + '>' + label + '</label>';
  const filters = '<form class="filters" method="get"><input type="hidden" name="unit" value="' + displayUnit(q.unit) + '">' +
    '<label>Search<input name="q" value="' + escape(q.q) + '" placeholder="Address or tag"></label>' +
    '<label>Strategy<select name="strategy">' + option('', 'All', !q.strategy) + labels.map(label => option(label, label, q.strategy === label)).join('') + '</select></label>' +
    '<label>Sort<select name="sort">' + Object.keys(sortKeys).map(key => option(key, key, q.sort === key)).join('') + '</select></label>' +
    '<label>Min score<input name="score" type="number" min="0" max="100" step="any" value="' + escape(q.score) + '"></label>' +
    '<label>Min size (SOL)<input name="size" type="number" min="0" step="any" value="' + escape(q.size) + '"></label>' +
    check('favorites', 'Favorites') + check('hide', 'Hide blacklisted') + check('inRange', 'In range') + '<button>Apply</button></form>';
  const paging = number => {
    const target = new URL(req.url, 'http://localhost');
    target.searchParams.set('page', number);
    return '<a href="' + escape(target.pathname + target.search) + '">' + (number < page ? 'Previous' : 'Next') + '</a>';
  };
  const content = rows.slice(0, 50).map(row => {
    const dominant = labels.map(label => [label, row['pct_' + label.toLowerCase()]]).sort((a, b) => b[1] - a[1])[0];
    return [linkWallet(row.address, req), num(row.current_rank), metric(num(row.score), 'Whale Radar · closed positions'),
      metric(money(req, db, row.realized_pnl_sol, null, true), source(req) + ' · SOL PnL'),
      signed(row.roi, pct(row.roi == null ? null : row.roi * 100)), pct(row.win_rate == null ? null : row.win_rate * 100), num(row.n_closed),
      dominant[1] == null ? '–' : '<span class="badge">' + dominant[0] + ' ' + pct(dominant[1]) + '</span>',
      money(req, db, row.avg_position_sol), pct(row.avg_width_pct), when(row.last_seen_at), row.is_favorite ? '★' : '–',
      row.is_blacklisted ? 'Yes' : '–', raw(row.tags)];
  });
  const columns = ['Wallet','Rank','Score','PnL','ROI','Win rate','Closed','Strategy','Avg size','Avg width','Last seen','Favorite','Blacklist','Tags'];
  return filters + table(columns, content) +
    '<div class="pages">' + (page > 1 ? paging(page - 1) : '') + (rows.length > 50 ? paging(page + 1) : '') + '</div>';
}

function walletDetail(db, req, w, csrf, canReadBins) {
  const tab = ['closed', 'alerts'].includes(req.query.tab) ? req.query.tab : 'open';
  const unit = displayUnit(req.query.unit);
  const profile = db.prepare('SELECT * FROM wallet_strategy_profile WHERE wallet=?').get(w.address);
  const candidate = req.publicMode && isPublicCandidate(db, w);
  const poolFilter = req.publicMode ? ' AND (' + (candidate ? "status='closed' OR " : '') +
    '(pool IN (SELECT pool FROM whale_deposits WHERE wallet=?) AND ' +
    "(status='closed' OR position_pubkey IN (SELECT position_pubkey FROM current_position_observations))))" : '';
  const walletArgs = req.publicMode ? [w.address, w.address] : [w.address];
  const averages = db.prepare(`SELECT avg(CASE WHEN status='closed' THEN (closed_at-opened_at)/60000.0 END) AS hold,
    avg(deposit_sol) AS size FROM positions WHERE wallet=?${poolFilter}`).get(...walletArgs);
  const editor = '<form class="filters" method="post"><input type="hidden" name="csrf" value="' + csrf +
    '"><label>Note<input name="note" maxlength="1000" value="' + escape(w.note) + '"></label>' +
    '<label>Tags<input name="tags" maxlength="240" value="' + escape(w.tags) + '"></label>' +
    '<label class="check"><input type="checkbox" name="favorite" value="1"' + (w.is_favorite ? ' checked' : '') + '>Favorite</label>' +
    '<label class="check"><input type="checkbox" name="blacklist" value="1"' + (w.is_blacklisted ? ' checked' : '') +
    '>Blacklist</label><button>Save</button></form>';
  const breakdown = labels.map(label => {
    const value = profile?.['pct_' + label.toLowerCase()];
    return '<label>' + label + ' ' + pct(value) + '<progress max="100" value="' + (value ?? 0) + '"></progress></label>';
  }).join('');
  const stats = '<div class="profile"><section>' + breakdown + '</section><section>' +
    '<div>Average width ' + pct(profile?.avg_width_pct) + '</div><div>One-sided ' + pct(profile?.pct_one_sided) +
    '</div><div>Observed in range ' + pct(profile?.pct_time_in_range) + '</div><div>Average hold ' + num(averages.hold) +
    ' min</div><div>Average deposit ' + money(req, db, averages.size) + '</div></section></div>';
  const links = '<nav class="tabs">' + [['open','Active'],['closed','Closed'],['alerts','Alerts']].map(([v, label]) =>
    '<a ' + (v === tab ? 'aria-current="page" ' : '') + 'href="?tab=' + v + '&amp;unit=' + unit + '">' + label + '</a>').join('') + '</nav>';
  let rows;
  if (tab === 'alerts') {
    rows = req.publicMode ? publicActivityTable(req, publicActivity(db).filter(row => row.wallet === w.address),
      new Map(latestPools(db).map(pool => [pool.address, pool]))) :
      alertsTable(db, req, db.prepare('SELECT * FROM alerts WHERE wallet=? AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 200').all(w.address));
  } else {
    const positions = db.prepare('SELECT * FROM positions WHERE wallet=?' + poolFilter + ' AND status=? ORDER BY coalesce(closed_at,opened_at) DESC LIMIT 200')
      .all(...walletArgs, tab);
    const pool = new Map(latestPools(db).map(p => [p.address, p]));
    const binsFor = db.prepare('SELECT bin_id AS id, liquidity, snapshot_at FROM position_bins WHERE position_pubkey=? ORDER BY bin_id');
    const rendered = positions.map(p => {
      const info = pool.get(p.pool);
      const flags = info?.risks?.join(', ');
      return [poolLink(p.pool, p.pool_name) + (flags ? '<br><small>' + raw(flags) + '</small>' : ''),
        metric(usd(info?.fdv) + ' / ' + usd(info?.tvl), (info?.fdvSource || 'Jupiter') + ' price × supply · Meteora TVL'),
        positionRange(p, binsFor.all(p.position_pubkey), canReadBins),
        metric(money(req, db, p.pnl_sol, p.pnl_usd, true), source(req) + ' · Position PnL'), when(p.opened_at) + '<br><small>' +
        (p.closed_at && p.opened_at ? num((p.closed_at - p.opened_at) / DAY, 1) + ' d' : age(p.opened_at)) + '</small>',
        money(req, db, p.deposit_sol, p.deposit_usd), money(req, db, p.withdraw_sol),
        money(req, db, p.fees_sol) + ' / ' + money(req, db, p.unclaimed_sol)];
    });
    if (positions.length) {
      const totals = db.prepare(`SELECT sum(pnl_sol) AS pnl_sol,sum(pnl_usd) AS pnl_usd,sum(deposit_sol) AS deposit_sol,
        sum(deposit_usd) AS deposit_usd,sum(withdraw_sol) AS withdraw_sol,sum(fees_sol) AS fees_sol,sum(unclaimed_sol) AS unclaimed_sol
        FROM positions WHERE wallet=?${poolFilter} AND status=?`).get(...walletArgs, tab);
      rendered.push(['<strong>Total</strong>', '', '', money(req, db, totals.pnl_sol, totals.pnl_usd), '',
        money(req, db, totals.deposit_sol, totals.deposit_usd), money(req, db, totals.withdraw_sol),
        money(req, db, totals.fees_sol) + ' / ' + money(req, db, totals.unclaimed_sol)]);
    }
    rows = table(['Pool','FDV / TVL','Strategy / range','PnL','Opened / age','Deposits','Withdrawals','Claimed / unclaimed'], rendered, true);
  }
  const scope = req.publicMode
    ? (candidate ? '<p class="source-note">Ranked history uses closed positions across indexed pools. Active positions are shown for qualifying whale pools.</p>' +
      evidencePanels(db, req, w.address) :
      '<p class="source-note">Position history shown for pools where this wallet has more than US$2,000 in open-position deposits.</p>')
    : stats + evidencePanels(db, req, w.address);
  return '<p class="mono address">' + raw(w.address) + '</p>' + editor + scope + links + rows;
}

function isPublicCandidate(db, wallet) {
  return wallet.current_rank != null || Boolean(db.prepare('SELECT 1 FROM smart_lp_evaluations WHERE wallet=? LIMIT 1').get(wallet.address));
}

function csvValue(value) {
  let data = String(value ?? '');
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(data)) data = "'" + data;
  return '"' + data.replaceAll('"', '""') + '"';
}

function exportStatement(db, table, publicSnapshot) {
  if (!publicSnapshot) return db.prepare('SELECT * FROM ' + table);
  const candidates = "SELECT address FROM wallets WHERE current_rank IS NOT NULL OR address IN (SELECT wallet FROM smart_lp_evaluations WHERE cohort='candidate')";
  const positions = `SELECT p.position_pubkey FROM positions p WHERE (p.status='closed' AND p.wallet IN (${candidates})) OR
    (EXISTS (SELECT 1 FROM whale_deposits q WHERE q.wallet=p.wallet AND q.pool=p.pool)
    AND (p.status='closed' OR p.position_pubkey IN (SELECT position_pubkey FROM current_position_observations)))`;
  if (table === 'wallets') return db.prepare('SELECT * FROM wallets WHERE address IN (SELECT wallet FROM whale_deposits UNION ' + candidates + ')');
  if (table === 'positions' || table === 'position_bins') {
    return db.prepare('SELECT * FROM ' + table + ' WHERE position_pubkey IN (' + positions + ')');
  }
  return db.prepare('SELECT * FROM ' + table);
}

export function createWeb({ db, settings, tools }) {
  const hash = settings.webPassword;
  if (!settings.webUser || !/^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.test(hash)) {
    throw new Error('WEB_USER and WEB_PASSWORD (bcrypt hash) are required');
  }
  const csrfSecret = randomBytes(32);
  const token = address => createHmac('sha256', csrfSecret).update(address).digest('hex');
  const binCache = new Map();
  const app = Fastify({ bodyLimit: 16384 });
  app.register(helmet, { contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } });
  app.register(rateLimit, { max: 90, timeWindow: '1 minute' });
  app.register(formbody);
  app.addHook('preHandler', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (req.routeOptions.url === '/api/agent-dorm/status') {
      const key = settings.dormApiKey;
      if (!key) return reply.code(404).send();
      if (!equal(req.headers.authorization ?? '', 'Bearer ' + key)) {
        return reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'Unauthorized' });
      }
      return;
    }
    const auth = req.headers.authorization?.match(/^Basic ([A-Za-z0-9+/=]+)$/i);
    const decoded = auth && Buffer.from(auth[1], 'base64').toString('utf8');
    const index = decoded?.indexOf(':') ?? -1;
    if (index < 0 || !equal(decoded.slice(0,index), settings.webUser) ||
        !await bcrypt.compare(decoded.slice(index + 1), hash)) {
      return reply.header('www-authenticate', 'Basic realm="Whale Radar", charset="UTF-8"').code(401).send('Authentication required');
    }
    req.publicMode = Boolean(getMeta(db, 'public_worker_started_at') || getMeta(db, 'public_snapshot_at'));
    req.radarMock = settings.mock;
  });
  const page = (reply, req, title, html) => {
    if (req.publicMode) req.publicHealth = publicHealth(db);
    return reply.type('text/html; charset=utf-8').send(main(req, title, html));
  };
  app.get('/web/radar.css', (_, reply) => reply.type('text/css; charset=utf-8').send(css));
  app.get('/web/radar.js', (_, reply) => reply.type('application/javascript; charset=utf-8').send(js));
  app.get('/web', (req, reply) => {
    const midnight = Math.floor(Date.now() / DAY) * DAY;
    const count = db.prepare(`SELECT (SELECT count(*) FROM wallets) AS wallets,
      (SELECT count(*) FROM positions WHERE status='open') AS positions,
      (SELECT count(*) FROM alerts WHERE sent_at>=?) AS alerts`).get(midnight);
    const whales = whalePools(db);
    const whaleWallets = new Set(whales.flatMap(row => row.wallets.map(wallet => wallet.wallet)));
    const deposits = whales.reduce((sum, row) => sum + row.depositUsd, 0);
    const active = req.publicMode ? db.prepare('SELECT coalesce(sum(active_positions),0) AS n FROM whale_deposits').get().n : count.positions;
    const pools = latestPools(db);
    const byPool = new Map(pools.map(pool => [pool.address, pool]));
    const openings = req.publicMode ? publicActivity(db) : [];
    const stats = [['Whale wallets',num(whaleWallets.size),'◎'],
      [req.publicMode ? 'Whale positions' : 'Tracked open positions',num(active),'◈'],
      ['Whale deposits',usd(deposits),'≋'],
      req.publicMode ? ['Confirmed openings',num(openings.length),'↗'] : ['Alerts today (UTC)',num(count.alerts),'◷']];
    const summary = '<div class="stats">' + stats.map(([label,value,icon]) =>
      '<section><span class="stat-icon" aria-hidden="true">' + icon + '</span><small>' + label + '</small><strong>' + value +
      '</strong></section>').join('') + '</div>';
    const top = pools.filter(pool => pool.volume24 > 0 && pool.tvl >= settings.minTvl)
      .sort((a,b) => b.volume24-a.volume24).slice(0, 8);
    const activity = req.publicMode ? publicActivityTable(req, openings.slice(0, 8), byPool) :
      alertsTable(db, req, db.prepare('SELECT * FROM alerts WHERE sent_at IS NOT NULL ORDER BY id DESC LIMIT 8').all());
    const groups = req.publicMode ? JSON.parse(getMeta(db, 'public_sample_groups') ?? '[]') : [];
    const note = req.publicMode ? '<p class="source-note">Whale threshold: more than US$2,000 deposited per wallet in the same pool across open positions. Public sample from ' +
      raw(getMeta(db, 'public_sample_pool_count')) + ' pools' + (groups.length ? ' across ' + raw(groups.join(', ').toLowerCase()) : '') +
      '. Smart LP rankings cover measured wallets.</p>' : '';
    return page(reply, req, 'Overview', summary + '<div class="overview-grid">' +
      (req.publicMode ? panel('Whale deposits by pool', '<a href="/web/pools">View pools ↗</a>',
        table(['Pool','Whales','Deposit USD'], [...whales].sort((a,b) => b.depositUsd-a.depositUsd).map(row => [
          poolLink(row.address,row.name), num(row.count), '<strong class="gain">' + usd(row.depositUsd) + '</strong>',
        ]))) : panel('Most active pools', '<a href="/web/trending">Trending ↗</a>', marketTable(top))) +
      panel(req.publicMode ? 'Position openings' : 'Recent alerts', '<a href="/web/alerts">View all ↗</a>', activity) +
      '</div>' + note + '<div class="exports"><a href="/web/export.json">Export JSON</a><a href="/web/export.csv?table=wallets">Wallets CSV</a>' +
      '<a href="/web/export.csv?table=positions">Positions CSV</a>' +
      (req.publicMode ? '' : '<a href="/web/export.csv?table=alerts">Alerts CSV</a>') + '</div>');
  });
  app.get('/web/wallets', (req, reply) => page(reply, req, 'Wallets', req.publicMode ? publicWhaleList(db, req) : walletList(db, req)));
  app.get('/api/agent-dorm/status', (_req, reply) => {
    if (!getMeta(db, 'public_snapshot_at')) return reply.code(503).send({ error: 'Public Radar not ready' });
    return agentDormSnapshot(radarReport(db));
  });
  app.get('/web/public-status', (req, reply) => {
    if (!req.publicMode) return reply.code(404).send();
    return publicHealth(db);
  });
  app.get('/web/leaderboard', (req, reply) => page(reply, req, 'Smart LP leaderboard', smartLeaderboard(db, req)));
  app.get('/web/positions/:id/bins', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = req.params.id;
    if (!tools || !isAddress(id)) return reply.code(404).send();
    const position = db.prepare("SELECT * FROM positions WHERE position_pubkey=? AND status='open'").get(id);
    if (!position || (req.publicMode && !db.prepare(`SELECT 1 FROM current_position_observations c
      JOIN whale_deposits q ON q.wallet=? AND q.pool=? WHERE c.position_pubkey=?`).get(position.wallet, position.pool, id))) {
      return reply.code(404).send();
    }
    let cached = binCache.get(id);
    if (!cached || cached.until <= Date.now()) {
      if (binCache.size >= 100) binCache.delete(binCache.keys().next().value);
      const result = tools.positionBins(position).then(async snapshot => {
        if (!snapshot) return null;
        const indexed = tools.applyBins(position, snapshot);
        let strategy = position.strategy_source === 'instruction' ? position : indexed;
        if (!strategy.strategy_label || strategy.strategy_label === 'Custom rebalance') {
          try {
            const history = await tools.historicalStrategy(indexed);
            if (history?.strategy_label) strategy = history;
          } catch {
            // A historical RPC outage should not hide the current range and balances.
            req.log.debug('Opening deposit lookup unavailable');
          }
        }
        let chart = liquidityChart(indexed, snapshot.bins, Date.now());
        if (!snapshot.bins.some(bin => Number(bin.liquidity) > 0)) {
          const saved = db.prepare(`SELECT bin_id AS id, liquidity, snapshot_at FROM position_bins
            WHERE position_pubkey=? ORDER BY bin_id`).all(id);
          if (saved.some(bin => Number(bin.liquidity) > 0)) {
            const last = saved.at(-1);
            const historical = { status: 'closed', lower_bin_id: saved[0].id, upper_bin_id: last.id };
            chart += '<div class="bin-history"><small>Saved distribution</small>' +
              liquidityChart(historical, saved, last.snapshot_at) + '</div>';
          } else if (strategy.openingAllocation) {
            const { bins, at } = strategy.openingAllocation;
            const ids = bins.map(bin => bin.id);
            const historical = { status: 'closed', lower_bin_id: Math.min(...ids), upper_bin_id: Math.max(...ids) };
            chart += '<div class="bin-history"><small>First deposit · Configured allocation</small>' +
              liquidityChart(historical, bins, at, 'Configured deposit amount') + '</div>';
          }
        }
        return { range: binRange(indexed), strategy: positionStrategy(strategy), chart };
      });
      cached = { until: Date.now() + 45000, result };
      binCache.set(id, cached);
    }
    try {
      const chart = await cached.result;
      return chart ?? reply.code(404).send();
    } catch {
      if (binCache.get(id) === cached) binCache.delete(id);
      return reply.code(503).send();
    }
  });
  app.get('/web/wallets/:address', (req, reply) => {
    const w = db.prepare('SELECT * FROM wallets WHERE address=?').get(req.params.address);
    if (!w || (req.publicMode && !isPublicCandidate(db, w) && !(w.is_favorite && !w.is_blacklisted) &&
      !db.prepare('SELECT 1 FROM whale_deposits WHERE wallet=? LIMIT 1').get(w.address) &&
      (w.is_blacklisted || !db.prepare(`SELECT 1 FROM public_activity_events
        WHERE json_extract(detail,'$.wallet')=? LIMIT 1`).get(w.address)))) {
      return reply.code(404).send('Wallet not found');
    }
    return page(reply, req, 'Wallet profile', walletDetail(db, req, w, token(w.address), Boolean(tools)));
  });
  app.post('/web/wallets/:address', (req, reply) => {
    const { address } = req.params;
    if (!isAddress(address)) return reply.code(404).send('Wallet not found');
    const body = req.body;
    if (!body || typeof body.csrf !== 'string' || !equal(body.csrf, token(address))) return reply.code(403).send('Invalid CSRF token');
    if (typeof body.note !== 'string' || typeof body.tags !== 'string' || body.note.length > 1000 || body.tags.length > 240) {
      return reply.code(400).send('Invalid note or tags');
    }
    const updated = db.transaction(() => {
      const result = db.prepare('UPDATE wallets SET note=?,tags=?,is_favorite=?,is_blacklisted=? WHERE address=?')
        .run(body.note.trim(), body.tags.trim(), Number(body.favorite === '1'), Number(body.blacklist === '1'), address);
      if (result.changes) {
        if (body.favorite === '1' && body.blacklist !== '1') scheduleWallet(db, address, Date.now());
        else if (req.publicMode) resetSmartLpFavorite(db, address);
      }
      return result.changes;
    }).immediate();
    return updated ? reply.code(303).header('location', '/web/wallets/' + address).send() : reply.code(404).send('Wallet not found');
  });
  app.get('/web/pools', (req, reply) => {
    const details = new Map(latestPools(db).map(pool => [pool.address,pool]));
    const rows = whalePools(db);
    if (req.query.sort === 'size' || req.publicMode) rows.sort((a,b) => b.depositUsd-a.depositUsd || b.count-a.count);
    return page(reply, req, 'Pools with tracked wallets', '<p>Sort by <a href="?sort=count">wallets</a> · <a href="?sort=size">size</a></p>' +
      table(['Pool','Bin Step','Base fee','Dynamic fee','Whales','Deposit USD','Current size','Strategy mix','Avg width','FDV','TVL','Age'], rows.map(row => {
        const pool = details.get(row.address);
        return [poolIdentity(row.address, pool?.name || row.name), num(pool?.binStep),
          pct(pool?.baseFeePct, 6), pct(pool?.dynamicFeePct, 6), num(row.count),
          '<strong class="gain">' + usd(row.depositUsd) + '</strong>', money(req,db,row.size),
          raw(Object.entries(row.mix).map(([label,count]) => count + '× ' + label).join(', ') || null),
          pct(row.width), usd(pool?.fdv), usd(pool?.tvl), age(pool?.createdAt)];
      })));
  });
  app.get('/web/trending', (req, reply) => page(reply, req, 'Trending pools',
    table(['Pool','Score','Tracked wallets','FDV','TVL','Volume 5m','Volume 1h','Volume 24h','Fees 24h','Fee/TVL','Fee APR est.','Bin Step','Base / dynamic fee','Risk flags'],
      trending(db, settings).map(pool => [
        poolLink(pool.address,pool.name), metric(num(pool.score), 'Whale Radar · trending weights'),
        pool.whales?.wallets.some(w => w.rank) ? '<span class="badge">' + pool.whales.count + ' · Top wallet</span>' : num(pool.whales?.count ?? 0),
        metric(usd(pool.fdv), (pool.fdvSource || 'Jupiter') + ' price × supply'), metric(usd(pool.tvl), 'Meteora'),
        usd(pool.volume5), usd(pool.volume1), usd(pool.volume24), usd(pool.fees24),
        pct(pool.feeTvl == null ? null : pool.feeTvl * 100), pct(pool.apr == null ? null : pool.apr * 100),
        num(pool.binStep), pct(pool.baseFeePct) + ' / ' + pct(pool.dynamicFeePct), raw(pool.risks?.join(', ') || null),
      ]))));
  app.get('/web/alerts', (req, reply) => {
    const wallet = req.query.wallet;
    const pool = req.query.pool;
    if (req.publicMode) {
      const openings = publicActivity(db);
      const pools = new Map(latestPools(db).map(item => [item.address, item]));
      const pending = openings.filter(row => !row.alertMarket);
      const sections = radarAlertFilters.TIERS.map(tier => panel(tier, '',
        publicActivityTable(req, openings.filter(row => row.alertMarket?.tier === tier), pools)));
      if (pending.length) sections.push(panel('Pending market cap', '', publicActivityTable(req, pending, pools)));
      return page(reply, req, 'Observed openings', sections.join(''));
    }
    const clauses = ['sent_at IS NOT NULL'];
    const args = [];
    if (wallet && isAddress(wallet)) { clauses.push('wallet=?'); args.push(wallet); }
    if (pool && isAddress(pool)) { clauses.push('pool=?'); args.push(pool); }
    const rows = db.prepare('SELECT * FROM alerts WHERE ' + clauses.join(' AND ') + ' ORDER BY id DESC LIMIT 200').all(...args);
    return page(reply, req, 'Alerts', '<form class="filters"><label>Wallet<input name="wallet" value="' + escape(wallet) +
      '"></label><label>Pool<input name="pool" value="' + escape(pool) + '"></label><button>Apply</button></form>' + alertsTable(db, req, rows));
  });
  app.get('/web/export.csv', (req, reply) => {
    const table = req.query.table;
    if (!['wallets','positions','alerts'].includes(table)) return reply.code(400).send('Unknown export table');
    const statement = exportStatement(db, table, req.publicMode);
    const keys = statement.columns().map(column => column.name);
    const lines = [keys.map(csvValue).join(',')];
    for (const row of statement.iterate()) lines.push(keys.map(key => csvValue(row[key])).join(','));
    return reply.header('content-disposition', 'attachment; filename="' + table + '.csv"').type('text/csv; charset=utf-8').send(lines.join('\r\n') + '\r\n');
  });
  app.get('/web/export.json', (req, reply) => {
    const exportData = db.transaction(() => Object.fromEntries(exportTables.map(table =>
      [table, exportStatement(db, table, req.publicMode).all()])))();
    if (req.publicMode) {
      exportData.observed_openings = publicActivity(db);
      exportData.whale_deposits = db.prepare('SELECT * FROM whale_deposits ORDER BY deposit_usd DESC').all();
    }
    return reply.header('content-disposition', 'attachment; filename="whale-radar.json"').send(exportData);
  });
  return app;
}

export function createWebhook({ db, settings }) {
  if (!settings.webhookSecret) throw new Error('HELIUS_WEBHOOK_AUTH is required');
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  app.post('/hooks/helius', { onRequest: async (req, reply) => {
    if (!equal(req.headers.authorization ?? '', settings.webhookSecret)) return reply.code(401).send({ error: 'Unauthorized' });
  } }, (req, reply) => {
    const signatures = webhookSignatures(req.body);
    if (!signatures) return reply.code(400).send({ error: 'Invalid webhook body' });
    const accepted = enqueue(db, signatures);
    return reply.code(200).send({ accepted });
  });
  return app;
}
