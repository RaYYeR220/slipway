import { describe, expect, it } from "vitest";
import { buildAtlas, buildLiquidityStats, sigmaBpsPerSqrtSec } from "../src/atlas.js";
import { bookSeries, depthWithin } from "../src/book.js";
import { estimateResilience, framesFromTape } from "../src/resilience.js";
import { median } from "../src/stats.js";
import { atlasKey } from "../src/types.js";
import { fixture, type SequenceFixture } from "./helpers.js";

const nvdaSeq = fixture<SequenceFixture>("nvda-perp-sequence.json");
const rnvdaSeq = fixture<SequenceFixture>("rnvda-sequence.json");
const muSeq = fixture<SequenceFixture>("mu-perp-sequence.json");

const frames = (s: SequenceFixture, venue: "perp" | "rtoken", symbol: string) =>
  framesFromTape(bookSeries(s.books, venue, symbol), s.trades);

const nvdaPerp = buildLiquidityStats({
  symbol: "NVDA",
  venue: "perp",
  session: "overnight",
  frames: frames(nvdaSeq, "perp", "NVDA"),
  depthBooks: bookSeries(nvdaSeq.depth ?? [], "perp", "NVDA"),
});

describe("buildLiquidityStats on the NVDA perp overnight sequence", () => {
  it("keys and spans the sample", () => {
    expect(nvdaPerp).toMatchObject({ symbol: "NVDA", venue: "perp", session: "overnight", n: 300 });
    expect(nvdaPerp.from).toBe(nvdaSeq.books[0]?.ts);
    expect(nvdaPerp.to).toBe(nvdaSeq.books.at(-1)?.ts);
  });

  it("reports a one-tick spread", () => {
    expect(nvdaPerp.spreadBps.p50).toBeGreaterThan(0.3);
    expect(nvdaPerp.spreadBps.p50).toBeLessThan(0.6);
    expect(nvdaPerp.spreadBps.p10).toBeLessThanOrEqual(nvdaPerp.spreadBps.p90);
  });

  it("takes depth bands from the full-depth snapshots when supplied", () => {
    const top15 = buildLiquidityStats({
      symbol: "NVDA",
      venue: "perp",
      session: "overnight",
      frames: frames(nvdaSeq, "perp", "NVDA"),
    });
    expect(nvdaPerp.depthUsd.b25.p50).toBeGreaterThan(2 * top15.depthUsd.b25.p50);
    expect(nvdaPerp.depthUsd.b10.p50).toBeLessThanOrEqual(nvdaPerp.depthUsd.b25.p50);
    expect(nvdaPerp.depthUsd.b25.p50).toBeLessThanOrEqual(nvdaPerp.depthUsd.b50.p50);
  });

  it("picks a real full-depth snapshot of median depth as the representative book", () => {
    const rep = nvdaPerp.representativeBook;
    expect(rep).toBeDefined();
    expect(nvdaSeq.depth?.map((d) => d.ts)).toContain(rep?.ts);
    const perSide = (b: NonNullable<typeof rep>) =>
      (depthWithin(b, "buy", 25).notional + depthWithin(b, "sell", 25).notional) / 2;
    const all = bookSeries(nvdaSeq.depth ?? [], "perp", "NVDA").map(perSide);
    const m = median(all);
    const best = Math.min(...all.map((x) => Math.abs(x - m)));
    expect(Math.abs(perSide(rep as NonNullable<typeof rep>) - m)).toBe(best);
  });

  it("measures traded notional per minute including empty minutes", () => {
    const total = nvdaSeq.trades.reduce((s, t) => s + t.px * t.sz, 0);
    const minutes = Math.ceil((nvdaPerp.to - nvdaPerp.from) / 60_000);
    expect(nvdaPerp.tradeNotionalPerMin.mean).toBeCloseTo(total / minutes, 6);
    expect(nvdaPerp.medianTradeQty).toBe(median(nvdaSeq.trades.map((t) => t.sz)));
    expect(nvdaPerp.touchHitRatePerMin).toBeGreaterThan(0);
    expect(nvdaPerp.touchHitRatePerMin).toBeLessThanOrEqual(nvdaSeq.trades.length / minutes / 2);
  });

  it("gives a plausible robust volatility", () => {
    expect(nvdaPerp.sigmaBpsPerSqrtSec).toBeGreaterThan(0.05);
    expect(nvdaPerp.sigmaBpsPerSqrtSec).toBeLessThan(2);
  });

  it("falls back to null resilience when too few depletion events exist", () => {
    expect(nvdaPerp.resilience).toBeNull();
  });

  it("is deterministic", () => {
    const again = buildLiquidityStats({
      symbol: "NVDA",
      venue: "perp",
      session: "overnight",
      frames: frames(nvdaSeq, "perp", "NVDA"),
      depthBooks: bookSeries(nvdaSeq.depth ?? [], "perp", "NVDA"),
    });
    expect(again).toEqual(nvdaPerp);
  });
});

describe("buildLiquidityStats on the rNVDA overnight sequence (no prints)", () => {
  const stats = buildLiquidityStats({
    symbol: "NVDA",
    venue: "rtoken",
    session: "overnight",
    frames: frames(rnvdaSeq, "rtoken", "NVDA"),
    depthBooks: bookSeries(rnvdaSeq.depth ?? [], "rtoken", "NVDA"),
  });

  it("reports zero flow and no resilience instead of inventing them", () => {
    expect(stats.tradeNotionalPerMin).toEqual({ p50: 0, mean: 0 });
    expect(stats.touchHitRatePerMin).toBe(0);
    expect(stats.medianTradeQty).toBe(0);
    expect(stats.resilience).toBeNull();
  });

  it("shows a wider spread than the perp but real depth within 25 bps", () => {
    expect(stats.spreadBps.p50).toBeGreaterThan(nvdaPerp.spreadBps.p50);
    expect(stats.depthUsd.b25.p50).toBeGreaterThan(100_000);
  });
});

describe("buildLiquidityStats on the MU perp sequence", () => {
  it("carries the resilience estimate", () => {
    const f = frames(muSeq, "perp", "MU");
    const stats = buildLiquidityStats({ symbol: "MU", venue: "perp", session: "overnight", frames: f });
    expect(stats.resilience).toEqual(estimateResilience(f));
    expect(stats.resilience).not.toBeNull();
  });

  it("rejects an empty series", () => {
    expect(() =>
      buildLiquidityStats({ symbol: "MU", venue: "perp", session: "overnight", frames: [] }),
    ).toThrow();
  });
});

describe("sigmaBpsPerSqrtSec", () => {
  it("is unaffected by the 1 s zero-inflation that collapses a MAD estimate", () => {
    const f = frames(nvdaSeq, "perp", "NVDA");
    const s1 = sigmaBpsPerSqrtSec(f, { horizonSec: 1 });
    const s10 = sigmaBpsPerSqrtSec(f, { horizonSec: 10 });
    expect(s1).toBeGreaterThan(0);
    expect(s10).toBeGreaterThan(0);
  });

  it("returns NaN when the series is too short to measure", () => {
    expect(sigmaBpsPerSqrtSec(frames(nvdaSeq, "perp", "NVDA").slice(0, 2))).toBeNaN();
  });
});

describe("buildAtlas", () => {
  it("indexes stats by symbol|venue|session", () => {
    const atlas = buildAtlas([nvdaPerp]);
    expect(atlas[atlasKey("NVDA", "perp", "overnight")]).toBe(nvdaPerp);
  });
});
