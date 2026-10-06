// Records real responses from Bitget public endpoints and the two MCP servers into test/fixtures.
// Usage: pnpm --filter @slipway/bitget record-fixtures   (no keys; read-only calls only)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const REST = "https://api.bitget.com";
const SYM = process.env.SYM ?? "NVDA";
const MAX_BYTES = 200_000;

interface Exchange {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: string };
  latencyMs: number;
  recordedAt: number;
}

const keepHeaders = ["content-type", "mcp-session-id", "retry-after"];

async function exchange(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  const h: Record<string, string> = {};
  for (const k of keepHeaders) {
    const v = res.headers.get(k);
    if (v !== null) h[k] = v;
  }
  return {
    request: { method, url, ...(body === undefined ? {} : { body }) },
    response: { status: res.status, headers: h, body: text },
    latencyMs: Math.round(performance.now() - t0),
    recordedAt: Date.now(),
  } satisfies Exchange;
}

function save(rel: string, data: unknown) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  const json = `${JSON.stringify(data, null, 1)}\n`;
  if (json.length > MAX_BYTES) throw new Error(`${rel} is ${json.length} bytes (> ${MAX_BYTES})`);
  writeFileSync(file, json);
  console.log(`${rel.padEnd(48)} ${String(json.length).padStart(7)} B`);
}

async function recordRest() {
  const spot = `R${SYM}USDT`;
  const perp = `${SYM}USDT`;
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const paths: Record<string, string> = {
    "spot-orderbook": `/api/v2/spot/market/orderbook?symbol=${spot}&type=step0&limit=150`,
    "perp-merge-depth": `/api/v2/mix/market/merge-depth?symbol=${perp}&productType=USDT-FUTURES&limit=max`,
    "spot-fills": `/api/v2/spot/market/fills?symbol=${spot}&limit=20`,
    "perp-fills": `/api/v2/mix/market/fills?symbol=${perp}&productType=USDT-FUTURES&limit=20`,
    "v3-ticker-spot": `/api/v3/market/tickers?category=SPOT&symbol=${spot}`,
    "v3-ticker-perp": `/api/v3/market/tickers?category=USDT-FUTURES&symbol=${perp}`,
    "perp-ticker": `/api/v2/mix/market/ticker?symbol=${perp}&productType=USDT-FUTURES`,
    "spot-candles": `/api/v2/spot/market/candles?symbol=${spot}&granularity=1h&limit=24`,
    "spot-history-candles": `/api/v2/spot/market/history-candles?symbol=${spot}&granularity=1h&endTime=${hourAgo}&limit=24`,
    "perp-candles": `/api/v2/mix/market/candles?symbol=${perp}&productType=USDT-FUTURES&granularity=1H&limit=24`,
    "perp-history-candles": `/api/v2/mix/market/history-candles?symbol=${perp}&productType=USDT-FUTURES&granularity=1H&endTime=${hourAgo}&limit=24`,
    "v3-candles-spot": `/api/v3/market/candles?category=SPOT&symbol=${spot}&interval=1H&limit=24`,
    "v3-history-candles-perp": `/api/v3/market/history-candles?category=USDT-FUTURES&symbol=${perp}&interval=1H&endTime=${hourAgo}&limit=24`,
    "spot-symbols": `/api/v2/spot/public/symbols?symbol=${spot}`,
    "perp-contracts": `/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=${perp}`,
    "perp-current-funding": `/api/v2/mix/market/current-fund-rate?symbol=${perp}&productType=USDT-FUTURES`,
    "v3-current-funding": `/api/v3/market/current-fund-rate?symbol=${perp}`,
    "perp-funding-history": `/api/v2/mix/market/history-fund-rate?symbol=${perp}&productType=USDT-FUTURES&pageSize=30`,
    "index-components": `/api/v3/market/index-components?symbol=${perp}`,
    "reality-stock-info": `/api/v3/reality/market/stock-info?symbol=${spot}`,
    "reality-states": "/api/v3/reality/market/states",
    "reality-calendar": "/api/v3/reality/market/calendar",
    "error-unknown-symbol": "/api/v2/spot/market/orderbook?symbol=RNOSUCHSYMUSDT&type=step0&limit=150",
  };
  for (const [name, path] of Object.entries(paths)) {
    save(`rest/${name}.json`, await exchange("GET", REST + path));
    if (path.includes("/reality/")) await new Promise((r) => setTimeout(r, 1100));
  }
}

class Session {
  private id = 0;
  private sid: string | null = null;
  readonly log: Exchange[] = [];
  constructor(readonly url: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json, text/event-stream" };
    if (this.sid) {
      h["mcp-session-id"] = this.sid;
      h["mcp-protocol-version"] = "2025-06-18";
    }
    return h;
  }

  async rpc(method: string, params?: unknown, notify = false) {
    const body = notify ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id: ++this.id, method, params };
    const ex = await exchange("POST", this.url, body, this.headers());
    if (!this.sid && ex.response.headers["mcp-session-id"]) this.sid = ex.response.headers["mcp-session-id"];
    this.log.push(ex);
    console.log(
      `  ${method} ${JSON.stringify(params ?? {}).slice(0, 90)} -> ${ex.response.status} ${ex.latencyMs}ms`,
    );
    return ex;
  }

  async open() {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "slipway-recorder", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", undefined, true);
  }

  call(name: string, args: unknown) {
    return this.rpc("tools/call", { name, arguments: args });
  }
}

async function recordBitgetMcp() {
  const s = new Session("https://agent.bitget.com/mcp");
  await s.open();
  await s.rpc("tools/list", {});
  await s.call("guide", {});
  for (const category of ["equity", "news", "sentiment", "crypto"]) await s.call("guide", { category });
  const day = 86_400_000;
  const now = Date.now();
  await s.call("do_query", { entry_id: "equity_price_quote", params: { symbol: SYM } });
  await s.call("do_query", { entry_id: "equity_calendar", params: { symbol: SYM } });
  await s.call("do_query", {
    entry_id: "equity_fundamental_dividends",
    params: { symbol: SYM, start_time: now - 30 * day, end_time: now + 90 * day },
  });
  await s.call("do_query", { entry_id: "news_label_search", params: { label: 2, page_size: 5 } });
  await s.call("do_query", { entry_id: "news_label_search", params: { label: "stocks-not-an-int" } });
  await s.call("do_query", { entry_id: "sentiment_market_fear_greed", params: {} });
  await s.call("do_query", {
    entry_id: "equity_price_historical",
    params: { symbol: SYM, start_time: now - 10 * day, end_time: now },
  });
  await s.call("do_query", {
    entry_id: "crypto_futures_order_book",
    params: { symbol: `${SYM}/USDT:USDT`, exchange: "bitget", limit: 20 },
  });
  await s.call("do_query", { entry_id: "equity_calendar_earnings", params: { symbol: SYM } });
  save("mcp/bitget-mcp.session.json", s.log);
}

async function recordSignalMcp() {
  const s = new Session("https://datahub.noxiaohao.com/mcp");
  await s.open();
  await s.rpc("tools/list", {});
  const pair = `${SYM}/USDT:USDT`;
  await s.call("crypto_derivatives", { action: "price", symbol: pair, exchange: "bitget" });
  await s.call("crypto_derivatives", { action: "ticker_24h", symbol: pair, exchange: "bitget" });
  await s.call("crypto_derivatives", {
    action: "klines",
    symbol: pair,
    exchange: "bitget",
    timeframe: "1h",
    limit: 60,
  });
  await s.call("technical_analysis", { action: "bollinger", symbol: pair, timeframe: "1h", period: 20 });
  await s.call("technical_analysis", { action: "rsi", symbol: pair, timeframe: "1h", period: 14 });
  await s.call("technical_analysis", { action: "atr", symbol: pair, timeframe: "1h", period: 14 });
  const slow: [string, unknown][] = [
    ["macro_indicators", { action: "multi_indicator" }],
    ["macro_indicators", { action: "fomc_news" }],
    ["tradfi_news", { action: "earnings", symbol: SYM, limit: 10 }],
    ["news_feed", { action: "latest", keyword: SYM, limit: 2 }],
    ["rates_yields", { action: "fed_funds" }],
    ["sentiment_index", { action: "current" }],
  ];
  await Promise.all(slow.map(([name, args]) => s.call(name, args)));
  save("mcp/signal-mcp.session.json", s.log);
}

async function recordWs() {
  const spot = `R${SYM}USDT`;
  const perp = `${SYM}USDT`;
  const messages: { dt: number; data: string }[] = [];
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [
            { instType: "SPOT", channel: "books15", instId: spot },
            { instType: "USDT-FUTURES", channel: "books15", instId: perp },
            { instType: "SPOT", channel: "trade", instId: spot },
            { instType: "USDT-FUTURES", channel: "trade", instId: perp },
            { instType: "SPOT", channel: "ticker", instId: spot },
            { instType: "USDT-FUTURES", channel: "ticker", instId: perp },
            { instType: "SPOT", channel: "books15", instId: "RNOSUCHSYMUSDT" },
          ],
        }),
      );
      ws.send("ping");
    };
    ws.onmessage = (e) => messages.push({ dt: Date.now() - t0, data: String(e.data) });
    setTimeout(() => {
      ws.close();
      resolve();
    }, 25_000);
  });
  const perKind = new Map<string, number>();
  const kept = messages.filter((m) => {
    let kind = m.data;
    try {
      const j = JSON.parse(m.data);
      kind = `${j.event ?? j.action}|${j.arg?.instType}|${j.arg?.channel}`;
    } catch {}
    const n = perKind.get(kind) ?? 0;
    perKind.set(kind, n + 1);
    return n < 3;
  });
  save("ws/public-session.json", { url: "wss://ws.bitget.com/v2/ws/public", recordedAt: t0, messages: kept });
}

const only = process.argv[2];
if (!only || only === "rest") await recordRest();
if (!only || only === "bitget-mcp") await recordBitgetMcp();
if (!only || only === "signal-mcp") await recordSignalMcp();
if (!only || only === "ws") await recordWs();
