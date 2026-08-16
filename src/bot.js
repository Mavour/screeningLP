const logger = require("./lib/logger");
const { MENU } = require("./lib/constants");
const { escapeHtml } = require("./lib/format");
const telegram = require("./services/telegram.service");
const userConfig = require("./state/userConfig.store");
const lastScan = require("./state/lastScan.store");
const seenPools = require("./state/seenPools.store");
const kolWallets = require("./state/kolWallets.store");
const { runScan } = require("./scanner");

const pendingInput = new Map();

function startBot() {
  const bot = telegram.getBot();

  telegram.setupMenuChrome().catch((err) => logger.warn("setup menu chrome", { err: err.message }));

  bot.onText(/\/start/, (msg) => gated(msg, handleStart));
  bot.onText(/\/menu/, (msg) => gated(msg, (m) => renderMenu(m.chat.id)));
  bot.on("callback_query", handleCallback);
  bot.on("message", handlePlain);

  logger.info("telegram bot polling");
  return bot;
}

async function gated(msg, fn) {
  if (!telegram.isAllowed(msg.chat.id)) {
    logger.warn("ignored chat", { chatId: msg.chat.id });
    return;
  }
  try {
    await fn(msg);
  } catch (err) {
    logger.error("bot handler", { err: err.message });
    await telegram.send(msg.chat.id, `Error: ${err.message}`, {
      reply_markup: { inline_keyboard: backMenu() },
    });
  }
}

async function handleStart(msg) {
  pendingInput.delete(msg.chat.id);
  const status = lastScan.load();
  await telegram.pinReplyBar(
    msg.chat.id,
    [
      "<b>LP Scanner</b>",
      "Alert-only — tidak eksekusi transaksi.",
      "Scan tiap 5 menit. Tap <b>Menu</b> di samping kolom ketik kapan saja.",
      "",
      status.at ? `Last scan: ${status.at}` : "Belum ada scan.",
      status.paused ? "Status: <b>PAUSED</b>" : "Status: running",
    ].join("\n")
  );
  await renderMenu(msg.chat.id);
}

function mainKeyboard() {
  const paused = lastScan.load().paused;
  return [
    [
      { text: "💧 Pool menarik", callback_data: "pools" },
      { text: "🔎 Scan", callback_data: "scan" },
    ],
    [
      { text: "ℹ Status", callback_data: "status" },
      { text: paused ? "▶ Resume" : "⏸ Pause", callback_data: "pause" },
    ],
    [
      { text: "💰 Liquidity", callback_data: "cat:Liquidity" },
      { text: "👥 Holder", callback_data: "cat:Holder" },
    ],
    [
      { text: "🛡 Risk", callback_data: "cat:Risk" },
      { text: "⏱ Age", callback_data: "cat:Age" },
      { text: "📡 Discovery", callback_data: "cat:Discovery" },
    ],
    [{ text: "★ KOL avoid / green", callback_data: "kol" }],
    [{ text: "↺ Reset default", callback_data: "reset" }],
  ];
}

function backMenu() {
  return [[{ text: "← Menu", callback_data: "menu" }]];
}

async function renderMenu(chatId, messageId) {
  pendingInput.delete(chatId);
  const status = lastScan.load();
  const rec = status.recommended?.length || 0;
  await telegram.show(
    chatId,
    [
      "<b>Menu</b>",
      status.paused ? "Scan: <b>PAUSED</b>" : "Scan: running tiap 5 menit",
      status.at ? `Last scan: ${status.at} · ${rec} pool lolos` : "Belum ada scan.",
      "",
      "Tap tombol di bawah.",
    ].join("\n"),
    mainKeyboard(),
    messageId
  );
}

async function renderStatus(chatId, messageId) {
  const config = userConfig.load();
  const status = lastScan.load();
  const kol = kolWallets.load();
  const lines = [
    "<b>Status</b>",
    `Scan: ${status.paused ? "PAUSED" : "running"}`,
    `Last scan: ${status.at || "n/a"}`,
    `Heartbeat: ${status.heartbeat || "n/a"}`,
    `Scanned: ${status.scanned || 0} · pass ${status.recommended?.length || 0} · reject ${status.rejected || 0}`,
    `Seen alerts: ${seenPools.size()}`,
    `KOL avoid ${kol.avoid.length} · green ${kol.greenFlag.length}`,
    "",
    "<b>Config aktif</b>",
  ];
  for (const [cat, items] of Object.entries(MENU)) {
    lines.push(`\n<i>${cat}</i>`);
    for (const [key, meta] of Object.entries(items)) {
      lines.push(`• ${meta.label}: <b>${formatVal(config[key])}</b>`);
    }
  }
  await telegram.show(chatId, lines.join("\n"), backMenu(), messageId);
}

async function renderCategory(chatId, cat, messageId) {
  const items = MENU[cat];
  if (!items) return;
  const config = userConfig.load();
  const keyboard = Object.entries(items).map(([key, meta]) => [
    { text: `${meta.label}  ·  ${formatVal(config[key])}`, callback_data: `ind:${key}` },
  ]);
  keyboard.push([{ text: "« Menu", callback_data: "menu" }]);
  await telegram.show(chatId, `<b>${cat}</b>\nTap nilai untuk mengubah.`, keyboard, messageId);
}

async function renderKol(chatId, messageId) {
  const kol = kolWallets.load();
  const lines = ["<b>KOL watchlist</b>", ""];
  const keyboard = [];

  if (!kol.avoid.length && !kol.greenFlag.length) {
    lines.push("Belum ada wallet.");
  }

  if (kol.avoid.length) {
    lines.push("<b>Avoid</b> — koin tetap lolos, dapat warning");
    kol.avoid.forEach((w, i) => {
      lines.push(`⚠️ ${escapeHtml(w.label)} — <code>${w.wallet}</code>`);
      keyboard.push([
        { text: `Hapus ⚠️ ${w.label}`, callback_data: `kolrm:avoid:${i}` },
      ]);
    });
    lines.push("");
  }
  if (kol.greenFlag.length) {
    lines.push("<b>Green</b> — catatan baik di report");
    kol.greenFlag.forEach((w, i) => {
      lines.push(`✅ ${escapeHtml(w.label)} — <code>${w.wallet}</code>`);
      keyboard.push([
        { text: `Hapus ✅ ${w.label}`, callback_data: `kolrm:green:${i}` },
      ]);
    });
  }

  keyboard.push([
    { text: "⚠ Tambah Avoid", callback_data: "koladd:avoid" },
    { text: "★ Tambah Green", callback_data: "koladd:green" },
  ]);
  keyboard.push([{ text: "← Menu", callback_data: "menu" }]);
  await telegram.show(chatId, lines.join("\n"), keyboard, messageId);
}

async function renderPools(chatId, messageId) {
  const status = lastScan.load();
  if (!status.recommended?.length) {
    await telegram.show(
      chatId,
      "Belum ada hasil. Tap <b>Scan sekarang</b> atau tunggu cycle 5 menit.",
      [
        [{ text: "🔎 Scan sekarang", callback_data: "scan" }],
        [{ text: "← Menu", callback_data: "menu" }],
      ],
      messageId
    );
    return;
  }
  await telegram.show(
    chatId,
    telegram.formatList(status.recommended, `<b>Pool menarik</b> · ${status.at}`),
    [
      [{ text: "🔎 Scan ulang", callback_data: "scan" }],
      [{ text: "← Menu", callback_data: "menu" }],
    ],
    messageId
  );
}

async function runScanFromMenu(chatId, messageId) {
  await telegram.show(chatId, "Scanning…", null, messageId);
  const result = await runScan({ alert: false, force: true });
  await telegram.show(
    chatId,
    telegram.formatList(
      result.recommended,
      `<b>Scan selesai</b> · ${result.scanned} pool · ${result.recommended.length} lolos`
    ),
    [[{ text: "← Menu", callback_data: "menu" }]],
    messageId
  );
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!telegram.isAllowed(chatId)) return;
  const data = query.data || "";
  const bot = telegram.getBot();
  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    if (data === "menu") return renderMenu(chatId, messageId);
    if (data === "status") return renderStatus(chatId, messageId);
    if (data === "pools") return renderPools(chatId, messageId);
    if (data === "scan") return runScanFromMenu(chatId, messageId);
    if (data === "kol") return renderKol(chatId, messageId);

    if (data === "pause") {
      const next = !lastScan.load().paused;
      lastScan.setPaused(next);
      return renderMenu(chatId, messageId);
    }

    if (data === "reset") {
      return telegram.show(
        chatId,
        "Reset semua threshold ke default?",
        [
          [
            { text: "Ya, reset", callback_data: "reset:yes" },
            { text: "Batal", callback_data: "menu" },
          ],
        ],
        messageId
      );
    }
    if (data === "reset:yes") {
      userConfig.reset();
      await telegram.show(chatId, "Config dikembalikan ke default.", backMenu(), messageId);
      return;
    }

    if (data.startsWith("cat:")) {
      return renderCategory(chatId, data.slice(4), messageId);
    }

    if (data.startsWith("ind:")) {
      return startEditIndicator(chatId, data.slice(4), messageId);
    }

    if (data.startsWith("set:")) {
      const [, key, ...rest] = data.split(":");
      const value = rest.join(":");
      const meta = findMeta(key);
      if (!meta) return;
      userConfig.set(key, coerce(meta, value));
      const cat = findCategory(key);
      return renderCategory(chatId, cat, messageId);
    }

    if (data.startsWith("koladd:")) {
      const list = data.slice(7) === "green" ? "greenFlag" : "avoid";
      pendingInput.set(chatId, { type: "kol", list, messageId });
      const kind = list === "greenFlag" ? "Green" : "Avoid";
      return telegram.show(
        chatId,
        [
          `<b>Tambah KOL ${kind}</b>`,
          "Kirim 1 pesan:",
          "<code>Label WalletAddress</code>",
          "",
          "Contoh: <code>Ansem 5Q544f...xyz</code>",
        ].join("\n"),
        backMenu(),
        messageId
      );
    }

    if (data.startsWith("kolrm:")) {
      const [, listKey, idxRaw] = data.split(":");
      const idx = Number(idxRaw);
      const kol = kolWallets.load();
      const arr = listKey === "green" ? kol.greenFlag : kol.avoid;
      const row = arr[idx];
      if (row) kolWallets.remove(row.wallet);
      return renderKol(chatId, messageId);
    }
  } catch (err) {
    logger.error("callback", { err: err.message });
    await telegram.send(chatId, `Error: ${err.message}`, {
      reply_markup: { inline_keyboard: backMenu() },
    });
  }
}

async function startEditIndicator(chatId, key, messageId) {
  const meta = findMeta(key);
  if (!meta) return;
  const config = userConfig.load();
  const cat = findCategory(key);

  if (meta.type === "bool") {
    userConfig.set(key, !config[key]);
    return renderCategory(chatId, cat, messageId);
  }

  if (meta.type === "enum") {
    const keyboard = meta.options.map((opt) => [
      {
        text: opt === config[key] ? `• ${opt}` : opt,
        callback_data: `set:${key}:${opt}`,
      },
    ]);
    keyboard.push([{ text: `← ${cat}`, callback_data: `cat:${cat}` }]);
    return telegram.show(
      chatId,
      `${meta.label}\nSekarang: <b>${formatVal(config[key])}</b>`,
      keyboard,
      messageId
    );
  }

  pendingInput.set(chatId, { type: "number", key, messageId });
  return telegram.show(
    chatId,
    [
      `<b>${meta.label}</b>`,
      `Sekarang: <b>${formatVal(config[key])}</b>`,
      "",
      "Kirim angka baru di chat ini.",
      "0 = matikan filter (kecuali volume 24h / creator).",
    ].join("\n"),
    [[{ text: `← ${cat}`, callback_data: `cat:${cat}` }]],
    messageId
  );
}

async function handlePlain(msg) {
  if (!msg.text) return;
  if (!telegram.isAllowed(msg.chat.id)) return;

  if (telegram.isMenuTap(msg.text)) {
    pendingInput.delete(msg.chat.id);
    await renderMenu(msg.chat.id);
    return;
  }

  if (msg.text.startsWith("/")) return;
  const pending = pendingInput.get(msg.chat.id);
  if (!pending) return;

  pendingInput.delete(msg.chat.id);
  const chatId = msg.chat.id;

  try {
    if (pending.type === "kol") {
      const parsed = parseKolLine(msg.text);
      kolWallets.add({ label: parsed.label, wallet: parsed.wallet, list: pending.list });
      await renderKol(chatId);
      return;
    }

    if (pending.type === "number") {
      const meta = findMeta(pending.key);
      const value = coerce(meta, msg.text.trim());
      userConfig.set(pending.key, value);
      const cat = findCategory(pending.key);
      await telegram.send(chatId, `${meta.label} → <b>${formatVal(value)}</b>`);
      await renderCategory(chatId, cat);
    }
  } catch (err) {
    await telegram.send(chatId, `Tidak valid: ${err.message}`, {
      reply_markup: { inline_keyboard: backMenu() },
    });
  }
}

function parseKolLine(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) throw new Error("format: Label WalletAddress");
  const wallet = parts.pop();
  const label = parts.join(" ");
  if (wallet.length < 32) throw new Error("wallet address tidak valid");
  return { label, wallet };
}

function findMeta(key) {
  for (const items of Object.values(MENU)) {
    if (items[key]) return items[key];
  }
  return null;
}

function findCategory(key) {
  for (const [cat, items] of Object.entries(MENU)) {
    if (items[key]) return cat;
  }
  return null;
}

function coerce(meta, raw) {
  if (meta.type === "bool") return raw === true || raw === "true" || raw === "1";
  if (meta.type === "enum") {
    if (!meta.options.includes(raw)) throw new Error(`pilih: ${meta.options.join(", ")}`);
    return raw;
  }
  const n = Number(String(raw).replace(/[$,_]/g, ""));
  if (!Number.isFinite(n)) throw new Error("harus angka");
  return n;
}

function formatVal(v) {
  if (typeof v === "boolean") return v ? "ON" : "off";
  if (typeof v === "number" && v >= 1000) return v.toLocaleString("en-US");
  return String(v);
}

module.exports = { startBot };
