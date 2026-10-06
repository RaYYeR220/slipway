import { describe, expect, it } from "vitest";
import { bookSeries, depthWithin } from "../src/book.js";
import {
  depletionEvents,
  depthPersistence,
  estimateResilience,
  framesFromTape,
  type TapeFrame,
} from "../src/resilience.js";
import { fixture, mulberry32, must, type SequenceFixture } from "./helpers.js";

const mu = fixture<SequenceFixture>("mu-perp-sequence.json");
const rnvda = fixture<SequenceFixture>("rnvda-sequence.json");
const muFrames = framesFromTape(bookSeries(mu.books, "perp", "MU"), mu.trades);

function shuffled(frames: TapeFrame[], seed: number): TapeFrame[] {
  const rnd = mulberry32(seed);
  const books = frames.map((f) => f.book);
  for (let i = books.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [books[i], books[j]] = [books[j] as (typeof books)[number], books[i] as (typeof books)[number]];
  }
  return frames.map((f, i) => ({ ...f, book: { ...(books[i] as TapeFrame["book"]), ts: f.ts } }));
}

describe("framesFromTape", () => {
  it("assigns each trade to the first snapshot at or after it", () => {
    const total = muFrames.reduce((s, f) => s + f.trades.length, 0);
    const inWindow = mu.trades.filter((t) => t.ts > (mu.books[0]?.ts ?? 0) - 1000 && t.ts <= mu.to).length;
    expect(total).toBe(inWindow);
    for (let i = 1; i < muFrames.length; i++) {
      const prev = muFrames[i - 1] as TapeFrame;
      const f = muFrames[i] as TapeFrame;
      for (const t of f.trades) expect(t.ts > prev.ts && t.ts <= f.ts).toBe(true);
    }
  });
});

describe("depletionEvents on the real MUUSDT overnight sequence", () => {
  const events = depletionEvents(muFrames);

  it("finds trade-coincident drops of at least 30% in ±25 bps depth", () => {
    expect(events.length).toBeGreaterThanOrEqual(10);
    for (const e of events) {
      expect(e.dropFrac).toBeGreaterThanOrEqual(0.3);
      expect(e.tradeNotional).toBeGreaterThan(0);
      expect(e.after).toBeLessThan(e.before);
    }
  });

  it("measures recovery against the real depth series", () => {
    const e = events.find((x) => x.recoverySec !== null);
    expect(e).toBeDefined();
    if (!e || e.recoverySec === null) return;
    const side = e.side === "ask" ? "buy" : "sell";
    const target = e.after + 0.5 * (e.before - e.after);
    const back = muFrames.find((f) => f.ts === e.ts + must(e.recoverySec) * 1000);
    expect(back).toBeDefined();
    expect(depthWithin((back as TapeFrame).book, side, 25).notional).toBeGreaterThanOrEqual(target);
  });

  it("drops fewer events when trades must explain part of the drop", () => {
    expect(depletionEvents(muFrames, { minTradeShare: 0.1 }).length).toBeLessThan(events.length);
  });
});

describe("estimateResilience", () => {
  it("returns a plausible half-life with an IQR on the real sequence", () => {
    const r = estimateResilience(muFrames);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.n).toBeGreaterThanOrEqual(5);
    expect(r.halfLifeSec).toBeGreaterThan(0.5);
    expect(r.halfLifeSec).toBeLessThan(30);
    expect(r.lo).toBeLessThanOrEqual(r.halfLifeSec);
    expect(r.hi).toBeGreaterThanOrEqual(r.halfLifeSec);
    expect(r.persistence).toBeGreaterThan(0.5);
  });

  it("refuses a confident half-life when time order is shuffled (negative control)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = shuffled(muFrames, seed);
      expect(depletionEvents(s).length).toBeGreaterThanOrEqual(5); // the detector still fires...
      expect(depthPersistence(s)).toBeLessThan(0.2); // ...but depth has no memory
      expect(estimateResilience(s)).toBeNull();
    }
  });

  it("returns null for an rToken book that printed no trades", () => {
    const frames = framesFromTape(bookSeries(rnvda.books, "rtoken", "NVDA"), rnvda.trades);
    expect(rnvda.trades).toHaveLength(0);
    expect(estimateResilience(frames)).toBeNull();
  });

  it("censors recoveries at 120 s and counts them", () => {
    const deep = muFrames.reduce((a, f) =>
      depthWithin(f.book, "buy", 25).notional > depthWithin(a.book, "buy", 25).notional ? f : a,
    );
    const thin = muFrames.reduce((a, f) =>
      depthWithin(f.book, "buy", 25).notional < depthWithin(a.book, "buy", 25).notional ? f : a,
    );
    const trade = mu.trades.find((t) => t.side === "buy");
    if (!trade) throw new Error("fixture has no buy trade");
    // Real books re-timed: full depth, then a depletion that never comes back within the window.
    const t0 = 1_000_000;
    const frames: TapeFrame[] = Array.from({ length: 200 }, (_, i) => ({
      ts: t0 + i * 1000,
      book: { ...(i === 0 ? deep.book : thin.book), ts: t0 + i * 1000 },
      trades: i === 1 ? [trade] : [],
    }));
    const events = depletionEvents(frames);
    expect(events).toHaveLength(1);
    expect(events[0]?.recoverySec).toBeNull();
    expect(events[0]?.censored).toBe(true);
  });
});
