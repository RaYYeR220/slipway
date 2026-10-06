// Wrapper over bitget-mcp-server (https://agent.bitget.com/mcp): a 2-tool gateway (`guide`, `do_query`) to a
// 67-entry data catalog. Entry ids drift between server versions, so they are resolved at runtime from `guide`
// (known ids are only a fallback). Every call goes through the freshness cache and degrades to
// `status: "unavailable"` (its upstream answered 503 for every entry on 2026-10-05/06) — never a fabricated value.
import type { Level, MarketEvent } from "@slipway/core";
import { type CachePolicy, type Loaded, SourceCache, stableKey } from "./cache.js";
import { avoidWindow } from "./events.js";
import type { FetchLike } from "./http.js";
import { type McpCallResult, McpHttpClient } from "./mcp-client.js";
import { addDays, nyAt, nyDate } from "./nytime.js";
import { ccxtPerpSymbol } from "./symbols.js";
import type { Optional } from "./types.js";

export const BITGET_MCP_URL = "https://agent.bitget.com/mcp";

export interface CatalogEntry {
  id: string;
  category: string;
  urlPath: string;
  subcategory: string | null;
  title: string | null;
  params: { name: string; required: boolean; type: string }[];
}

export type LogicalEntry =
  | "equityQuote"
  | "equityDailyBars"
  | "earnings"
  | "dividends"
  | "news"
  | "marketFearGreed"
  | "futuresOrderBook"
  | "futuresTicker";

/** Known ids as of server 4.0.5 (2026-10-05). Used only when runtime discovery cannot resolve an entry. */
export const KNOWN_ENTRIES: Record<
  LogicalEntry,
  { category: string; id: string; urlPath: string; aliases?: string[] }
> = {
  equityQuote: { category: "equity", id: "equity_price_quote", urlPath: "equity/price/quote" },
  equityDailyBars: { category: "equity", id: "equity_price_historical", urlPath: "equity/price/historical" },
  earnings: {
    category: "equity",
    id: "equity_calendar",
    urlPath: "equity/calendar",
    aliases: ["equity_calendar_earnings"],
  },
  dividends: {
    category: "equity",
    id: "equity_fundamental_dividends",
    urlPath: "equity/fundamental/dividends",
  },
  news: { category: "news", id: "news_label_search", urlPath: "news/label_search" },
  marketFearGreed: {
    category: "sentiment",
    id: "sentiment_market_fear_greed",
    urlPath: "sentiment/market_fear_greed",
  },
  futuresOrderBook: {
    category: "crypto",
    id: "crypto_futures_order_book",
    urlPath: "crypto/futures/order_book",
  },
  futuresTicker: { category: "crypto", id: "crypto_futures_ticker", urlPath: "crypto/futures/ticker" },
};

export interface ResolvedEntry {
  id: string;
  resolvedBy: "guide:id" | "guide:alias" | "guide:url_path" | "fallback";
  entry: CatalogEntry | null;
}

const H = 3_600_000;
export const BITGET_MCP_POLICIES: Record<
  "catalog" | "quote" | "bars" | "events" | "news" | "sentiment" | "book",
  CachePolicy
> = {
  catalog: { ttlMs: 6 * H, maxStaleMs: 7 * 24 * H, retryAfterMs: 60_000 },
  quote: { ttlMs: 15_000, maxStaleMs: H, retryAfterMs: 30_000 },
  bars: { ttlMs: 6 * H, maxStaleMs: 7 * 24 * H, retryAfterMs: 60_000 },
  events: { ttlMs: 6 * H, maxStaleMs: 7 * 24 * H, retryAfterMs: 60_000 },
  news: { ttlMs: 5 * 60_000, maxStaleMs: 6 * H, retryAfterMs: 60_000 },
  sentiment: { ttlMs: H, maxStaleMs: 24 * H, retryAfterMs: 60_000 },
  book: { ttlMs: 5_000, maxStaleMs: 0, retryAfterMs: 30_000 },
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON payload of a tool result: `structuredContent` when present, else the first text block parsed as JSON. */
export function toolPayload(r: McpCallResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content.find((c) => c.type === "text")?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const stripHtml = (s: string): string =>
  (/<title>([^<]*)<\/title>/i.exec(s)?.[1] ?? s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Unwraps `{success, status_code, data, error}`; throws with the upstream status on failure. */
export function doQueryData(r: McpCallResult): unknown {
  if (r.isError)
    throw new Error(
      `do_query tool error: ${r.content
        .map((c) => c.text ?? "")
        .join(" ")
        .slice(0, 160)}`,
    );
  const p = toolPayload(r);
  if (!isRec(p) || typeof p.success !== "boolean") throw new Error("do_query: unexpected payload shape");
  if (!p.success) {
    const status = p.status_code === null || p.status_code === undefined ? "" : `upstream ${p.status_code}`;
    const err =
      typeof p.error === "string" && p.error
        ? p.error
        : typeof p.data === "string"
          ? stripHtml(p.data).slice(0, 80)
          : "";
    throw new Error([status, err].filter(Boolean).join(": ") || "do_query failed");
  }
  return p.data;
}

/** Rows from a catalog response whose envelope is not documented: an array, or the first array field of an object. */
export function rowsOf(data: unknown): Rec[] {
  if (Array.isArray(data)) return data.filter(isRec);
  if (isRec(data)) {
    for (const k of ["items", "list", "data", "rows", "records", "result", "results"]) {
      const v = data[k];
      if (Array.isArray(v)) return v.filter(isRec);
    }
    return [data];
  }
  return [];
}

const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Timestamps of unknown unit (s, ms, µs, ns — SIP timestamps are ns) or ISO strings -> epoch ms. */
export function toEpochMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return Math.round(n * 1000);
  if (n < 1e14) return Math.round(n);
  if (n < 1e17) return Math.round(n / 1e3);
  return Math.round(n / 1e6);
}

/** Calendar date from "YYYY-MM-DD…", an exact "YYYYMMDD", or an epoch timestamp (read as a New York date). */
export function ymdOf(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ms = toEpochMs(v);
  return ms === null ? null : nyDate(ms);
}

export interface EquityQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  prevClose: number | null;
  changePct: number | null;
  lastTradeTs: number | null;
  sipTs: number | null;
  participantTs: number | null;
  trfTs: number | null;
  quoteConditions: string | null;
  salesConditions: string | null;
  marketCenter: string | null;
  /** Seconds since the last cash-market print (null when no timestamp was reported). */
  cashStalenessSec: number | null;
}

export function mapEquityQuote(row: Rec, now: number): EquityQuote {
  const lastTradeTs = toEpochMs(row.last_timestamp);
  const sipTs = toEpochMs(row.sip_timestamp);
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const q: EquityQuote = {
    symbol: String(row.symbol ?? ""),
    last: optNum(row.last_price),
    bid: optNum(row.bid),
    ask: optNum(row.ask),
    bidSize: optNum(row.bid_size),
    askSize: optNum(row.ask_size),
    prevClose: optNum(row.prev_close),
    changePct: optNum(row.change_percent),
    lastTradeTs,
    sipTs,
    participantTs: toEpochMs(row.participant_timestamp),
    trfTs: toEpochMs(row.trf_timestamp),
    quoteConditions: s(row.quote_conditions),
    salesConditions: s(row.sales_conditions),
    marketCenter: s(row.market_center),
    cashStalenessSec: null,
  };
  return { ...q, cashStalenessSec: stalenessSec(q, now) };
}

/** Seconds since the newest cash-market timestamp; recomputed on every read so a cached quote ages honestly. */
export function stalenessSec(q: Pick<EquityQuote, "lastTradeTs" | "sipTs">, now: number): number | null {
  const latest = Math.max(q.lastTradeTs ?? 0, q.sipTs ?? 0);
  return latest > 0 ? Math.max(0, Math.round((now - latest) / 1000)) : null;
}

/** Earnings-calendar rows -> avoid-windows. Pre-market reports block 04:00-10:00 NY, after-close 16:00 -> next 10:00. */
export function mapEarnings(rows: Rec[], symbol: string, source: string): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const r of rows) {
    const actual = ymdOf(r.perf_report_dsclsr_date);
    const forecast = ymdOf(r.perf_report_fore_dsclsr_date);
    const date = actual ?? forecast;
    if (!date) continue;
    const when = String(r.is_trading_time ?? "").toLowerCase();
    const pre = /前|pre|before|bmo/.test(when);
    const post = /后|後|after|post|amc/.test(when);
    const [start, end, timing] = pre
      ? [nyAt(date, 4), nyAt(date, 10), "before open"]
      : post
        ? [nyAt(date, 16), nyAt(addDays(date, 1), 10), "after close"]
        : [nyAt(date, 4), nyAt(addDays(date, 1), 10), "time of day not reported"];
    const period = r.period_ending
      ? ` for period ending ${ymdOf(r.period_ending) ?? String(r.period_ending)}`
      : "";
    out.push({
      kind: "earnings",
      symbol,
      ...avoidWindow(start, end),
      label: `${symbol} earnings ${date} (${timing}, ${actual ? "reported date" : "expected date"})${period}`,
      source,
    });
  }
  return out;
}

/** Dividend / split rows -> windows from the prior close (16:00 NY) to 09:45 NY on the effective date. */
export function mapCorporateActions(rows: Rec[], symbol: string, source: string): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const r of rows) {
    const type = String(r.event_type ?? "");
    const isSplit =
      /拆分|split/i.test(type) ||
      (r.split_numerator !== undefined && r.split_numerator !== null && r.split_numerator !== "");
    const date = isSplit
      ? (ymdOf(r.split_valid_date) ?? ymdOf(r.ex_dividend_date))
      : ymdOf(r.ex_dividend_date);
    if (!date) continue;
    const start = nyAt(addDays(date, -1), 16);
    const end = nyAt(date, 9, 45);
    const detail = isSplit
      ? `split ${r.split_numerator ?? "?"}:${r.split_denominator ?? "?"}`
      : `ex-dividend${optNum(r.amount) !== null ? ` ${optNum(r.amount)} ${String(r.currency ?? "")}`.trimEnd() : ""}${r.is_special_dividend === "true" || r.is_special_dividend === "1" ? " (special)" : ""}`;
    out.push({
      kind: isSplit ? "split" : "ex_dividend",
      symbol,
      ...avoidWindow(start, end),
      label: `${symbol} ${detail} effective ${date}`,
      source,
    });
  }
  return out;
}

export interface NewsItem {
  title: string;
  summary: string;
  publishedAt: number | null;
  labels: string[];
  language: string | null;
  source: string;
}

export const NEWS_LABELS = { crypto: 1, stocks: 2, fx_commodities: 6, macro: 7 } as const;

export function mapNews(rows: Rec[], source: string): NewsItem[] {
  return rows
    .filter((r) => typeof r.title === "string" && r.title !== "")
    .map((r) => ({
      title: String(r.title),
      summary: String(r.content ?? "").slice(0, 500),
      publishedAt: toEpochMs(r.published_at) ?? toEpochMs(r.date),
      labels: Array.isArray(r.labels)
        ? r.labels.map(String)
        : r.labels
          ? String(r.labels).split(/[,;]\s*/)
          : [],
      language: r.language ? String(r.language) : null,
      source,
    }));
}

export interface FearGreed {
  score: number;
  rating: string | null;
  ts: number | null;
  previousClose: number | null;
  previousWeek: number | null;
  previousMonth: number | null;
}

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
}

export function mapDailyBars(rows: Rec[]): DailyBar[] {
  const out: DailyBar[] = [];
  for (const r of rows) {
    const date = ymdOf(r.date);
    const [o, h, l, c, v] = [
      optNum(r.open),
      optNum(r.high),
      optNum(r.low),
      optNum(r.close),
      optNum(r.volume),
    ];
    if (!date || o === null || h === null || l === null || c === null || v === null) continue;
    out.push({ date, open: o, high: h, low: l, close: c, volume: v, vwap: optNum(r.vwap) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const levelsOf = (v: unknown): Level[] => {
  const rows = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  if (!Array.isArray(rows)) return [];
  const out: Level[] = [];
  for (const row of rows) {
    const [px, sz] = Array.isArray(row)
      ? [optNum(row[0]), optNum(row[1])]
      : isRec(row)
        ? [optNum(row.price), optNum(row.amount ?? row.size)]
        : [null, null];
    if (px !== null && sz !== null && px > 0 && sz > 0) out.push({ px, sz });
  }
  return out;
};

export interface ExternalBook {
  exchange: string;
  symbol: string;
  ts: number | null;
  bids: Level[];
  asks: Level[];
}

export interface BitgetDataMcpOptions {
  url?: string;
  fetch?: FetchLike;
  client?: McpHttpClient;
  cache?: SourceCache;
  clock?: () => number;
  timeoutMs?: number;
}

export class BitgetDataMcp {
  readonly client: McpHttpClient;
  readonly cache: SourceCache;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(opts: BitgetDataMcpOptions = {}) {
    this.client =
      opts.client ??
      new McpHttpClient({
        url: opts.url ?? BITGET_MCP_URL,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
    this.clock = opts.clock ?? opts.cache?.clock ?? Date.now;
    this.cache = opts.cache ?? new SourceCache({ clock: this.clock });
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Catalog entries of one category, discovered through `guide`. */
  guide(category: string): Promise<Optional<CatalogEntry[]>> {
    return this.cache.fetch(
      `bitget-mcp:guide:${category}`,
      `bitget-mcp.guide.${category}`,
      BITGET_MCP_POLICIES.catalog,
      async () => {
        const r = await this.client.callTool("guide", { category }, this.timeoutMs);
        const p = toolPayload(r);
        if (!isRec(p) || !Array.isArray(p.entries)) throw new Error("guide: no entries in response");
        const entries = p.entries.filter(isRec).map(
          (e): CatalogEntry => ({
            id: String(e.id),
            category,
            urlPath: String(e.url_path ?? ""),
            subcategory: e.subcategory ? String(e.subcategory) : null,
            title: e.title ? String(e.title) : null,
            params: Array.isArray(e.params_summary)
              ? e.params_summary.filter(isRec).map((x) => ({
                  name: String(x.name),
                  required: x.required === true,
                  type: String(x.type ?? ""),
                }))
              : [],
          }),
        );
        return {
          value: entries,
          asOf: this.clock(),
          detail: `${entries.length} entries (server ${this.client.serverInfo?.version ?? "?"})`,
        };
      },
    );
  }

  async resolve(logical: LogicalEntry): Promise<ResolvedEntry> {
    const known = KNOWN_ENTRIES[logical];
    const { data } = await this.guide(known.category);
    if (data) {
      const byId = data.find((e) => e.id === known.id);
      if (byId) return { id: byId.id, resolvedBy: "guide:id", entry: byId };
      const byAlias = data.find((e) => known.aliases?.includes(e.id));
      if (byAlias) return { id: byAlias.id, resolvedBy: "guide:alias", entry: byAlias };
      const byPath =
        data.find((e) => e.urlPath === known.urlPath) ??
        data.find((e) => e.urlPath.startsWith(known.urlPath));
      if (byPath) return { id: byPath.id, resolvedBy: "guide:url_path", entry: byPath };
    }
    return { id: known.id, resolvedBy: "fallback", entry: null };
  }

  /** Executes a catalog entry behind the cache; `map` turns the raw `data` into a typed value. */
  async query<T>(
    logical: LogicalEntry,
    params: Record<string, unknown>,
    policy: CachePolicy,
    map: (data: unknown, sourceId: string) => T,
  ): Promise<Optional<T>> {
    const resolved = await this.resolve(logical);
    const key = `bitget-mcp:${resolved.id}:${stableKey(params)}`;
    const sourceId = `bitget-mcp.${resolved.id}`;
    const out = await this.cache.fetch(key, sourceId, policy, async (): Promise<Loaded<T>> => {
      const t0 = performance.now();
      const r = await this.client.callTool("do_query", { entry_id: resolved.id, params }, this.timeoutMs);
      const value = map(doQueryData(r), sourceId);
      return {
        value,
        asOf: this.clock(),
        detail: `do_query ${resolved.id} ${Math.round(performance.now() - t0)} ms`,
      };
    });
    // `out` may be shared with concurrent callers through the cache's in-flight map: never mutate it.
    if (resolved.resolvedBy === "guide:id") return out;
    const detail =
      `${out.source.detail ?? ""} [entry ${resolved.id} resolved by ${resolved.resolvedBy}]`.trim();
    return { ...out, source: { ...out.source, detail } };
  }

  async equityQuote(symbol: string): Promise<Optional<EquityQuote>> {
    const r = await this.query("equityQuote", { symbol }, BITGET_MCP_POLICIES.quote, (d) => {
      const row = rowsOf(d)[0];
      if (!row) throw new Error("equity quote: empty data");
      return mapEquityQuote(row, this.clock());
    });
    return r.data ? { ...r, data: { ...r.data, cashStalenessSec: stalenessSec(r.data, this.clock()) } } : r;
  }

  earnings(symbol: string, from: number, to: number): Promise<Optional<MarketEvent[]>> {
    return this.query(
      "earnings",
      { symbol, start_date: nyDate(from), end_date: nyDate(to) },
      BITGET_MCP_POLICIES.events,
      (d, id) => mapEarnings(rowsOf(d), symbol, id),
    );
  }

  /** Cash dividends and splits (the dividends entry carries both, distinguished by `event_type`). */
  corporateActions(symbol: string, from: number, to: number): Promise<Optional<MarketEvent[]>> {
    return this.query(
      "dividends",
      { symbol, start_time: from, end_time: to },
      BITGET_MCP_POLICIES.events,
      (d, id) => mapCorporateActions(rowsOf(d), symbol, id),
    );
  }

  news(
    label: keyof typeof NEWS_LABELS,
    opts: { from?: number; to?: number; pageSize?: number } = {},
  ): Promise<Optional<NewsItem[]>> {
    const params: Record<string, unknown> = { label: NEWS_LABELS[label], page_size: opts.pageSize ?? 20 };
    if (opts.from !== undefined) params.start_time = opts.from;
    if (opts.to !== undefined) params.end_time = opts.to;
    return this.query("news", params, BITGET_MCP_POLICIES.news, (d, id) =>
      mapNews(rowsOf(d), `${id}.${label}`),
    );
  }

  marketFearGreed(): Promise<Optional<FearGreed>> {
    return this.query("marketFearGreed", {}, BITGET_MCP_POLICIES.sentiment, (d) => {
      const r = rowsOf(d)[0];
      const score = r ? optNum(r.score) : null;
      if (!r || score === null) throw new Error("fear & greed: no score in data");
      return {
        score,
        rating: r.rating ? String(r.rating) : null,
        ts: toEpochMs(r.timestamp),
        previousClose: optNum(r.previous_close),
        previousWeek: optNum(r.previous_1_week),
        previousMonth: optNum(r.previous_1_month),
      };
    });
  }

  equityDailyBars(symbol: string, from: number, to: number): Promise<Optional<DailyBar[]>> {
    return this.query(
      "equityDailyBars",
      { symbol, start_time: from, end_time: to },
      BITGET_MCP_POLICIES.bars,
      (d) => {
        const bars = mapDailyBars(rowsOf(d));
        if (bars.length === 0) throw new Error("daily bars: no complete rows");
        return bars;
      },
    );
  }

  /** Cross-exchange stock-perp book (ccxt symbol), e.g. Hyperliquid or Binance vs Bitget. */
  futuresOrderBook(underlying: string, exchange: string, limit = 20): Promise<Optional<ExternalBook>> {
    const symbol = ccxtPerpSymbol(underlying);
    return this.query("futuresOrderBook", { symbol, exchange, limit }, BITGET_MCP_POLICIES.book, (d) => {
      const r = rowsOf(d)[0];
      if (!r) throw new Error("order book: empty data");
      const book = {
        exchange,
        symbol,
        ts: toEpochMs(r.timestamp),
        bids: levelsOf(r.bids),
        asks: levelsOf(r.asks),
      };
      book.bids.sort((a, b) => b.px - a.px);
      book.asks.sort((a, b) => a.px - b.px);
      if (book.bids.length === 0 && book.asks.length === 0) throw new Error("order book: no levels");
      return book;
    });
  }

  futuresTicker(underlying: string, exchange: string): Promise<Optional<ExternalTicker>> {
    const symbol = ccxtPerpSymbol(underlying);
    return this.query("futuresTicker", { symbol, exchange }, BITGET_MCP_POLICIES.book, (d) => {
      const r = rowsOf(d)[0];
      const last = r ? optNum(r.last) : null;
      if (!r || last === null) throw new Error("ticker: no last price");
      return { exchange, symbol, ts: toEpochMs(r.timestamp), last, bid: optNum(r.bid), ask: optNum(r.ask) };
    });
  }
}

export interface ExternalTicker {
  exchange: string;
  symbol: string;
  ts: number | null;
  last: number;
  bid: number | null;
  ask: number | null;
}
