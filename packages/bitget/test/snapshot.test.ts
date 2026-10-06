import type { LiquidityStats } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { BitgetDataMcp } from "../src/bitget-mcp.js";
import { SourceCache } from "../src/cache.js";
import { BitgetRest } from "../src/rest.js";
import { SignalMcp } from "../src/signal-mcp.js";
import { loadMarketSnapshot, perpDividendEvent, SnapshotError } from "../src/snapshot.js";
import { fakeSleep, fixture, mcpReplay, restRecordedAt, restReplay } from "./helpers.js";

const NOW = restRecordedAt("spot-orderbook");

function deps(restOverrides: Parameters<typeof restReplay>[0] = {}, clock = () => NOW) {
  const cache = new SourceCache({ clock });
  const rest = new BitgetRest({
    fetch: restReplay(restOverrides),
    sleep: fakeSleep(),
    random: () => 0.5,
    clock,
  });
  return {
    rest,
    cache,
    dataMcp: new BitgetDataMcp({ fetch: mcpReplay("mcp/bitget-mcp.session.json"), cache, clock }),
    signal: new SignalMcp({ fetch: mcpReplay("mcp/signal-mcp.session.json"), cache, clock }),
  };
}

const down = () => new Response("<html>503</html>", { status: 503 });

const stats = (symbol: string): LiquidityStats => ({
  symbol,
  venue: "perp",
  session: "overnight",
  n: 0,
  from: 0,
  to: 0,
  spreadBps: { p10: 0, p50: 0, p90: 0 },
  depthUsd: { b10: { p10: 0, p50: 0 }, b25: { p10: 0, p50: 0 }, b50: { p10: 0, p50: 0 } },
  resilience: null,
  sigmaBpsPerSqrtSec: 0,
  tradeNotionalPerMin: { p50: 0, mean: 0 },
  touchHitRatePerMin: 0,
  medianTradeQty: 0,
});

describe("loadMarketSnapshot on recorded data (NVDA, 2026-10-06 overnight session)", () => {
  it("assembles books, fees, funding, sessions, holidays, index and full provenance", async () => {
    const snap = await loadMarketSnapshot("nvda", {
      ...deps(),
      now: NOW,
      atlas: { "NVDA|perp|overnight": stats("NVDA"), "TSLA|perp|overnight": stats("TSLA") },
    });
    expect(snap.symbol).toBe("NVDA");
    expect(Object.keys(snap.books).sort()).toEqual(["perp", "rtoken"]);
    expect(snap.books.rtoken?.asks[0]).toEqual({ px: 239.47, sz: 0.5978 });
    expect(snap.fees).toEqual({
      rtoken: { maker: 0.001, taker: 0.001 },
      perp: { maker: 0.0002, taker: 0.0006 },
    });
    expect(snap.funding).toMatchObject({ intervalHours: 8 });
    expect(snap.funding?.nextFundingTime).toBeGreaterThan(NOW);
    expect(snap.sessions).toEqual({
      symbol: "NVDA",
      tradingPeriods: ["overnight", "pre_market", "regular", "after_hours"],
      weekendTradable: true,
    });
    expect(snap.indexComponents?.map((c) => c.source)).toEqual(["PYTH_PRO", "HYPERLIQUID", "BINANCE_INDEX"]);
    expect(Object.keys(snap.atlas)).toEqual(["NVDA|perp|overnight"]);
    expect(snap.rules.perp.symbol).toBe("NVDAUSDT");
    expect(snap.tickers.rtoken?.platformTurnover24h).toBeGreaterThan(0);

    expect(snap.holidays.slice(0, 6).map((h) => new Date(h.end).toISOString().slice(0, 10))).toEqual([
      "2026-06-20",
      "2026-07-04",
      "2026-09-08",
      "2026-11-27",
      "2026-12-26",
      "2027-01-02",
    ]);
    expect(snap.holidays).toHaveLength(3 + 12);
    expect(snap.holidays[3]?.label).toBe("2026-11-26 Thanksgiving Day (NYSE static fallback)");
    expect(snap.events).toEqual([]);

    expect(snap.sources.map((s) => [s.id, s.status])).toEqual([
      ["bitget.spot.orderbook", "live"],
      ["bitget.mix.orderbook", "live"],
      ["bitget.spot.symbol", "live"],
      ["bitget.mix.contract", "live"],
      ["bitget.mix.funding", "live"],
      ["bitget.mix.index", "live"],
      ["bitget.spot.ticker", "live"],
      ["bitget.mix.ticker", "live"],
      ["bitget.spot.fills", "live"],
      ["bitget.reality.session", "live"],
      ["bitget.reality.session-states", "live"],
      ["bitget.reality.calendar", "live"],
      ["static.nyse-holidays", "cached"],
      ["bitget-mcp.equity_calendar", "unavailable"],
      ["bitget-mcp.equity_fundamental_dividends", "unavailable"],
      ["bitget-signal.macro_indicators", "unavailable"],
    ]);
    for (const s of snap.sources.filter((x) => x.status === "unavailable")) expect(s.since).toBe(NOW);

    expect(snap.integrity.map((f) => f.code)).toEqual([
      "TZ_LABEL_MISMATCH",
      "CALENDAR_TZ_LABEL",
      "CALENDAR_HORIZON",
      "RTOKEN_VOLUME_MIRROR",
      "RTOKEN_TAPE_SILENT",
    ]);
    expect(snap.integrity.find((f) => f.code === "RTOKEN_TAPE_SILENT")?.detail).toMatch(
      /last public rToken print 2\d\.\d h ago/,
    );
  });

  it("fails closed when session reference data is unavailable and was never cached", async () => {
    const err = await loadMarketSnapshot("NVDA", {
      ...deps({ "/api/v3/reality/market/stock-info": down }),
      now: NOW,
      dataMcp: null,
      signal: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err.message).toMatch(/Reality stock-info \(sessions\)/);
    expect(err.sources.find((s: { id: string }) => s.id === "bitget.reality.session")).toMatchObject({
      status: "unavailable",
      since: NOW,
    });
  });

  it("omits a book it could not load (the gate refuses on SOURCE_MISSING) and keeps going", async () => {
    const snap = await loadMarketSnapshot("NVDA", {
      ...deps({ "/api/v2/mix/market/merge-depth": down }),
      now: NOW,
      dataMcp: null,
      signal: null,
    });
    expect(snap.books.perp).toBeUndefined();
    expect(snap.books.rtoken).toBeDefined();
    expect(snap.sources.find((s) => s.id === "bitget.mix.orderbook")).toMatchObject({
      status: "unavailable",
      asOf: null,
    });
    expect(snap.sources.find((s) => s.id === "bitget-mcp.equity_calendar")).toMatchObject({
      status: "unavailable",
      detail: "source disabled",
    });
  });

  it("serves reference data from cache (marked cached, original asOf) when Bitget is down later", async () => {
    let t = NOW;
    const healthy = deps({}, () => t);
    await loadMarketSnapshot("NVDA", { ...healthy, now: t, dataMcp: null, signal: null });
    t = NOW + 2 * 3_600_000;
    const flaky = deps({ "/api/v2/spot/public/symbols": down }, () => t);
    const snap = await loadMarketSnapshot("NVDA", {
      ...flaky,
      cache: healthy.cache,
      now: t,
      dataMcp: null,
      signal: null,
    });
    const spot = snap.sources.find((s) => s.id === "bitget.spot.symbol");
    expect(spot).toMatchObject({ status: "cached", since: t });
    expect(spot?.asOf).toBeLessThan(t);
    expect(snap.fees.rtoken).toEqual({ maker: 0.001, taker: 0.001 });
  });

  it("time-boxes optional MCP sources without blocking the snapshot", async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const base = deps();
    const slowMcp = new BitgetDataMcp({ fetch: hang, cache: base.cache, clock: () => NOW, timeoutMs: 300 });
    const t0 = performance.now();
    const snap = await loadMarketSnapshot("NVDA", {
      ...base,
      dataMcp: slowMcp,
      signal: null,
      now: NOW,
      optionalBudgetMs: 50,
    });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(snap.sources.find((s) => s.id === "bitget-mcp.equity_calendar")?.detail).toMatch(
      /no answer within 50 ms/,
    );
  });
});

describe("perp dividend adjustment from Bitget's v3 funding endpoint", () => {
  it("becomes an ex-dividend window only when Bitget announces one", () => {
    const body = JSON.parse(fixture("rest/v3-current-funding.json").response.body);
    expect(body.data[0].cashDividend).toBe("");
    expect(
      perpDividendEvent(
        {
          symbol: "NVDAUSDT",
          rate: 0,
          intervalHours: 8,
          nextFundingTime: 0,
          minRate: null,
          maxRate: null,
          cashDividend: null,
          cashDividendTime: null,
        },
        "NVDA",
      ),
    ).toBeNull();
    const ev = perpDividendEvent(
      {
        symbol: "NVDAUSDT",
        rate: 0,
        intervalHours: 8,
        nextFundingTime: 0,
        minRate: null,
        maxRate: null,
        cashDividend: 0.01,
        cashDividendTime: Date.UTC(2026, 11, 4, 8),
      },
      "NVDA",
    );
    expect(ev).toMatchObject({
      kind: "ex_dividend",
      windowSec: 3600,
      source: "bitget.mix.funding",
      ts: Date.UTC(2026, 11, 4, 8),
    });
  });
});
