import type { MarketEvent } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { SourceCache } from "../src/cache.js";
import { windowStart } from "../src/events.js";
import { atr, rsi } from "../src/indicators.js";
import { parseCandles } from "../src/parse.js";
import {
  auditBollinger,
  mapFinnhubEarnings,
  mapMacroReleases,
  SignalMcp,
  signalPayload,
  venueCheck,
} from "../src/signal-mcp.js";
import type { Candle } from "../src/types.js";
import { mcpReplay, recordedToolText, restBody } from "./helpers.js";

const SESSION = "mcp/signal-mcp.session.json";
const NOW = 1_791_263_000_000;

const make = (overrides: Parameters<typeof mcpReplay>[1] = {}, clock = () => NOW) => {
  const fetch = mcpReplay(SESSION, overrides);
  return { fetch, signal: new SignalMcp({ fetch, cache: new SourceCache({ clock }), clock }) };
};

const recordedBars = (): Candle[] =>
  (
    JSON.parse(recordedToolText(SESSION, "crypto_derivatives", (a) => a.action === "klines")) as Record<
      string,
      number
    >[]
  ).map((b) => ({
    ts: b.timestamp as number,
    open: b.open as number,
    high: b.high as number,
    low: b.low as number,
    close: b.close as number,
    volume: b.volume as number,
    quoteVolume: null,
  }));

describe("ccxt-backed tools (respond live)", () => {
  it("reads price, 24h ticker and klines", async () => {
    const { signal } = make();
    const [price, t24, bars] = await Promise.all([
      signal.perpPrice("NVDA"),
      signal.perp24h("NVDA"),
      signal.klines("NVDA", "1h", 60),
    ]);
    expect(price.data).toEqual({ price: 239.66, bid: null, ask: null, ts: 1791262981530 });
    expect(price.source).toMatchObject({
      id: "bitget-signal.crypto_derivatives",
      status: "live",
      asOf: 1791262981530, // upstream observation time, not our fetch time
    });
    expect(t24.data).toMatchObject({ last: 239.66, high: 240.49, low: 235.07 });
    expect(bars.data).toHaveLength(60);
    expect((bars.data as Candle[])[1]?.ts).toBe(((bars.data as Candle[])[0]?.ts as number) + 3_600_000);
  });

  it("catches the inverted Bollinger output and recomputes it (sample stdev, labels swapped)", async () => {
    const { signal } = make();
    const audit = await signal.bollingerAudit("NVDA", "1h", 20);
    const a = audit.data;
    expect(a?.reported).toMatchObject({
      upper: 235.1542,
      middle: 238.532,
      lower: 241.9098,
      position: "above_upper",
    });
    expect(a?.recomputed.middle).toBeCloseTo(238.532, 3);
    expect(a?.recomputed.upper).toBeCloseTo(241.9098, 3);
    expect(a?.recomputed.lower).toBeCloseTo(235.1542, 3);
    expect(a?.recomputed.pctB).toBeCloseTo(1 - (a?.reported.pctB as number), 2);
    expect(a?.flags.map((f) => f.code)).toEqual(["SIGNAL_BOLLINGER_INVERTED"]);
    expect(a?.flags[0]?.detail).toMatch(/labels swapped/);
  });

  it("agrees with its RSI and ATR within the difference expected from history length", () => {
    const bars = recordedBars();
    const reportedRsi = JSON.parse(recordedToolText(SESSION, "technical_analysis", (a) => a.action === "rsi"))
      .rsi as number;
    const reportedAtr = JSON.parse(recordedToolText(SESSION, "technical_analysis", (a) => a.action === "atr"))
      .atr as number;
    expect(
      Math.abs(
        rsi(
          bars.map((b) => b.close),
          14,
        ) - reportedRsi,
      ),
    ).toBeLessThan(0.5);
    expect(Math.abs(atr(bars, 14) / reportedAtr - 1)).toBeLessThan(0.02);
  });

  it("detects that exchange=bitget bars are not Bitget's own (they match Binance USDT-M)", () => {
    const bitget = parseCandles(restBody("perp-candles"));
    const flag = venueCheck(recordedBars(), bitget);
    expect(flag?.code).toBe("SIGNAL_VENUE_MISMATCH");
    expect(flag?.detail).toMatch(/median volume factor of \d+\.\dx over \d+ matching bars/);
    expect(venueCheck(bitget, bitget)).toBeNull();
  });
});

describe("third-party tools (in-band failures recorded 2026-10-06)", () => {
  it("turns `{error}`, `*_error`, all-null and all-feeds-empty payloads into unavailable", async () => {
    const { signal } = make();
    const results = await Promise.all([
      signal.macroSnapshot(),
      signal.fedFunds(),
      signal.earnings("NVDA", "2026-10-06", "2026-10-20"),
      signal.newsFeed("NVDA", 2),
      signal.call("sentiment_index", { action: "current" }, { ttlMs: 0, maxStaleMs: 0 }, true, (p) => p),
      signal.macroEvents(NOW, NOW + 14 * 86_400_000),
    ]);
    const details = results.map((r) => r.source.detail);
    for (const r of results)
      expect(r).toMatchObject({ data: null, source: { status: "unavailable", since: NOW } });
    expect(details[0]).toMatch(/all 4 sub-results failed \(cpi, /);
    expect(details[1]).toMatch(/only nulls/);
    expect(details[3]).toMatch(/all \d+ feeds failed or empty/);
    expect(details[4]).toMatch(/alt_me_error/);
  });

  it("does not hammer a dead feed: the breaker defers retries", async () => {
    let t = NOW;
    const { signal, fetch } = make({}, () => t);
    await signal.fedFunds();
    t += 60_000;
    const again = await signal.fedFunds();
    expect(fetch.calls.filter((c) => c.includes("rates_yields"))).toHaveLength(1);
    expect(again.source.detail).toMatch(/retry deferred/);
  });

  it("classifies payloads", () => {
    expect(() => signalPayload({ error: "" })).toThrow();
    expect(() => signalPayload({ effective_fed_funds: null, target_upper: null, note: "x" })).toThrow(
      /nulls/,
    );
    expect(signalPayload({ price: 1, bid: null })).toEqual({ price: 1, bid: null });
    expect(signalPayload([])).toEqual([]);
  });

  it("maps Finnhub-style earnings rows when that feed works", () => {
    const ev = mapFinnhubEarnings(
      [
        { symbol: "NVDA", date: "2026-11-18", hour: "amc" },
        { symbol: "AMD", date: "2026-11-04", hour: "amc" },
      ],
      "NVDA",
      "bitget-signal.tradfi_news",
    );
    expect(ev).toHaveLength(1);
    expect(new Date(windowStart(ev[0] as MarketEvent)).toISOString()).toBe("2026-11-18T21:00:00.000Z");
  });

  it("flags a Bollinger result that disagrees without being inverted", () => {
    const bars = recordedBars();
    const a = auditBollinger({ upper: 250, middle: 238.532, lower: 230 }, bars, 20);
    expect(a.flags.map((f) => f.code)).toEqual(["SIGNAL_BOLLINGER_MISMATCH"]);
  });
});

describe("macro releases and audit freshness", () => {
  it("places releases in New York time and widens date-only releases to the session day", () => {
    const from = Date.UTC(2026, 9, 1);
    const to = Date.UTC(2026, 10, 30);
    const ev = mapMacroReleases(
      {
        cpi: { name: "CPI", next_release: "2026-10-14 08:30" },
        nfp: { name: "NFP", next_release: "2026-11-06" },
        gdp: { name: "GDP", next_release: "2027-01-29" },
      },
      from,
      to,
      "bitget-signal.macro_indicators",
    );
    expect(ev.map((e) => [e.label, new Date(windowStart(e)).toISOString(), e.windowSec])).toEqual([
      ["CPI release", "2026-10-14T12:00:00.000Z", 1800],
      ["NFP release (time of day not reported)", "2026-11-06T09:00:00.000Z", 8 * 3600],
    ]);
  });

  it("labels the Bollinger audit by its staler input", async () => {
    let t = NOW;
    const clock = () => t;
    const cache = new SourceCache({ clock });
    await new SignalMcp({ fetch: mcpReplay(SESSION), cache, clock }).klines("NVDA", "1h", 60);
    t += 120_000;
    const barsDown = mcpReplay(SESSION, {
      "tools/call crypto_derivatives": () => new Response("down", { status: 503 }),
    });
    const audit = await new SignalMcp({ fetch: barsDown, cache, clock }).bollingerAudit("NVDA");
    expect(audit.data?.flags.map((f) => f.code)).toEqual(["SIGNAL_BOLLINGER_INVERTED"]);
    expect(audit.source).toMatchObject({
      id: "bitget-signal.technical_analysis",
      status: "cached",
      asOf: NOW,
    });
    expect(audit.source.detail).toMatch(/recomputed from 60 bars \(cached\)/);
  });
});
