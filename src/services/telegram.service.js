const TelegramBot = require("node-telegram-bot-api");
const logger = require("../lib/logger");
const { fmtUsd, fmtPct, fmtAge, fmtNum, riskBadge, escapeHtml } = require("../lib/format");

let bot;

function allowedChatId() {
  const raw = process.env.ALLOWED_CHAT_ID;
  return raw ? String(raw) : null;
}

function isAllowed(chatId) {
  const allowed = allowedChatId();
  if (!allowed) return true;
  return String(chatId) === allowed;
}

function getBot() {
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  bot = new TelegramBot(token, { polling: true });
  bot.on("polling_error", (err) => logger.warn("telegram polling", { err: err.message }));
  return bot;
}

function targetChat() {
  return allowedChatId();
}

const REPLY_MENU_LABEL = "Menu";

function replyBar() {
  return {
    keyboard: [[{ text: REPLY_MENU_LABEL }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "/menu",
  };
}

function isMenuTap(text) {
  const t = String(text || "").trim();
  return t === REPLY_MENU_LABEL || t === "☰ Menu";
}

async function pinReplyBar(chatId, text = "Menu siap. Tap <b>Menu</b> di bawah kapan saja.") {
  const id = chatId || targetChat();
  if (!id) return;
  return getBot().sendMessage(id, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyBar(),
  });
}

async function setupMenuChrome() {
  const b = getBot();
  await b.setMyCommands([
    { command: "menu", description: "Buka menu" },
    { command: "start", description: "Mulai bot" },
  ]);
  await b.setChatMenuButton({
    menu_button: JSON.stringify({ type: "commands" }),
  });
}

async function send(chatId, text, extra = {}) {
  const id = chatId || targetChat();
  if (!id) {
    logger.warn("no telegram chat id, skip send");
    return;
  }
  return getBot().sendMessage(id, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function edit(chatId, messageId, text, extra = {}) {
  return getBot().editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function show(chatId, text, keyboard, messageId) {
  const extra = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  if (messageId) {
    try {
      return await edit(chatId, messageId, text, extra);
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("message is not modified")) return null;
    }
  }
  return send(chatId, text, extra);
}

function formatAlert(item) {
  const t = item.token || item;
  const v = item.verdict || item;
  const vols = t.volumes || {};
  const warns = (v.warnings || []).slice(0, 6).map((w) => `• ${escapeHtml(w)}`).join("\n");
  const green = (t.kolGreen || []).map((k) => k.label).join(", ");
  const avoid = (t.kolAvoid || []).map((k) => k.label).join(", ");

  const lines = [
    `${riskBadge(v.category || t.category)}  <b>${escapeHtml(t.symbol)}</b> / ${escapeHtml(t.quoteSymbol || "SOL")}`,
    `<code>${t.mint}</code>`,
    `Pool: <code>${t.poolAddress}</code>  (${t.poolType || "dlmm"})`,
    "",
    `MC ${fmtUsd(t.marketCap)}  ·  TVL ${fmtUsd(t.tvl)}  ·  Active ${fmtUsd(t.activeTvl)}`,
    `Vol 5m ${fmtUsd(vols["5m"])}  ·  1h ${fmtUsd(vols["1h"])}`,
    `Vol 6h ${fmtUsd(vols["6h"])}  ·  24h ${fmtUsd(vols["24h"] ?? t.volume24h)}`,
    `Fee 24h ${fmtUsd(t.fees24h)}  ·  Fee/TVL ${fmtPct((t.feeTvlRatio || 0) * (t.feeTvlRatio < 2 ? 100 : 1), 2)}`,
    `LPs ${fmtNum(t.totalLps)} (unique ${fmtNum(t.uniqueLps)})  ·  Holders ${fmtNum(t.holders)}`,
    `Top10 ${fmtPct(t.top10HolderPct)}  ·  Creator ${fmtPct(t.devBalancePct, 3)}`,
    `Volat ${t.volatility == null ? "n/a" : Number(t.volatility).toFixed(2)}  ·  Age ${fmtAge(t.tokenAgeMinutes)}  ·  Pool ${fmtAge(t.poolAgeMinutes)}`,
    `Score ${v.score ?? t.score}/100`,
  ];

  if (green) lines.push(`✅ Green KOL: ${escapeHtml(green)}`);
  if (avoid) lines.push(`⚠️ Avoid KOL: ${escapeHtml(avoid)}`);
  if (warns) {
    lines.push("", "<b>Notes</b>", warns);
  }

  lines.push(
    "",
    `<a href="${t.meteoraUrl}">Meteora</a> · <a href="${t.dexUrl}">DexScreener</a> · <a href="${t.rugcheckUrl}">RugCheck</a>`,
    `<a href="${t.paprikaUrl}">DexPaprika</a> · <a href="${t.gmgnUrl}">GMGN</a>`
  );

  return lines.join("\n");
}

function formatList(items, title) {
  if (!items.length) return `${title}\n\nTidak ada pool yang lolos filter saat ini.`;
  const rows = items.slice(0, 15).map((item, i) => {
    const t = item.token || item;
    const v = item.verdict || item;
    const vols = t.volumes || {};
    const green = (t.kolGreen || []).length ? " ✅KOL" : "";
    const avoid = (t.kolAvoid || []).length ? " ⚠️KOL" : "";
    return [
      `<b>${i + 1}. ${escapeHtml(t.symbol)}</b> ${riskBadge(v.category || t.category)}${green}${avoid}`,
      `24h ${fmtUsd(vols["24h"] ?? t.volume24h)} · 6h ${fmtUsd(vols["6h"])} · 1h ${fmtUsd(vols["1h"])} · 5m ${fmtUsd(vols["5m"])}`,
      `TVL ${fmtUsd(t.tvl)} · LPs ${fmtNum(t.totalLps)} · Volat ${t.volatility == null ? "n/a" : Number(t.volatility).toFixed(2)} · Dev ${fmtPct(t.devBalancePct, 2)}`,
      `<a href="${t.meteoraUrl}">LP</a> · <a href="${t.dexUrl}">Chart</a>`,
    ].join("\n");
  });
  return `${title}\n\n${rows.join("\n\n")}`;
}

module.exports = {
  getBot,
  isAllowed,
  allowedChatId,
  targetChat,
  send,
  edit,
  show,
  formatAlert,
  formatList,
  replyBar,
  isMenuTap,
  pinReplyBar,
  setupMenuChrome,
  REPLY_MENU_LABEL,
};
