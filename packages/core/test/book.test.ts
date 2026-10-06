import { describe, expect, it } from "vitest";
import {
  bookFromBitget,
  depthWithin,
  mid,
  parseLevels,
  qtyForNotional,
  shiftBook,
  spreadBps,
  walk,
} from "../src/book.js";
import type { Book } from "../src/types.js";
import { instrument, mulberry32 } from "./helpers.js";

const nvdaPerpRaw = instrument("nvda-books.json", "overnight", "NVDAUSDT").depth;
const rnvdaRaw = instrument("nvda-books.json", "overnight", "RNVDAUSDT").depth;
const rhoodRaw = instrument("thin-books.json", "overnight", "RHOODUSDT").books15;
const perp = bookFromBitget(nvdaPerpRaw);
const rnvda = bookFromBitget(rnvdaRaw);
const rhood = bookFromBitget(rhoodRaw);

describe("parsing Bitget payloads", () => {
  it("maps spot rTokens and USDT-M perps to venue + underlying", () => {
    expect([rnvda.venue, rnvda.symbol]).toEqual(["rtoken", "NVDA"]);
    expect([perp.venue, perp.symbol]).toEqual(["perp", "NVDA"]);
    expect(rnvda.ts).toBe(rnvdaRaw.ts);
  });

  it("accepts string levels (spot) and numeric levels (perp merge-depth)", () => {
    expect(typeof rnvdaRaw.asks[0]?.[0]).toBe("string");
    expect(typeof nvdaPerpRaw.asks[0]?.[0]).toBe("number");
    expect(rnvda.asks[0]).toEqual({ px: Number(rnvdaRaw.asks[0]?.[0]), sz: Number(rnvdaRaw.asks[0]?.[1]) });
    expect(perp.bids).toHaveLength(nvdaPerpRaw.bids.length);
  });

  it("sorts bids descending, asks ascending and drops empty levels", () => {
    const levels = parseLevels(
      [
        ["10.0", "1"],
        ["10.2", "0"],
        ["10.1", "2"],
      ],
      "bid",
    );
    expect(levels).toEqual([
      { px: 10.1, sz: 2 },
      { px: 10, sz: 1 },
    ]);
    expect(
      parseLevels(
        [
          ["10.2", "1"],
          ["10.1", "1"],
        ],
        "ask",
      ).map((l) => l.px),
    ).toEqual([10.1, 10.2]);
  });

  it("rejects non-numeric levels", () => {
    expect(() => parseLevels([["abc", "1"]], "ask")).toThrow(/level/);
  });

  it("rejects unknown instrument ids", () => {
    expect(() => bookFromBitget({ ...nvdaPerpRaw, instId: "NVDAUSDC" })).toThrow(/instId/);
  });
});

describe("mid and spread", () => {
  it("computes mid and spread from the touch of a real perp book", () => {
    const bid = Number(nvdaPerpRaw.bids[0]?.[0]);
    const ask = Number(nvdaPerpRaw.asks[0]?.[0]);
    expect(mid(perp)).toBeCloseTo((bid + ask) / 2, 10);
    expect(spreadBps(perp)).toBeCloseTo(((ask - bid) / ((bid + ask) / 2)) * 1e4, 10);
  });

  it("shows the rToken quoting wider than the perp overnight", () => {
    expect(spreadBps(rhood)).toBeGreaterThan(spreadBps(perp));
  });

  it("throws on a one-sided book", () => {
    expect(() => mid({ ...perp, bids: [] })).toThrow(/one-sided|empty/);
  });
});

describe("depthWithin", () => {
  it("sums ask notional inside the band for buys and bid notional for sells", () => {
    const m = mid(rnvda);
    const asks = rnvda.asks.filter((l) => l.px <= m * (1 + 25 / 1e4));
    const bids = rnvda.bids.filter((l) => l.px >= m * (1 - 25 / 1e4));
    const buy = depthWithin(rnvda, "buy", 25);
    expect(buy.qty).toBeCloseTo(
      asks.reduce((s, l) => s + l.sz, 0),
      9,
    );
    expect(buy.notional).toBeCloseTo(
      asks.reduce((s, l) => s + l.sz * l.px, 0),
      6,
    );
    expect(depthWithin(rnvda, "sell", 25).notional).toBeCloseTo(
      bids.reduce((s, l) => s + l.sz * l.px, 0),
      6,
    );
  });

  it("is non-decreasing in the band width", () => {
    const widths = [0, 5, 10, 25, 50, 100, 500];
    const notional = widths.map((w) => depthWithin(perp, "buy", w).notional);
    for (let i = 1; i < notional.length; i++)
      expect(notional[i]).toBeGreaterThanOrEqual(notional[i - 1] as number);
    expect(notional[0]).toBe(0);
  });
});

describe("walk", () => {
  const book: Book = rhood;
  const a0 = book.asks[0] as { px: number; sz: number };
  const a1 = book.asks[1] as { px: number; sz: number };

  it("fills inside the first level at the touch", () => {
    const r = walk(book, "buy", a0.sz / 2);
    expect(r).toMatchObject({
      filledQty: a0.sz / 2,
      avgPx: a0.px,
      worstPx: a0.px,
      levelsConsumed: 1,
      exhausted: false,
    });
    expect(r.costBps).toBeCloseTo((a0.px / mid(book) - 1) * 1e4, 10);
  });

  it("consumes exactly one level when qty equals its size", () => {
    expect(walk(book, "buy", a0.sz)).toMatchObject({ levelsConsumed: 1, worstPx: a0.px });
  });

  it("averages across levels at the volume-weighted price", () => {
    const q = a0.sz + a1.sz / 2;
    const r = walk(book, "buy", q);
    expect(r.avgPx).toBeCloseTo((a0.sz * a0.px + (a1.sz / 2) * a1.px) / q, 10);
    expect(r.worstPx).toBe(a1.px);
    expect(r.levelsConsumed).toBe(2);
  });

  it("skips the offset before filling (transient impact)", () => {
    const skipped = walk(book, "buy", a1.sz / 2, a0.sz);
    expect(skipped.avgPx).toBe(a1.px);
    const partial = walk(book, "buy", a0.sz, a0.sz / 2);
    expect(partial.avgPx).toBeCloseTo((0.5 * a0.px + 0.5 * a1.px) * 1, 10);
    expect(partial.levelsConsumed).toBe(2);
  });

  it("walks bids for sells and reports a positive cost", () => {
    const b0 = book.bids[0] as { px: number; sz: number };
    const r = walk(book, "sell", b0.sz / 4);
    expect(r.avgPx).toBe(b0.px);
    expect(r.costBps).toBeCloseTo((1 - b0.px / mid(book)) * 1e4, 10);
    expect(r.costBps).toBeGreaterThan(0);
  });

  it("flags exhaustion when visible depth is below qty and reports the fillable part", () => {
    const total = book.asks.reduce((s, l) => s + l.sz, 0);
    const r = walk(book, "buy", total * 2);
    expect(r.exhausted).toBe(true);
    expect(r.filledQty).toBeCloseTo(total, 9);
    expect(r.levelsConsumed).toBe(book.asks.length);
    expect(r.worstPx).toBe(book.asks.at(-1)?.px);
  });

  it("flags exhaustion when the offset alone eats the visible depth", () => {
    const total = book.asks.reduce((s, l) => s + l.sz, 0);
    const r = walk(book, "buy", 1, total);
    expect(r).toMatchObject({ exhausted: true, filledQty: 0, levelsConsumed: 0 });
    expect(r.avgPx).toBe(book.asks.at(-1)?.px);
  });

  it("prices a zero quantity at the marginal level after the offset", () => {
    expect(walk(book, "buy", 0)).toMatchObject({ filledQty: 0, avgPx: a0.px, exhausted: false });
    expect(walk(book, "buy", 0, a0.sz).avgPx).toBe(a1.px);
  });

  it("rejects negative quantities", () => {
    expect(() => walk(book, "buy", -1)).toThrow(RangeError);
    expect(() => walk(book, "buy", 1, -1)).toThrow(RangeError);
  });

  it("is non-decreasing in qty and in offset on real books (seeded property test)", () => {
    const rnd = mulberry32(20261006);
    for (const b of [perp, rnvda, rhood]) {
      const depth = b.asks.reduce((s, l) => s + l.sz, 0);
      for (let i = 0; i < 300; i++) {
        const side = rnd() < 0.5 ? "buy" : "sell";
        const q1 = rnd() * depth * 1.2;
        const q2 = q1 + rnd() * depth * 0.3;
        expect(walk(b, side, q2).costBps).toBeGreaterThanOrEqual(walk(b, side, q1).costBps - 1e-9);
        const o1 = rnd() * depth;
        const o2 = o1 + rnd() * depth * 0.2;
        expect(walk(b, side, q1 / 4, o2).costBps).toBeGreaterThanOrEqual(
          walk(b, side, q1 / 4, o1).costBps - 1e-9,
        );
      }
    }
  });
});

describe("qtyForNotional", () => {
  it("returns the qty whose walk spends exactly the notional", () => {
    const q = qtyForNotional(rnvda, "buy", 50_000);
    const r = walk(rnvda, "buy", q);
    expect(r.avgPx * r.filledQty).toBeCloseTo(50_000, 6);
  });

  it("extends beyond visible depth at the deepest price", () => {
    const visible = rhood.asks.reduce((s, l) => s + l.sz * l.px, 0);
    const deepest = rhood.asks.at(-1)?.px as number;
    const visibleQty = rhood.asks.reduce((s, l) => s + l.sz, 0);
    expect(qtyForNotional(rhood, "buy", visible + 1000)).toBeCloseTo(visibleQty + 1000 / deepest, 9);
  });
});

describe("shiftBook", () => {
  it("re-centres a book on a new mid preserving relative shape", () => {
    const target = mid(perp) * 1.01;
    const shifted = shiftBook(rnvda, target);
    expect(mid(shifted)).toBeCloseTo(target, 9);
    expect(spreadBps(shifted)).toBeCloseTo(spreadBps(rnvda), 9);
    expect(walk(shifted, "buy", 100).costBps).toBeCloseTo(walk(rnvda, "buy", 100).costBps, 9);
  });
});
