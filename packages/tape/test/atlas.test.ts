import type { Candle } from "@slipway/bitget";
import { type Book, depthWithin, mid, nyseHolidayClosures, sessionAt, spreadBps } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { buildAtlas, buildKey, realBook } from "../src/atlas/build.js";
import { basisSigma, gapSigmas } from "../src/atlas/candles.js";
import { packBook, unpackBook } from "../src/atlas/compact.js";
import { DigestStore, digestHour } from "../src/atlas/digest.js";
import { hourLines } from "../src/read.js";
import { type BookRecord, toBook } from "../src/records.js";
import { FsTapeSource } from "../src/source.js";
import { fix, readJson, tempDir } from "./helpers.js";

const src = new FsTapeSource(fix("tape"));
const HOUR = "2026-10-06T04";
const holidays = nyseHolidayClosures();

async function realBooks(stream: "books" | "depth"): Promise<Book[]> {
  const out: Book[] = [];
  for await (const l of hourLines(src, stream, HOUR)) out.push(toBook(JSON.parse(l) as BookRecord));
  return out;
}

describe("compact books", () => {
  it("preserve touch, mid, spread and ±10/25/50 bps depth of every real book exactly", async () => {
    const books = [...(await realBooks("books")), ...(await realBooks("depth"))].filter(
      (b) => b.bids.length && b.asks.length,
    );
    expect(books.length).toBeGreaterThan(200);
    for (const b of books) {
      const c = unpackBook(packBook(b), b.venue, b.symbol);
      expect(c.bids[0]).toEqual(b.bids[0]);
      expect(c.asks[0]).toEqual(b.asks[0]);
      expect(mid(c)).toBe(mid(b));
      expect(spreadBps(c)).toBe(spreadBps(b));
      for (const bps of [10, 25, 50])
        for (const side of ["buy", "sell"] as const) {
          const a = depthWithin(b, side, bps);
          const z = depthWithin(c, side, bps);
          expect(z.qty).toBeCloseTo(a.qty, 9);
          expect(z.notional).toBeCloseTo(a.notional, 6);
        }
    }
  });
});

describe("digest + atlas key", () => {
  it("digests an hour per instrument and round-trips through the store", async () => {
    const d = await digestHour(src, HOUR);
    expect([...d.keys()].sort()).toEqual(["P_NVDA", "R_NVDA"]);
    const perp = d.get("P_NVDA");
    expect(perp?.frames.length).toBe((await realBooks("books")).filter((b) => b.venue === "perp").length);
    expect(perp?.depth.length).toBe(4);
    expect(perp?.trades.length).toBeGreaterThan(100);
    expect(perp?.frames.every((f, i, xs) => i === 0 || f.t > (xs[i - 1]?.t ?? 0))).toBe(true);
    const store = new DigestStore(tempDir());
    await store.write(HOUR, d);
    expect(await store.hours()).toEqual([HOUR]);
    expect(await store.read(HOUR, "perp", "NVDA")).toEqual(perp);
    expect(await store.read(HOUR, "perp", "TSLA")).toBeNull();
  });

  it("builds liquidity stats with a real (uncompacted) representative book", async () => {
    const store = new DigestStore(tempDir());
    await store.write(HOUR, await digestHour(src, HOUR));
    const now = Date.parse("2026-10-06T05:00:00Z");
    expect(sessionAt(Date.parse("2026-10-06T04:21:00Z")).session).toBe("overnight");
    const o = { symbols: ["NVDA"], holidays, now, maxSessionHours: 24, lookbackDays: 14, minFrames: 30 };
    const r = await buildKey(store, src, "NVDA", "perp", "overnight", [HOUR], o);
    const s = r.stats;
    expect(s).not.toBeNull();
    expect(r.coverage.snapshots).toBe(s?.n);
    expect(r.coverage.hours).toBe(1);
    expect(s?.spreadBps.p50).toBeGreaterThan(0);
    expect(s?.depthUsd.b25.p50).toBeGreaterThan(s?.depthUsd.b10.p50 ?? Number.POSITIVE_INFINITY);
    expect(s?.tradeNotionalPerMin.mean).toBeGreaterThan(0);
    const rep = s?.representativeBook as Book;
    expect(rep.bids.length).toBeGreaterThan(20); // a REST full-depth book, not a compacted one
    expect(await realBook(src, "depth", "perp", "NVDA", rep.ts)).toEqual(rep);
    // the rToken prints nothing publicly: flagged, not imputed
    const rt = await buildKey(store, src, "NVDA", "rtoken", "overnight", [HOUR], { ...o, minFrames: 5 });
    expect(rt.stats?.tradeNotionalPerMin.mean).toBe(0);
    expect(rt.flags.some((f) => f.startsWith("RTOKEN_TAPE_SILENT NVDA|rtoken|overnight"))).toBe(true);
    // sessions without data produce no key
    expect((await buildKey(store, src, "NVDA", "perp", "regular", [HOUR], o)).stats).toBeNull();
    const atlas = await buildAtlas(store, src, { ...o, venues: ["perp"] });
    expect(Object.keys(atlas.atlas)).toEqual(["NVDA|perp|overnight"]);
    expect(atlas.window.from).toBe(s?.from);
  });
});

describe("gap and basis σ from real 1 h candles", () => {
  const c = readJson<{ rtoken: Candle[]; perp: Candle[] }>("nvda-candles-1h.json.gz");

  it("estimates waits between sessions, longer waits wider", () => {
    const g = gapSigmas(c.perp, holidays);
    const on2pre = g["overnight->pre_market"];
    const on2reg = g["overnight->regular"];
    expect(on2pre?.n).toBeGreaterThan(30);
    expect(on2reg?.sigmaBps).toBeGreaterThan(on2pre?.sigmaBps ?? Number.POSITIVE_INFINITY);
    for (const v of Object.values(g)) if (v.n >= 8) expect(v.sigmaBps).toBeGreaterThan(0);
    expect(
      Number.isNaN(gapSigmas(c.perp.slice(0, 30), holidays)["overnight->regular"]?.sigmaBps ?? Number.NaN),
    ).toBe(true);
  });

  it("estimates perp/rToken basis volatility only over tradable rToken hours", () => {
    const sessions = {
      symbol: "NVDA",
      tradingPeriods: ["pre_market", "regular", "after_hours", "overnight"] as const,
      weekendTradable: false,
    };
    const b = basisSigma(
      c.perp,
      c.rtoken,
      { ...sessions, tradingPeriods: [...sessions.tradingPeriods] },
      holidays,
      sessionAt,
    );
    expect(b.n).toBeGreaterThan(500);
    expect(b.sigmaBps).toBeGreaterThan(0);
    expect(b.sigmaBps).toBeLessThan(50);
    const none = basisSigma(
      c.perp,
      c.rtoken,
      { symbol: "NVDA", tradingPeriods: [], weekendTradable: false },
      holidays,
      sessionAt,
    );
    expect(none.n).toBe(0);
  });
});
