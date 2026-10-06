import { nyseHolidayClosures } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { mergeHolidays } from "../src/holidays.js";
import { nyOffsetMinutes } from "../src/nytime.js";
import {
  ParseError,
  parseCalendar,
  parseCandles,
  parseContract,
  parseCurrentFunding,
  parseFills,
  parseFundingHistory,
  parseIndexComponents,
  parsePerpTicker,
  parseRestBook,
  parseSpotSymbol,
  parseSpotTicker,
  parseStates,
  parseStockInfo,
} from "../src/parse.js";
import { restBody, restRecordedAt } from "./helpers.js";

const sortedDesc = (xs: number[]) => xs.every((x, i) => i === 0 || (xs[i - 1] as number) > x);
const sortedAsc = (xs: number[]) => xs.every((x, i) => i === 0 || (xs[i - 1] as number) < x);

describe("order books (recorded 2026-10-06, NY overnight session)", () => {
  it("parses the rToken spot book with numeric, sorted, uncrossed levels", () => {
    const b = parseRestBook(restBody("spot-orderbook"), "rtoken", "NVDA");
    expect(b).toMatchObject({ venue: "rtoken", symbol: "NVDA", ts: 1791262941135 });
    expect(b.asks.length).toBe(60);
    expect(b.bids.length).toBe(56);
    expect(b.bids[0]).toEqual({ px: 239.45, sz: 86.4 });
    expect(b.asks[0]).toEqual({ px: 239.47, sz: 0.5978 });
    expect(sortedDesc(b.bids.map((l) => l.px))).toBe(true);
    expect(sortedAsc(b.asks.map((l) => l.px))).toBe(true);
  });

  it("parses perp merge-depth (numbers on the wire, 100 levels per side)", () => {
    const b = parseRestBook(restBody("perp-merge-depth"), "perp", "NVDA");
    expect(b.ts).toBe(1791262941452);
    expect(b.bids).toHaveLength(100);
    expect(b.asks).toHaveLength(100);
    expect(b.asks[0]).toEqual({ px: 239.65, sz: 4.87 });
    expect((b.bids[0] as { px: number }).px).toBeLessThan((b.asks[0] as { px: number }).px);
  });

  it("rejects error envelopes and malformed levels", () => {
    expect(() => parseRestBook(restBody("error-unknown-symbol"), "rtoken", "NOSUCHSYM")).toThrow(/40034/);
    const bad = { code: "00000", data: { ts: "1", bids: [["abc", "1"]], asks: [] } };
    expect(() => parseRestBook(bad, "rtoken", "X")).toThrow(ParseError);
  });
});

describe("tape and tickers", () => {
  it("parses spot and perp fills", () => {
    const spot = parseFills(restBody("spot-fills"));
    const perp = parseFills(restBody("perp-fills"));
    expect(spot.length).toBeGreaterThan(0);
    expect(perp).toHaveLength(20);
    expect(spot[0]).toMatchObject({
      id: "1490791871359479808",
      px: 234.45,
      sz: 0.7406,
      side: "buy",
      ts: 1791158400382,
    });
  });

  it("exposes Bitget-native rToken turnover separately from the mirrored US volume", () => {
    const t = parseSpotTicker(restBody("v3-ticker-spot"));
    expect(t.symbol).toBe("RNVDAUSDT");
    expect(t.platformTurnover24h).not.toBeNull();
    expect(t.turnover24h / (t.platformTurnover24h as number)).toBeGreaterThan(1000);
  });

  it("parses the perp ticker with mark, index and funding", () => {
    const t = parsePerpTicker(restBody("v3-ticker-perp"));
    expect(t.symbol).toBe("NVDAUSDT");
    expect(t.markPrice).toBeGreaterThan(200);
    expect(Math.abs(t.indexPrice / t.markPrice - 1)).toBeLessThan(0.01);
    expect(Number.isFinite(t.fundingRate)).toBe(true);
  });

  it("normalises v2 spot, v2 mix and v3 candles to oldest-first bars", () => {
    for (const name of [
      "spot-candles",
      "spot-history-candles",
      "perp-candles",
      "perp-history-candles",
      "v3-candles-spot",
      "v3-history-candles-perp",
    ]) {
      const c = parseCandles(restBody(name));
      expect(c.length, name).toBeGreaterThan(10);
      expect(sortedAsc(c.map((x) => x.ts)), name).toBe(true);
      for (const bar of c)
        expect(
          bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close),
          name,
        ).toBe(true);
    }
    expect(
      (parseCandles(restBody("perp-candles"))[1] as { ts: number }).ts -
        (parseCandles(restBody("perp-candles"))[0] as { ts: number }).ts,
    ).toBe(3_600_000);
  });
});

describe("instrument reference data", () => {
  it("reads rToken fees and rules from spot symbols", () => {
    const s = parseSpotSymbol(restBody("spot-symbols"));
    expect(s.fees).toEqual({ maker: 0.001, taker: 0.001 });
    expect(s.rules).toMatchObject({
      symbol: "RNVDAUSDT",
      pricePlace: 2,
      qtyPlace: 4,
      minNotional: 10,
      quotePlace: 6,
      buyLimitPriceRatio: 0.1,
    });
    expect(s.rules.priceTick).toBeCloseTo(0.01, 12);
    expect(s.baseCoin).toBe("rNVDA");
  });

  it("reads perp fees, rules and the 8h funding interval from contracts", () => {
    const c = parseContract(restBody("perp-contracts"));
    expect(c.fees).toEqual({ maker: 0.0002, taker: 0.0006 });
    expect(c).toMatchObject({ isRwa: true, fundIntervalHours: 8, maxLeverage: 100, status: "normal" });
    expect(c.rules).toMatchObject({
      symbol: "NVDAUSDT",
      qtyStep: 0.01,
      minQty: 0.01,
      minNotional: 5,
      buyLimitPriceRatio: 0.02,
    });
  });

  it("parses current funding (v2 and v3, v3 adds the cash-dividend fields) and funding history", () => {
    const v2 = parseCurrentFunding(restBody("perp-current-funding"));
    const v3 = parseCurrentFunding(restBody("v3-current-funding"));
    expect(v3).toMatchObject({
      symbol: "NVDAUSDT",
      intervalHours: 8,
      minRate: -0.01,
      maxRate: 0.01,
      cashDividend: null,
      cashDividendTime: null,
    });
    expect(v3.nextFundingTime).toBe(v2.nextFundingTime);
    const h = parseFundingHistory(restBody("perp-funding-history"));
    expect(h).toHaveLength(30);
    expect(sortedAsc(h.map((p) => p.ts))).toBe(true);
    expect((h[1] as { ts: number }).ts - (h[0] as { ts: number }).ts).toBe(8 * 3_600_000);
  });

  it("parses the perp index constituents", () => {
    const c = parseIndexComponents(restBody("index-components"));
    expect(c.map((x) => x.source)).toEqual(["PYTH_PRO", "HYPERLIQUID", "BINANCE_INDEX"]);
    expect(c.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 3);
  });
});

describe("Reality session reference", () => {
  it("maps stock-info trading periods to sessions", () => {
    const s = parseStockInfo(restBody("reality-stock-info"), "NVDA");
    expect(s).toEqual({
      symbol: "NVDA",
      tradingPeriods: ["overnight", "pre_market", "regular", "after_hours"],
      weekendTradable: true,
      unknownPeriods: [],
    });
  });

  it("flags the EST label Bitget publishes while New York is on EDT", () => {
    const now = restRecordedAt("reality-states");
    expect(nyOffsetMinutes(now)).toBe(-240);
    const s = parseStates(restBody("reality-states"), now);
    expect(s.daylightTypeLabel).toBe("standard");
    expect(s.windows.map((w) => `${w.state} ${w.start}-${w.end}`)).toEqual([
      "pre_market 04:00-09:30",
      "regular 09:30-16:00",
      "after_hours 16:00-20:00",
      "overnight 20:00-04:00",
    ]);
    expect(s.flags.map((f) => f.code)).toEqual(["TZ_LABEL_MISMATCH"]);
    const winter = parseStates(restBody("reality-states"), Date.UTC(2026, 0, 15));
    expect(winter.flags).toEqual([]);
  });

  it("reads holiday closures as New York wall clock, not as the EST label says", () => {
    const cal = parseCalendar(restBody("reality-calendar"));
    expect(cal.weeklyClosedDays).toEqual(["SATURDAY", "SUNDAY"]);
    expect(cal.closures.map((c) => `${c.startLocal} -> ${c.endLocal}`)).toEqual([
      "2026-06-18 20:00 -> 2026-06-19 20:00",
      "2026-07-02 20:00 -> 2026-07-03 20:00",
      "2026-09-06 20:00 -> 2026-09-07 20:00",
    ]);
    expect(new Date((cal.closures[0] as { start: number }).start).toISOString()).toBe(
      "2026-06-19T00:00:00.000Z",
    );
    expect(cal.flags.map((f) => f.code)).toEqual(["CALENDAR_TZ_LABEL"]);
  });

  it("static NYSE fallback reproduces every closure Bitget has published, window for window", () => {
    const cal = parseCalendar(restBody("reality-calendar"));
    const statics = nyseHolidayClosures();
    for (const c of cal.closures) {
      expect(
        statics.some((s) => s.start === c.start && s.end === c.end),
        c.startLocal,
      ).toBe(true);
    }
    const now = Date.UTC(2026, 9, 6);
    const merged = mergeHolidays(cal, now);
    expect(merged.staticUsed).toBe(12);
    expect(merged.flags[0]).toMatchObject({ code: "CALENDAR_HORIZON", severity: "info" });
    expect(mergeHolidays(null, now).flags[0]).toMatchObject({ code: "CALENDAR_FALLBACK", severity: "warn" });
    const empty = mergeHolidays({ ...cal, closures: [] }, now);
    expect(empty.flags[0]).toMatchObject({ code: "CALENDAR_EMPTY", severity: "warn" });
    expect(empty.staticUsed).toBe(12);
  });

  it("refuses instrument payloads that omit order minimums instead of assuming none", () => {
    const body = restBody("spot-symbols") as { data: Record<string, unknown>[] };
    const { minTradeUSDT: _, ...row } = body.data[0] as Record<string, unknown>;
    expect(() => parseSpotSymbol({ ...body, data: [row] })).toThrow(/minTradeUSDT/);
  });
});
