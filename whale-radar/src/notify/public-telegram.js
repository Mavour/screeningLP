import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { http } from '../clients/http.js';
import { getMeta, openDb, setMeta } from '../db.js';
import { publicDatabasePath } from '../public-snapshot.js';
import { radarReport } from '../radar-report.js';
import { poolFacts } from './telegram.js';

const usd = value => Number.isFinite(value) ? 'US$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–';

export function publicTelegramMessage(event, report, dashboardUrl = '') {
  const clean = value => String(value ?? '–').replace(/\s+/g, ' ').slice(0, 120);
  const time = event.at ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium',
    timeZone: 'Asia/Makassar' }).format(new Date(event.at)) + ' WITA' : '–';
  const { pool } = event;
  const text = [
    '🐋 Whale Radar · Posisi baru', clean(pool.pair) + ' · Observed whale', '',
    'Deposit wallet di pool  ' + usd(event.walletDepositUsd),
    'Ambang  > ' + usd(report.thresholdUsd) + ' per wallet per pool',
    'Wallet  ' + clean(event.wallet), 'Strategi  ' + clean(event.strategy), 'Waktu transaksi  ' + time,
    ...(event.smartLpStatus === 'verified' ? ['Status wallet  Verified Smart LP'] : []),
    '', ...poolFacts(pool), '', 'Sumber  ' + report.source,
  ].join('\n');
  const buttons = [{ text: 'Pool Meteora', url: pool.poolUrl }, { text: 'Transaksi Solscan', url: event.transactionUrl }];
  if (dashboardUrl) {
    try {
      const target = new URL('/web/wallets/' + event.wallet, dashboardUrl);
      if (target.protocol === 'https:' && !target.username && !target.password) buttons.push({ text: 'Profil wallet', url: target.href });
    } catch { /* A missing dashboard URL does not block delivery. */ }
  }
  return { text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [buttons] } };
}

export function publicTelegramDelivery(db, logger, env = process.env, signal) {
  const settings = config(env);
  const key = 'public_telegram_since';
  if (env.RADAR_PUBLIC_TELEGRAM !== '1') {
    setMeta(db, key, 0);
    return null;
  }
  if (!settings.telegramToken || !/^-?\d+$/.test(settings.chatId)) {
    logger.warn('Public Telegram requires its token and a numeric chat ID');
    return null;
  }
  const since = Number(getMeta(db, key)) || Date.now();
  setMeta(db, key, since);
  const send = http('public telegram', { rpm: 20, timeout: 8000, retries: 0, signal });
  const update = db.prepare(`INSERT INTO public_telegram_delivery(signature,position,sent_at,attempts,retry_at) VALUES (?,?,?,?,?)
    ON CONFLICT(signature,position) DO UPDATE SET sent_at=excluded.sent_at,attempts=excluded.attempts,retry_at=excluded.retry_at`);
  return async () => {
    const rows = db.prepare(`SELECT e.signature,e.position,coalesce(d.attempts,0) AS attempts
      FROM public_activity_events e LEFT JOIN public_telegram_delivery d USING(signature,position)
      JOIN whale_deposits q ON q.wallet=json_extract(e.detail,'$.wallet') AND q.pool=json_extract(e.detail,'$.pool')
      WHERE e.happened_at>=? AND d.sent_at IS NULL AND coalesce(d.retry_at,0)<=?
        AND e.rowid IN (SELECT rowid FROM public_activity_events ORDER BY happened_at DESC LIMIT 200)
      ORDER BY e.happened_at LIMIT 3`).all(since, Date.now());
    if (!rows.length) return;
    const report = radarReport(db);
    const current = new Map(report.openings.map(event => [event.id, event]));
    for (const row of rows) {
      const event = current.get(row.signature + ':' + row.position);
      if (!event) continue;
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
