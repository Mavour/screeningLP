const test = require("node:test");
const assert = require("node:assert/strict");
const telegram = require("../src/services/telegram.service");
const radarAlertFilters = require("../src/state/radarAlertFilters.store");
const { startBot } = require("../src/bot");

test("/web sends a private dashboard URL only to an allowed chat", async (t) => {
  const originalUrl = process.env.RADAR_PUBLIC_URL;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.RADAR_PUBLIC_URL;
    else process.env.RADAR_PUBLIC_URL = originalUrl;
  });
  process.env.RADAR_PUBLIC_URL = "https://192.0.2.10:9443/";
  const handlers = [];
  t.mock.method(telegram, "getBot", () => ({
    onText: (regexp, handler) => handlers.push({ regexp, handler }),
    on() {},
  }));
  t.mock.method(telegram, "setupMenuChrome", async () => {});
  t.mock.method(telegram, "isAllowed", id => id === 42);
  const show = t.mock.method(telegram, "show", async () => {});
  startBot();
  const web = handlers.find(({ regexp }) => regexp.test("/web"));
  await web.handler({ chat: { id: 43 } });
  assert.equal(show.mock.callCount(), 0);
  await web.handler({ chat: { id: 42 } });
  assert.equal(show.mock.calls[0].arguments[2][0][0].url, "https://192.0.2.10:9443/web");
  process.env.RADAR_PUBLIC_URL = "http://192.0.2.10:9011";
  await web.handler({ chat: { id: 42 } });
  assert.match(show.mock.calls[1].arguments[1], /HTTPS/);
  assert.ok(show.mock.calls[1].arguments[2].flat().every(button => !button.url));
});

test("/menu exposes independently adjustable Whale Radar alert categories", async (t) => {
  const handlers = new Map();
  const commands = [];
  t.mock.method(telegram, "getBot", () => ({
    onText: (regexp, handler) => commands.push({ regexp, handler }),
    on: (event, handler) => handlers.set(event, handler),
    answerCallbackQuery: async () => {},
  }));
  t.mock.method(telegram, "setupMenuChrome", async () => {});
  t.mock.method(telegram, "isAllowed", id => id === 42);
  const show = t.mock.method(telegram, "show", async () => {});
  const filters = Object.fromEntries(radarAlertFilters.TIERS.map(tier => [tier, { enabled: true }]));
  t.mock.method(radarAlertFilters, "load", () => filters);
  const toggle = t.mock.method(radarAlertFilters, "toggle", tier => {
    filters[tier].enabled = !filters[tier].enabled;
    return filters;
  });
  startBot();
  await commands.find(({ regexp }) => regexp.test("/menu")).handler({ chat: { id: 42 } });
  assert.ok(show.mock.calls[0].arguments[2].flat().some(button => button.callback_data === "radar-filters"));
  const callback = (data, id = 42) => handlers.get("callback_query")({ data, message: { chat: { id }, message_id: 1 } });
  await callback("radar-filters");
  assert.deepEqual(show.mock.calls[1].arguments[2][0].map(button => button.text), ["DEGEN ON", "SEMI ON", "SAVE ON"]);
  await callback("radar-filter:DEGEN", 43);
  assert.equal(toggle.mock.callCount(), 0);
  await callback("radar-filter:DEGEN");
  await callback("radar-filter:SAVE");
  assert.deepEqual(show.mock.calls[3].arguments[2][0].map(button => button.text), ["DEGEN OFF", "SEMI ON", "SAVE OFF"]);
});
