import type { MarketEvent } from "@slipway/core";
import { describe, expect, it } from "vitest";
import {
  BitgetDataMcp,
  doQueryData,
  KNOWN_ENTRIES,
  type LogicalEntry,
  mapCorporateActions,
  mapDailyBars,
  mapEarnings,
  mapEquityQuote,
  mapNews,
  rowsOf,
  toEpochMs,
  ymdOf,
} from "../src/bitget-mcp.js";
import { SourceCache, stableKey } from "../src/cache.js";
import { windowEnd, windowStart } from "../src/events.js";
import type { McpCallResult } from "../src/mcp-client.js";
import { type Exchange, fixture, mcpReplay, respond, withId } from "./helpers.js";

const SESSION = "mcp/bitget-mcp.session.json";
const NOW = 1_791_263_000_000; // 2026-10-06T05:03:20Z, recording time

const make = (overrides: Parameters<typeof mcpReplay>[1] = {}, clock = () => NOW) => {
  const fetch = mcpReplay(SESSION, overrides);
  const cache = new SourceCache({ clock });
  return { fetch, cache, mcp: new BitgetDataMcp({ fetch, cache, clock }) };
};

/** The recorded `guide {category}` exchange, with its body passed through `edit` (simulates catalog drift). */
const guideWith = (category: string, edit: (body: string) => string) => (body: { id?: number }) => {
  const ex = fixture<Exchange[]>(SESSION).find(
    (e) =>
      (e.request.body as { params?: { arguments?: { category?: string } } }).params?.arguments?.category ===
      category,
  ) as Exchange;
  return respond(ex, withId(edit(ex.response.body), body.id ?? 0));
};

/** Renames a catalog id in both the text block and structuredContent of a recorded guide body. */
const renameId = (from: string, to: string) => (b: string) =>
  b.replaceAll(`\\"id\\":\\"${from}\\"`, `\\"id\\":\\"${to}\\"`).replaceAll(`"id":"${from}"`, `"id":"${to}"`);

describe("runtime catalog discovery", () => {
  it("resolves every entry Slipway uses from the live guide (server 4.0.5)", async () => {
    const { mcp, fetch } = make();
    for (const logical of Object.keys(KNOWN_ENTRIES) as LogicalEntry[]) {
      const r = await mcp.resolve(logical);
      expect(r, logical).toMatchObject({ id: KNOWN_ENTRIES[logical].id, resolvedBy: "guide:id" });
    }
    const equity = await mcp.guide("equity");
    expect(equity.data).toHaveLength(22);
    expect(equity.source).toMatchObject({ id: "bitget-mcp.guide.equity", status: "cached" });
    expect(fetch.calls.filter((c) => c.startsWith("tools/call guide"))).toHaveLength(4);
    expect(equity.data?.find((e) => e.id === "equity_calendar")?.params).toContainEqual({
      name: "symbol",
      required: true,
      type: "string",
    });
  });

  it("follows id drift through aliases and url_path", async () => {
    const renamedBack = make({
      "tools/call guide": guideWith("equity", renameId("equity_calendar", "equity_calendar_earnings")),
    });
    expect(await renamedBack.mcp.resolve("earnings")).toMatchObject({
      id: "equity_calendar_earnings",
      resolvedBy: "guide:alias",
    });
    const renamedNew = make({
      "tools/call guide": guideWith("equity", renameId("equity_calendar", "equity_calendar_v5")),
    });
    expect(await renamedNew.mcp.resolve("earnings")).toMatchObject({
      id: "equity_calendar_v5",
      resolvedBy: "guide:url_path",
    });
  });

  it("falls back to the known id when guide itself is down, and says so", async () => {
    const { mcp } = make({ "tools/call guide": () => new Response("bad gateway", { status: 502 }) });
    expect(await mcp.resolve("equityQuote")).toMatchObject({
      id: "equity_price_quote",
      resolvedBy: "fallback",
    });
    const q = await mcp.equityQuote("NVDA");
    expect(q.source.detail).toMatch(/resolved by fallback/);
  });
});

describe("degradation on the real upstream outage (every do_query answered 503)", () => {
  it("returns unavailable with the outage start instead of throwing or inventing values", async () => {
    const { mcp } = make();
    const results = await Promise.all([
      mcp.equityQuote("NVDA"),
      mcp.earnings("NVDA", NOW - 86_400_000, NOW + 14 * 86_400_000),
      mcp.corporateActions("NVDA", NOW - 30 * 86_400_000, NOW + 90 * 86_400_000),
      mcp.news("stocks", { pageSize: 5 }),
      mcp.marketFearGreed(),
      mcp.equityDailyBars("NVDA", NOW - 10 * 86_400_000, NOW),
      mcp.futuresOrderBook("NVDA", "bitget"),
    ]);
    for (const r of results) {
      expect(r.data).toBeNull();
      expect(r.source).toMatchObject({ status: "unavailable", since: NOW, asOf: null });
      expect(r.source.detail).toMatch(/upstream 503: 503 Service Temporarily Unavailable/);
    }
    expect(results.map((r) => r.source.id)).toEqual([
      "bitget-mcp.equity_price_quote",
      "bitget-mcp.equity_calendar",
      "bitget-mcp.equity_fundamental_dividends",
      "bitget-mcp.news_label_search",
      "bitget-mcp.sentiment_market_fear_greed",
      "bitget-mcp.equity_price_historical",
      "bitget-mcp.crypto_futures_order_book",
    ]);
  });

  it("serves the last observed value, marked cached, while the outage lasts", async () => {
    let t = NOW - 3_600_000;
    const { mcp, cache } = make({}, () => t);
    const seeded = { symbol: "NVDA", last: 1 };
    cache.put(`bitget-mcp:equity_price_quote:${stableKey({ symbol: "NVDA" })}`, seeded, t);
    t = NOW;
    const q = await mcp.equityQuote("NVDA");
    expect(q.data).toMatchObject({ ...seeded, cashStalenessSec: null });
    expect(q.source).toMatchObject({ status: "cached", asOf: NOW - 3_600_000, since: NOW });
  });

  it("surfaces gateway validation and unknown-entry errors verbatim", async () => {
    const { mcp } = make();
    const bad = await mcp.query(
      "news",
      { label: "stocks-not-an-int" },
      { ttlMs: 0, maxStaleMs: 0 },
      (d) => d,
    );
    expect(bad.source.detail).toMatch(/Param 'label' must be of type 'integer'/);
    const unknown = fixture<Exchange[]>(SESSION).find((e) =>
      e.response.body.includes("Unknown entry_id"),
    ) as Exchange;
    const msg = JSON.parse(
      unknown.response.body
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5) as string,
    );
    expect(() => doQueryData(msg.result as McpCallResult)).toThrow("Unknown entry_id");
  });
});

// The catalog has not returned a success payload since 2026-10-05, so these rows use the field names documented
// in the catalog (agent.bitget.com/docs, recorded in recon/mcp-tools.json) rather than a captured response.
describe("mapping documented catalog fields", () => {
  it("derives cash-market staleness from SIP nanosecond timestamps", () => {
    const now = Date.UTC(2026, 9, 5, 21, 0);
    const lastNs = String(BigInt(Date.UTC(2026, 9, 5, 20, 0)) * 1_000_000n);
    const q = mapEquityQuote(
      {
        symbol: "NVDA",
        last_price: 238.9,
        bid: 238.88,
        ask: 238.92,
        last_timestamp: lastNs,
        sip_timestamp: lastNs,
        quote_conditions: "",
      },
      now,
    );
    expect(q).toMatchObject({
      symbol: "NVDA",
      last: 238.9,
      lastTradeTs: Date.UTC(2026, 9, 5, 20, 0),
      cashStalenessSec: 3600,
      quoteConditions: null,
    });
    expect(toEpochMs("2026-10-05T20:00:00Z")).toBe(Date.UTC(2026, 9, 5, 20, 0));
    expect(toEpochMs(1_791_000_000)).toBe(1_791_000_000_000);
    expect(toEpochMs("garbage")).toBeNull();
  });

  it("turns earnings rows into avoid-windows with the reported timing", () => {
    const ev = mapEarnings(
      [
        { perf_report_fore_dsclsr_date: "2026-11-18", is_trading_time: "盘后", period_ending: "2026-10-31" },
        { perf_report_dsclsr_date: "2026-08-26", is_trading_time: "盘前" },
        { perf_report_fore_dsclsr_date: "2027-02-24" },
        { name: "no date" },
      ],
      "NVDA",
      "bitget-mcp.earnings",
    );
    expect(ev).toHaveLength(3);
    const span = (e: MarketEvent | undefined) =>
      [windowStart(e as MarketEvent), windowEnd(e as MarketEvent)].map((t) => new Date(t).toISOString());
    expect(span(ev[0])).toEqual(["2026-11-18T21:00:00.000Z", "2026-11-19T15:00:00.000Z"]);
    expect(ev[0]?.windowSec).toBe(9 * 3600);
    expect(ev[0]?.label).toBe(
      "NVDA earnings 2026-11-18 (after close, expected date) for period ending 2026-10-31",
    );
    expect(span(ev[1])).toEqual(["2026-08-26T08:00:00.000Z", "2026-08-26T14:00:00.000Z"]);
    expect(ev[2]?.label).toMatch(/time of day not reported/);
  });

  it("separates cash dividends from splits", () => {
    const ev = mapCorporateActions(
      [
        { event_type: "现金分红", ex_dividend_date: "2026-12-04", amount: 0.01, currency: "USD" },
        {
          event_type: "股票拆分",
          split_valid_date: "2024-06-10",
          split_numerator: "10",
          split_denominator: "1",
        },
      ],
      "NVDA",
      "bitget-mcp.dividends",
    );
    expect(ev.map((e) => [e.kind, e.label])).toEqual([
      ["ex_dividend", "NVDA ex-dividend 0.01 USD effective 2026-12-04"],
      ["split", "NVDA split 10:1 effective 2024-06-10"],
    ]);
    expect(
      [windowStart(ev[0] as MarketEvent), windowEnd(ev[0] as MarketEvent)].map((t) =>
        new Date(t).toISOString(),
      ),
    ).toEqual(["2026-12-03T21:00:00.000Z", "2026-12-04T14:45:00.000Z"]);
  });

  it("maps news, daily bars and tolerant envelopes", () => {
    expect(rowsOf({ items: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsOf([{ a: 1 }, 3])).toEqual([{ a: 1 }]);
    const news = mapNews(
      [
        { title: "Fed holds", content: "x".repeat(900), labels: "7", published_at: "2026-10-05T18:00:00Z" },
        { title: "" },
      ],
      "bitget-mcp.news.macro",
    );
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      title: "Fed holds",
      labels: ["7"],
      publishedAt: Date.UTC(2026, 9, 5, 18),
    });
    expect(news[0]?.summary).toHaveLength(500);
    const bars = mapDailyBars([
      { date: "2026-10-02", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, vwap: 1.2 },
      { date: "2026-10-01", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { date: "2026-10-03", open: null, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
    expect(bars.map((b) => [b.date, b.vwap])).toEqual([
      ["2026-10-01", null],
      ["2026-10-02", 1.2],
    ]);
  });
});

describe("review regressions", () => {
  it("reads dates from ISO strings, compact YYYYMMDD and epoch numbers without inventing year 1760", () => {
    expect(ymdOf("2026-11-18")).toBe("2026-11-18");
    expect(ymdOf("2026-11-18T21:00:00Z")).toBe("2026-11-18");
    expect(ymdOf("20261118")).toBe("2026-11-18");
    expect(ymdOf(1_760_000_000_000)).toBe("2025-10-09");
    expect(ymdOf(String(1_760_000_000_000))).toBe("2025-10-09");
    expect(ymdOf(null)).toBeNull();
  });

  it("ages a cached quote's cash staleness at read time", async () => {
    let t = NOW - 600_000;
    const { mcp, cache } = make({}, () => t);
    const quote = mapEquityQuote({ symbol: "NVDA", last_price: 1, last_timestamp: t - 5_000 }, t);
    expect(quote.cashStalenessSec).toBe(5);
    cache.put(`bitget-mcp:equity_price_quote:${stableKey({ symbol: "NVDA" })}`, quote, t);
    t = NOW;
    const q = await mcp.equityQuote("NVDA");
    expect(q.source.status).toBe("cached");
    expect(q.data?.cashStalenessSec).toBe(605);
  });

  it("never mutates a result shared by concurrent callers", async () => {
    const { mcp } = make({ "tools/call guide": () => new Response("down", { status: 502 }) });
    const [a, b] = await Promise.all([mcp.equityQuote("NVDA"), mcp.equityQuote("NVDA")]);
    for (const r of [a, b]) expect(r.source.detail?.match(/resolved by fallback/g)).toHaveLength(1);
  });
});
