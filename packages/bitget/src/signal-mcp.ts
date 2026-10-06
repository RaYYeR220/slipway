// Wrapper over the bitget-signal MCP (https://datahub.noxiaohao.com/mcp, server "market-data-mcp", 19 tools).
// Its ccxt-backed tools answer in ~0.4 s; its third-party feeds (FRED, Finnhub, RSS, alt.me) report failures
// in-band (`{"error": ""}`, all-null payloads) after 15-30 s, so in-band errors are detected and a circuit breaker
// keeps them off the hot path. Indicators are never trusted: we recompute them from the bars (its Bollinger output
// has upper/lower swapped), and its `exchange` argument is checked against Bitget's own bars.
import type { MarketEvent } from "@slipway/core";
import { toEpochMs, toolPayload } from "./bitget-mcp.js";
import { type CachePolicy, type Loaded, SourceCache, stableKey } from "./cache.js";
import { avoidWindow } from "./events.js";
import type { FetchLike } from "./http.js";
import { type Bollinger, bollinger } from "./indicators.js";
import { McpHttpClient } from "./mcp-client.js";
import { nyAt, parseNyLocal } from "./nytime.js";
import { ccxtPerpSymbol } from "./symbols.js";
import type { Candle, IntegrityFlag, Optional } from "./types.js";

export const SIGNAL_MCP_URL = "https://datahub.noxiaohao.com/mcp";

const H = 3_600_000;
export const SIGNAL_POLICIES: Record<"price" | "bars" | "indicator" | "macro" | "news", CachePolicy> = {
  price: { ttlMs: 5_000, maxStaleMs: 60_000, retryAfterMs: 30_000 },
  bars: { ttlMs: 60_000, maxStaleMs: H, retryAfterMs: 30_000 },
  indicator: { ttlMs: 60_000, maxStaleMs: H, retryAfterMs: 30_000 },
  macro: { ttlMs: H, maxStaleMs: 24 * H, retryAfterMs: 10 * 60_000 },
  news: { ttlMs: 5 * 60_000, maxStaleMs: 6 * H, retryAfterMs: 10 * 60_000 },
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const META_KEYS = new Set(["note", "symbol", "timeframe", "source", "period", "action"]);

/** Throws when a tool "succeeded" at the protocol level but carries an upstream failure in its payload. */
export function signalPayload(p: unknown): unknown {
  if (isRec(p)) {
    if ("error" in p) throw new Error(`upstream error: ${JSON.stringify(p.error)}`);
    const errKey = Object.keys(p).find((k) => k.endsWith("_error"));
    if (errKey) throw new Error(`upstream error (${errKey}): ${JSON.stringify(p[errKey])}`);
    const data = Object.entries(p).filter(([k]) => !META_KEYS.has(k));
    if (data.length > 0 && data.every(([, v]) => v === null)) throw new Error("upstream returned only nulls");
    if (data.length > 0 && data.every(([, v]) => isRec(v) && "error" in v)) {
      throw new Error(`all ${data.length} sub-results failed (${data.map(([k]) => k).join(", ")})`);
    }
  }
  if (
    Array.isArray(p) &&
    p.length > 0 &&
    p.every((x) => isRec(x) && "error" in x && Array.isArray(x.items) && x.items.length === 0)
  ) {
    throw new Error(`all ${p.length} feeds failed or empty`);
  }
  return p;
}

export interface SignalPrice {
  price: number;
  bid: number | null;
  ask: number | null;
  ts: number;
}

export interface Signal24h {
  last: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  changePct: number;
  ts: number;
}

export interface BollingerAudit {
  reported: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number | null;
    pctB: number | null;
    position: string | null;
  };
  recomputed: Bollinger;
  barsUsed: number;
  flags: IntegrityFlag[];
}

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** Compares a reported Bollinger result with our recomputation from the same tool's bars. */
export function auditBollinger(
  reported: Rec,
  bars: Candle[],
  period: number,
  source = "bitget-signal.technical_analysis",
): BollingerAudit {
  const upper = optNum(reported.upper);
  const middle = optNum(reported.middle);
  const lower = optNum(reported.lower);
  if (upper === null || middle === null || lower === null) throw new Error("bollinger: missing band values");
  const recomputed = bollinger(
    bars.map((b) => b.close),
    period,
    2,
    1,
  );
  const flags: IntegrityFlag[] = [];
  const tol = 5e-4;
  const swapped = rel(upper, recomputed.lower) < tol && rel(lower, recomputed.upper) < tol;
  if (upper < lower) {
    flags.push({
      code: "SIGNAL_BOLLINGER_INVERTED",
      source,
      severity: "warn",
      detail: `reported upper ${upper} < lower ${lower}${swapped ? "; values equal our lower/upper (labels swapped, sample stdev), so its pct_b and position are wrong" : ""}; using recomputed bands`,
    });
  } else if (rel(upper, recomputed.upper) > tol || rel(lower, recomputed.lower) > tol) {
    flags.push({
      code: "SIGNAL_BOLLINGER_MISMATCH",
      source,
      severity: "warn",
      detail: `reported ${lower}..${upper} vs recomputed ${recomputed.lower.toFixed(4)}..${recomputed.upper.toFixed(4)}`,
    });
  }
  if (rel(middle, recomputed.middle) > tol) {
    flags.push({
      code: "SIGNAL_BOLLINGER_MIDDLE",
      source,
      severity: "info",
      detail: `reported middle ${middle} vs SMA${period} ${recomputed.middle.toFixed(4)} (bars may have rolled)`,
    });
  }
  return {
    reported: {
      upper,
      middle,
      lower,
      bandwidth: optNum(reported.bandwidth),
      pctB: optNum(reported.pct_b),
      position: typeof reported.position === "string" ? reported.position : null,
    },
    recomputed,
    barsUsed: bars.length,
    flags,
  };
}

/**
 * Checks whether bars returned for `exchange=bitget` are Bitget's: matching open times must agree on volume.
 * On 2026-10-06 the tool returned Binance USDT-M NVDA bars (volume 14543.24 vs Bitget 663.32 for the same hour).
 */
export function venueCheck(
  signalBars: Candle[],
  bitgetBars: Candle[],
  source = "bitget-signal.crypto_derivatives",
): IntegrityFlag | null {
  const byTs = new Map(bitgetBars.map((b) => [b.ts, b]));
  const ratios: number[] = [];
  for (const s of signalBars) {
    const b = byTs.get(s.ts);
    if (b && b.volume > 0 && s.volume > 0) ratios.push(Math.abs(Math.log(s.volume / b.volume)));
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)] as number;
  if (med <= Math.log(1.25)) return null;
  return {
    code: "SIGNAL_VENUE_MISMATCH",
    source,
    severity: "warn",
    detail: `bars requested for exchange=bitget differ from Bitget's own by a median volume factor of ${Math.exp(med).toFixed(1)}x over ${ratios.length} matching bars; treat as another venue's data`,
  };
}

/** Finnhub-style earnings rows (`date`, `hour` bmo/amc). */
export function mapFinnhubEarnings(rows: Rec[], symbol: string, source: string): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const r of rows) {
    if (r.symbol && String(r.symbol).toUpperCase() !== symbol.toUpperCase()) continue;
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
    if (!date) continue;
    const hour = String(r.hour ?? "").toLowerCase();
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const [start, end] =
      hour === "bmo"
        ? [nyAt(date, 4), nyAt(date, 10)]
        : hour === "amc"
          ? [nyAt(date, 16), nyAt(next, 10)]
          : [nyAt(date, 4), nyAt(next, 10)];
    out.push({
      kind: "earnings",
      symbol,
      ...avoidWindow(start, end),
      label: `${symbol} earnings ${date} (${hour === "bmo" ? "before open" : hour === "amc" ? "after close" : "time of day not reported"})`,
      source,
    });
  }
  return out;
}

/** Macro rows that carry an explicit future release time become avoid-windows (±30 min); others are ignored. */
export function mapMacroReleases(payload: unknown, from: number, to: number, source: string): MarketEvent[] {
  const rows: Rec[] = isRec(payload)
    ? Object.entries(payload)
        .filter(([, v]) => isRec(v))
        .map(([k, v]) => ({ key: k, ...(v as Rec) }))
    : Array.isArray(payload)
      ? payload.filter(isRec)
      : [];
  const out: MarketEvent[] = [];
  for (const r of rows) {
    const raw = r.next_release ?? r.next_release_date ?? r.release_date;
    const name = String(r.name ?? r.key ?? "macro release");
    let win: { ts: number; windowSec: number } | null = null;
    let timing = "";
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
      win = avoidWindow(nyAt(raw.trim(), 4), nyAt(raw.trim(), 20));
      timing = " (time of day not reported)";
    } else {
      const ts =
        typeof raw === "string"
          ? /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw.trim())
            ? Date.parse(raw)
            : parseNyLocal(raw)
          : toEpochMs(raw);
      if (ts !== null && Number.isFinite(ts)) win = { ts, windowSec: 1800 };
    }
    if (!win || win.ts + win.windowSec * 1000 < from || win.ts - win.windowSec * 1000 > to) continue;
    out.push({ kind: "macro", ...win, label: `${name} release${timing}`, source });
  }
  return out;
}

export interface SignalMcpOptions {
  url?: string;
  fetch?: FetchLike;
  client?: McpHttpClient;
  cache?: SourceCache;
  clock?: () => number;
  fastTimeoutMs?: number;
  slowTimeoutMs?: number;
}

export class SignalMcp {
  readonly client: McpHttpClient;
  readonly cache: SourceCache;
  private readonly clock: () => number;
  private readonly fastMs: number;
  private readonly slowMs: number;

  constructor(opts: SignalMcpOptions = {}) {
    this.fastMs = opts.fastTimeoutMs ?? 8_000;
    this.slowMs = opts.slowTimeoutMs ?? 25_000;
    this.client =
      opts.client ??
      new McpHttpClient({
        url: opts.url ?? SIGNAL_MCP_URL,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        timeoutMs: this.slowMs,
      });
    this.clock = opts.clock ?? opts.cache?.clock ?? Date.now;
    this.cache = opts.cache ?? new SourceCache({ clock: this.clock });
  }

  /** Calls a tool behind the cache; in-band upstream errors become "unavailable". */
  call<T>(
    tool: string,
    args: Record<string, unknown>,
    policy: CachePolicy,
    slow: boolean,
    map: (payload: unknown) => T,
    observedAt?: (value: T) => number | null,
  ): Promise<Optional<T>> {
    const action = typeof args.action === "string" ? `.${args.action}` : "";
    return this.cache.fetch(
      `signal-mcp:${tool}:${stableKey(args)}`,
      `bitget-signal.${tool}`,
      policy,
      async (): Promise<Loaded<T>> => {
        const t0 = performance.now();
        const r = await this.client.callTool(tool, args, slow ? this.slowMs : this.fastMs);
        if (r.isError)
          throw new Error(
            `tool error: ${r.content
              .map((c) => c.text ?? "")
              .join(" ")
              .slice(0, 160)}`,
          );
        const value = map(signalPayload(toolPayload(r)));
        return {
          value,
          asOf: observedAt?.(value) ?? this.clock(),
          detail: `${tool}${action} ${Math.round(performance.now() - t0)} ms`,
        };
      },
    );
  }

  perpPrice(underlying: string, exchange = "bitget"): Promise<Optional<SignalPrice>> {
    return this.call(
      "crypto_derivatives",
      { action: "price", symbol: ccxtPerpSymbol(underlying), exchange },
      SIGNAL_POLICIES.price,
      false,
      (p) => {
        if (!isRec(p)) throw new Error("price: malformed payload");
        const price = optNum(p.price);
        const ts = optNum(p.timestamp);
        if (price === null || ts === null) throw new Error("price: missing price/timestamp");
        return { price, bid: optNum(p.bid), ask: optNum(p.ask), ts };
      },
      (v) => v.ts,
    );
  }

  perp24h(underlying: string, exchange = "bitget"): Promise<Optional<Signal24h>> {
    return this.call(
      "crypto_derivatives",
      { action: "ticker_24h", symbol: ccxtPerpSymbol(underlying), exchange },
      SIGNAL_POLICIES.price,
      false,
      (p) => {
        if (!isRec(p)) throw new Error("ticker_24h: malformed payload");
        const v = [p.last, p.high, p.low, p.volume, p.quote_volume, p.change_pct, p.timestamp].map(optNum);
        if (v.some((x) => x === null)) throw new Error("ticker_24h: missing fields");
        const [last, high, low, volume, quoteVolume, changePct, ts] = v as number[];
        return { last, high, low, volume, quoteVolume, changePct, ts } as Signal24h;
      },
      (v) => v.ts,
    );
  }

  klines(
    underlying: string,
    timeframe = "1h",
    limit = 100,
    exchange = "bitget",
  ): Promise<Optional<Candle[]>> {
    return this.call(
      "crypto_derivatives",
      { action: "klines", symbol: ccxtPerpSymbol(underlying), exchange, timeframe, limit },
      SIGNAL_POLICIES.bars,
      false,
      (p) => {
        if (!Array.isArray(p) || p.length === 0) throw new Error("klines: no bars");
        return p
          .filter(isRec)
          .map((b): Candle => {
            const v = [b.timestamp, b.open, b.high, b.low, b.close, b.volume].map(optNum);
            if (v.some((x) => x === null)) throw new Error("klines: malformed bar");
            const [ts, open, high, low, close, volume] = v as number[];
            return { ts, open, high, low, close, volume, quoteVolume: null } as Candle;
          })
          .sort((a, b) => a.ts - b.ts);
      },
    );
  }

  /** Raw indicator output as reported by the tool (for display/audit only; never fed to the cost model). */
  indicator(
    underlying: string,
    action: "rsi" | "macd" | "bollinger" | "ma" | "ema" | "atr",
    timeframe = "1h",
    period = 14,
  ): Promise<Optional<Rec>> {
    return this.call(
      "technical_analysis",
      { action, symbol: ccxtPerpSymbol(underlying), timeframe, period },
      SIGNAL_POLICIES.indicator,
      false,
      (p) => {
        if (!isRec(p)) throw new Error(`${action}: malformed payload`);
        return p;
      },
    );
  }

  /** Fetches the tool's Bollinger bands and its bars, recomputes, and flags disagreements. */
  async bollingerAudit(
    underlying: string,
    timeframe = "1h",
    period = 20,
    bars = 60,
  ): Promise<Optional<BollingerAudit>> {
    const [rep, kl] = await Promise.all([
      this.indicator(underlying, "bollinger", timeframe, period),
      this.klines(underlying, timeframe, bars),
    ]);
    if (!rep.data || !kl.data) {
      const down = rep.data ? kl : rep;
      return { data: null, source: down.source, latencyMs: Math.max(rep.latencyMs, kl.latencyMs) };
    }
    // The audit is only as fresh as its staler input.
    const status = rep.source.status === "cached" || kl.source.status === "cached" ? "cached" : "live";
    const asOf =
      rep.source.asOf === null || kl.source.asOf === null ? null : Math.min(rep.source.asOf, kl.source.asOf);
    return {
      data: auditBollinger(rep.data, kl.data, period),
      source: {
        ...rep.source,
        status,
        asOf,
        detail:
          `${rep.source.detail ?? ""}; recomputed from ${kl.data.length} bars (${kl.source.status})`.trim(),
      },
      latencyMs: Math.max(rep.latencyMs, kl.latencyMs),
    };
  }

  macroSnapshot(): Promise<Optional<unknown>> {
    return this.call(
      "macro_indicators",
      { action: "multi_indicator" },
      SIGNAL_POLICIES.macro,
      true,
      (p) => p,
    );
  }

  /** Scheduled macro releases inside [from, to] when the tool reports release dates; empty when it reports none. */
  async macroEvents(from: number, to: number): Promise<Optional<MarketEvent[]>> {
    const snap = await this.macroSnapshot();
    if (snap.data === null) return { data: null, source: snap.source, latencyMs: snap.latencyMs };
    return { ...snap, data: mapMacroReleases(snap.data, from, to, "bitget-signal.macro_indicators") };
  }

  fedFunds(): Promise<Optional<{ effective: number | null; upper: number | null; lower: number | null }>> {
    return this.call("rates_yields", { action: "fed_funds" }, SIGNAL_POLICIES.macro, true, (p) => {
      if (!isRec(p)) throw new Error("fed_funds: malformed payload");
      return {
        effective: optNum(p.effective_fed_funds),
        upper: optNum(p.target_upper),
        lower: optNum(p.target_lower),
      };
    });
  }

  earnings(symbol: string, fromDate: string, toDate: string, limit = 10): Promise<Optional<MarketEvent[]>> {
    return this.call(
      "tradfi_news",
      { action: "earnings", symbol, from_date: fromDate, to_date: toDate, limit },
      SIGNAL_POLICIES.macro,
      true,
      (p) => {
        const rows = Array.isArray(p)
          ? p.filter(isRec)
          : isRec(p) && Array.isArray(p.earningsCalendar)
            ? p.earningsCalendar.filter(isRec)
            : null;
        if (!rows) throw new Error("earnings: unexpected payload");
        return mapFinnhubEarnings(rows, symbol, "bitget-signal.tradfi_news");
      },
    );
  }

  newsFeed(
    keyword: string,
    limit = 5,
  ): Promise<Optional<{ feed: string; title: string; publishedAt: number | null; link: string | null }[]>> {
    return this.call("news_feed", { action: "latest", keyword, limit }, SIGNAL_POLICIES.news, true, (p) => {
      if (!Array.isArray(p)) throw new Error("news_feed: unexpected payload");
      return p.filter(isRec).flatMap((f) =>
        (Array.isArray(f.items) ? f.items.filter(isRec) : []).map((it) => ({
          feed: String(f.feed ?? ""),
          title: String(it.title ?? ""),
          publishedAt:
            typeof it.published === "string" ? Date.parse(it.published) || null : optNum(it.published),
          link: typeof it.link === "string" ? it.link : null,
        })),
      );
    });
  }
}
