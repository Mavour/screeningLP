import { pathToFileURL } from 'node:url';
import radarAlertFilters from '../../../src/state/radarAlertFilters.store.js';
import { SOL, PUBLIC_OPENING_MIN_USD, config } from '../config.js';
import { http } from '../clients/http.js';
import { getMeta, openDb, setMeta } from '../db.js';
import { publicDatabasePath } from '../public-snapshot.js';
import { radarReport } from '../radar-report.js';
import { poolFacts } from './telegram.js';
import { stableMints } from '../opening-market.js';

const usd = value => Number.isFinite(value) ? 'US$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–';
const quoteMints = new Set([SOL, ...stableMints]);
const depositSides = { sol: 'SOL side', token: 'Token side', double: 'Double side' };
const signedPct = new Intl.NumberFormat('id-ID', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 2 });

function openingRange(event) {
  if (!event.openingRangePct) return '–';
  const { min, max } = event.openingRangePct;
  const pct = value => signedPct.format(value / 100);
  if (min === max || !max) return pct(min);
  if (!min) return pct(max);
  return pct(min) + ' s.d. ' + pct(max);
}

export function publicTelegramMessage(event, report, dashboardUrl = '') {
  const clean = value => String(value ?? '–').replace(/\s+/g, ' ').slice(0, 120);
  const time = event.at ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium',
    timeZone: 'Asia/Makassar' }).format(new Date(event.at)) + ' WITA' : '–';
  const { pool, alertMarket } = event;
  const text = [
    '🐋 Whale Radar · Posisi baru' + (alertMarket ? ' · ' + alertMarket.tier : ''), clean(pool.pair) + ' · Observed whale', '',
    ...(alertMarket ? ['Koin LP  ' + clean(alertMarket.symbol || alertMarket.mint) +
      (alertMarket.isMajor ? ' · Aset mayor' : '')] : []),
    'Market cap  ' + usd(alertMarket?.marketCapUsd),
    'Deposit pembukaan  ' + usd(event.openingDepositUsd),
    'Minimum  ' + usd(PUBLIC_OPENING_MIN_USD) + ' per posisi dalam satu transaksi',
    'Wallet  ' + clean(event.wallet), 'Strategi  ' + clean(event.strategy),
    'Sisi deposit  ' + (depositSides[event.depositSide] ?? '–'), 'Range pembukaan  ' + openingRange(event),
    'Waktu transaksi  ' + time,
    ...(event.smartLpStatus === 'verified' ? ['Status wallet  Verified Smart LP'] : []),
    '', ...poolFacts(pool), '', 'Sumber  ' + report.source + (alertMarket?.marketCapUsd > 0 ? ' + DEX Screener' : ''),
  ].join('\n');
  const buttons = [{ text: 'Pool Meteora', url: pool.poolUrl }, { text: 'Transaksi Solscan', url: event.transactionUrl }];
  if (dashboardUrl) {
    try {
      const target = new URL('/web/wallets/' + event.wallet, dashboardUrl);
      if (target.protocol === 'https:' && !target.username && !target.password) buttons.push({ text: 'Profil wallet', url: target.href });
    } catch { /* A missing dashboard URL does not block delivery. */ }
  }
  const tokens = [...new Map((pool.tokens ?? []).map(token => [token.mint, token])).values()];
  const nonQuote = tokens.filter(token => !quoteMints.has(token.mint));
  const copyTokens = nonQuote.length ? nonQuote : tokens.length === 2 ? tokens : [];
  const copyButtons = copyTokens.map(({ mint, symbol, side }) => ({
    text: copyTokens.length === 1 ? 'Copy CA' : 'Copy CA · ' + clean(symbol || 'Token ' + side).slice(0, 20),
    copy_text: { text: mint },
  }));
  const inline_keyboard = copyButtons.length ? [buttons, copyButtons] : [buttons];
  return { text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard } };
}

export function publicTelegramDelivery(db, logger, env = process.env, signal) {
  const settings = config(env);
  const key = 'public_telegram_since';
  if (env.RADAR_PUBLIC_TELEGRAM !== '1') {
    setMeta(db, key, 0);
    setMeta(db, 'public_telegram_state', 'disabled');
    return null;
  }
  if (!settings.telegramToken || !/^-?\d+$/.test(settings.chatId)) {
    setMeta(db, 'public_telegram_state', 'missing_config');
    logger.warn('Public Telegram requires its token and a numeric chat ID');
    return null;
  }
  const since = Number(getMeta(db, key)) || Date.now();
  setMeta(db, key, since);
  setMeta(db, 'public_telegram_state', 'enabled');
  const send = http('public telegram', { rpm: 20, timeout: 8000, retries: 0, signal });
  const update = db.prepare(`INSERT INTO public_telegram_delivery(signature,position,sent_at,attempts,retry_at) VALUES (?,?,?,?,?)
    ON CONFLICT(signature,position) DO UPDATE SET sent_at=excluded.sent_at,attempts=excluded.attempts,retry_at=excluded.retry_at`);
  return async () => {
    const filters = radarAlertFilters.load();
    if (Object.values(filters).every(filter => !filter.enabled)) return;
    const rows = db.prepare(`WITH eligible AS (
      SELECT e.signature,e.position,e.happened_at FROM public_activity_events e
      JOIN wallets w ON w.address=json_extract(e.detail,'$.wallet') AND w.is_blacklisted=0
      WHERE json_extract(e.detail,'$.openingDepositUsd')>=?
      ORDER BY e.happened_at DESC LIMIT 200
    )
    SELECT e.signature,e.position,e.happened_at,coalesce(d.attempts,0) AS attempts
    FROM eligible e LEFT JOIN public_telegram_delivery d USING(signature,position)
    WHERE e.happened_at>=? AND d.sent_at IS NULL AND coalesce(d.retry_at,0)<=?
    ORDER BY e.happened_at`).all(PUBLIC_OPENING_MIN_USD, since, Date.now());
    if (!rows.length) return;
    const report = radarReport(db);
    const current = new Map(report.openings.map(event => [event.id, event]));
    let attempted = 0;
    for (const row of rows) {
      const event = current.get(row.signature + ':' + row.position);
      const filter = filters[event?.alertMarket?.tier];
      if (!filter?.enabled || row.happened_at < filter.enabledAt) continue;
      if (attempted === 3) break;
      attempted++;
      try {
        const response = await send('https://api.telegram.org/bot' + settings.telegramToken + '/sendMessage', {
          method: 'POST', body: { chat_id: settings.chatId, ...publicTelegramMessage(event, report, settings.publicUrl) }, retry: false,
        });
        if (response.ok !== true) throw new Error('Telegram did not confirm delivery');
        update.run(row.signature, row.position, Date.now(), row.attempts, 0);
      } catch (error) {
        update.run(row.signature, row.position, null, row.attempts + 1,
          Date.now() + Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 8)));
        logger.warn({ reason: error.message }, 'Public Telegram delivery deferred');
      }
    }
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const db = openDb(publicDatabasePath());
  try {
    const report = radarReport(db);
    if (!report.openings.length) throw new Error('No verified public opening available for preview');
    console.log(publicTelegramMessage(report.openings[0], report).text);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { db.close(); }
}
