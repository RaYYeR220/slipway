import { describe, expect, it } from "vitest";
import { costVsMid, mid, shiftBook, walk } from "../src/book.js";
import { type CostEstimate, type PlannedSlice, priceSchedule, type Schedule } from "../src/cost.js";
import { nextSessionStart } from "../src/session.js";
import { poissonTail, Z90 } from "../src/stats.js";
import { atlasKey, type MarketSnapshot } from "../src/types.js";
import { must } from "./helpers.js";
import { nvdaAtlas, nvdaSnapshot } from "./market.js";

const snap = nvdaSnapshot("overnight");
const perpBook = must(snap.books.perp);
const rtokenBook = must(snap.books.rtoken);
const now = snap.now;
const qty = 50_000 / mid(perpBook);
const PRIOR = 60;

const market = (
  t: number,
  venue: "perp" | "rtoken",
  q = qty,
  side: "buy" | "sell" = "buy",
): PlannedSlice => ({
  t,
  venue,
  side,
  qty: q,
  mode: "market",
});

function price(schedule: Schedule, s: MarketSnapshot = snap): CostEstimate {
  const r = priceSchedule(schedule, s, { priorHalfLifeSec: PRIOR });
  if (!r.ok) throw new Error(r.reason);
  return r.estimate;
}

describe("immediate market order", () => {
  const est = price({ parentQty: qty, entry: [market(now, "perp")] });
  const w = walk(perpBook, "buy", qty);

  it("costs the walk plus the real taker fee, with no risk", () => {
    expect(est.expectedBps).toBeCloseTo(w.costBps + 6, 10);
    expect(est.sdBps).toBe(0);
    expect(est.p10Bps).toBe(est.expectedBps);
    expect(est.p90Bps).toBe(est.expectedBps);
  });

  it("splits cost into half-spread, impact and fees that add up", () => {
    const c = est.components;
    expect(c.spread).toBeCloseTo(costVsMid("buy", must(perpBook.asks[0]).px, mid(perpBook)), 10);
    expect(c.impact).toBeCloseTo(w.costBps - c.spread, 10);
    expect(c.fees).toBeCloseTo(6, 10);
    expect(c.funding).toBe(0);
    expect(c.spread + c.impact + c.fees + c.funding).toBeCloseTo(est.expectedBps, 10);
  });

  it("emits a ticketable slice tagged with its session", () => {
    expect(est.slices).toEqual([
      {
        t: now,
        venue: "perp",
        side: "buy",
        qty,
        type: "market",
        session: "overnight",
        expectedBps: est.expectedBps,
        leg: "entry",
      },
    ]);
    expect(est.exhausted).toBe(false);
  });

  it("uses a fee override (VIP tier) instead of the venue schedule", () => {
    const r = priceSchedule({ parentQty: qty, entry: [market(now, "perp")] }, snap, {
      fees: { ...snap.fees, perp: { maker: 0, taker: 0.0002 } },
    });
    expect(r.ok && r.estimate.components.fees).toBeCloseTo(2, 10);
  });
});

describe("transient impact", () => {
  it("walks later slices from the decayed residual of earlier ones", () => {
    const est = price({ parentQty: 2 * qty, entry: [market(now, "perp"), market(now + 30_000, "perp")] });
    const residual = qty * 2 ** (-30 / PRIOR);
    expect(est.slices[1]?.expectedBps).toBeCloseTo(walk(perpBook, "buy", qty, residual).costBps + 6, 10);
    expect(est.slices[1]?.expectedBps).toBeGreaterThan(est.slices[0]?.expectedBps as number);
    expect(est.assumptions.join(" ")).toMatch(/half-life/);
  });

  it("forgets earlier slices once many half-lives have passed", () => {
    const est = price({ parentQty: 2 * qty, entry: [market(now, "perp"), market(now + 3_600_000, "perp")] });
    expect(est.slices[1]?.expectedBps).toBeCloseTo(est.slices[0]?.expectedBps as number, 6);
  });

  it("does not carry impact across venues or sides", () => {
    const est = price(
      {
        parentQty: qty,
        entry: [market(now, "perp")],
        rotation: { out: [market(now + 1000, "perp", qty, "sell")], in: [market(now + 1000, "rtoken")] },
      },
      { ...snap, basisSigmaBpsPerSqrtHour: 5 },
    );
    expect(est.slices[1]?.expectedBps).toBeCloseTo(walk(perpBook, "sell", qty).costBps + 6, 10);
    expect(est.slices[2]?.expectedBps).toBeCloseTo(walk(rtokenBook, "buy", qty).costBps + 10, 10);
  });
});

describe("Almgren-Chriss price risk", () => {
  it("integrates sigma^2 * tau * (remaining/Q)^2 over the schedule", () => {
    const n = 6;
    const tau = 60;
    const entry = Array.from({ length: n }, (_, k) => market(now + k * tau * 1000, "perp", qty / n));
    const est = price({ parentQty: qty, entry });
    const sigma = must(nvdaAtlas()[atlasKey("NVDA", "perp", "overnight")]).sigmaBpsPerSqrtSec;
    let v = 0;
    for (let k = 1; k < n; k++) v += sigma ** 2 * tau * (1 - k / n) ** 2;
    expect(est.components.priceRisk).toBeCloseTo(Math.sqrt(v), 10);
    expect(est.sdBps).toBeCloseTo(Math.sqrt(v), 10);
    expect(est.p10Bps).toBeCloseTo(est.expectedBps - Z90 * est.sdBps, 10);
    expect(est.p90Bps).toBeCloseTo(est.expectedBps + Z90 * est.sdBps, 10);
  });

  it("prices an rToken schedule with the underlying's σ, not the sticky rToken quote's", () => {
    const atlas = nvdaAtlas();
    const rKey = atlasKey("NVDA", "rtoken", "overnight");
    const pKey = atlasKey("NVDA", "perp", "overnight");
    const sticky = { ...snap, atlas: { ...atlas, [rKey]: { ...must(atlas[rKey]), sigmaBpsPerSqrtSec: 0.01 } } };
    const entry = [market(now, "rtoken", qty / 2), market(now + 120_000, "rtoken", qty / 2)];
    const est = price({ parentQty: qty, entry }, sticky);
    const sigma = Math.max(0.01, must(atlas[pKey]).sigmaBpsPerSqrtSec);
    expect(est.components.priceRisk).toBeCloseTo(Math.sqrt(sigma ** 2 * 120 * 0.25), 10);
  });
});

describe("funding on perp legs", () => {
  const ah = nvdaSnapshot("after_hours");
  const ahQty = 50_000 / mid(must(ah.books.perp));

  it("charges every settlement inside the hold to a long", () => {
    const est = price(
      { parentQty: ahQty, entry: [market(ah.now, "perp", ahQty)], perpHoldUntil: ah.now + 24 * 3_600_000 },
      ah,
    );
    expect(ah.funding?.rate).toBeGreaterThan(0);
    expect(est.components.funding).toBeCloseTo(3 * (ah.funding?.rate as number) * 1e4, 10);
    expect(est.assumptions.join(" ")).toMatch(/funding/i);
  });

  it("pays a short when the rate is positive", () => {
    const est = price(
      {
        parentQty: ahQty,
        entry: [market(ah.now, "perp", ahQty, "sell")],
        perpHoldUntil: ah.now + 24 * 3_600_000,
      },
      ah,
    );
    expect(est.components.funding).toBeCloseTo(-3 * (ah.funding?.rate as number) * 1e4, 10);
  });

  it("refuses to price a perp hold without funding data", () => {
    const r = priceSchedule(
      { parentQty: qty, entry: [market(now, "perp")], perpHoldUntil: now + 3_600_000 },
      { ...snap, funding: null },
      {},
    );
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/funding/) });
  });
});

describe("passive at the touch", () => {
  const rest = 300;
  const passive = (venue: "perp" | "rtoken", q: number): Schedule => ({
    parentQty: q,
    entry: [{ t: now, venue, side: "buy", qty: q, mode: "passive", restSec: rest }],
  });

  it("weights a maker fill against crossing later by the Poisson fill probability", () => {
    const q = 5_000 / mid(perpBook);
    const est = price(passive("perp", q));
    const stats = must(nvdaAtlas()[atlasKey("NVDA", "perp", "overnight")]);
    const queue = must(perpBook.bids[0]).sz;
    const p = poissonTail((queue + q) / stats.medianTradeQty, (stats.touchHitRatePerMin * rest) / 60);
    const filled = costVsMid("buy", must(perpBook.bids[0]).px, mid(perpBook)) + 2; // earn the half-spread, pay maker
    const crossed = walk(perpBook, "buy", q).costBps + 6;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(est.expectedBps).toBeCloseTo(p * filled + (1 - p) * crossed, 10);
    expect(est.components.nonFill).toBeCloseTo(Math.sqrt(p * (1 - p)) * Math.abs(crossed - filled), 10);
    expect(est.slices.map((s) => [s.type, s.postOnly ?? false, s.conditional ?? false])).toEqual([
      ["limit", true, false],
      ["market", false, true],
    ]);
    expect(est.slices[0]?.limitPx).toBe(perpBook.bids[0]?.px);
    expect(est.slices[1]?.t).toBe(now + rest * 1000);
  });

  it("never expects a fill on a venue that printed no trades", () => {
    const q = 5_000 / mid(rtokenBook);
    const est = price(passive("rtoken", q));
    expect(est.expectedBps).toBeCloseTo(walk(rtokenBook, "buy", q).costBps + 10, 10);
    expect(est.components.nonFill).toBe(0);
  });
});

describe("books for future sessions", () => {
  const afterHours = nextSessionStart(now, "after_hours", snap.holidays);

  it("uses the session's representative book re-centred on the live mid", () => {
    const q = 20_000 / mid(rtokenBook);
    const est = price({ parentQty: q, entry: [market(afterHours, "rtoken", q)] });
    const rep = must(must(nvdaAtlas()[atlasKey("NVDA", "rtoken", "after_hours")]).representativeBook);
    const shifted = shiftBook(rep, mid(rtokenBook));
    expect(est.slices[0]?.session).toBe("after_hours");
    expect(est.slices[0]?.expectedBps).toBeCloseTo(walk(shifted, "buy", q).costBps + 10, 10);
  });

  it("refuses to price a session it has no book for", () => {
    const regular = nextSessionStart(now, "regular", snap.holidays);
    const r = priceSchedule({ parentQty: qty, entry: [market(regular, "rtoken")] }, snap, {});
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/rtoken.*regular/) });
  });

  it("prices the wait as gap risk from the supplied gap sigma", () => {
    const q = 20_000 / mid(rtokenBook);
    const withGap = price(
      { parentQty: q, entry: [market(afterHours, "rtoken", q)] },
      { ...snap, gapSigmaBps: { "rtoken|overnight->after_hours": 120 } },
    );
    expect(withGap.components.gapRisk).toBeCloseTo(120, 10);
    expect(withGap.sdBps).toBeCloseTo(120, 10);
  });

  it("falls back to integrated session sigma for the wait and says so", () => {
    const q = 20_000 / mid(rtokenBook);
    const est = price({ parentQty: q, entry: [market(afterHours, "rtoken", q)] });
    expect(est.components.gapRisk).toBeGreaterThan(0);
    expect(est.assumptions.join(" ")).toMatch(/gap/);
  });
});

describe("rotation basis risk", () => {
  const rotateAt = now + 4 * 3_600_000;
  const schedule: Schedule = {
    parentQty: qty,
    entry: [market(now, "perp")],
    rotation: { out: [market(rotateAt, "perp", qty, "sell")], in: [market(rotateAt, "rtoken")] },
  };

  it("adds basis variance over the hold", () => {
    const est = price(schedule, { ...snap, basisSigmaBpsPerSqrtHour: 5 });
    expect(est.components.basisRisk).toBeCloseTo(5 * Math.sqrt(4), 10);
  });

  it("charges no funding once a stepped rotation has unwound the perp", () => {
    const ah = nvdaSnapshot("after_hours");
    const q = 0.1 + 0.2; // not exactly representable, so q/7 * 7 does not cancel to zero
    const steps = Array.from({ length: 7 }, (_, k) => ah.now + 60_000 * (k + 1));
    const est = price(
      {
        parentQty: q,
        entry: [market(ah.now, "perp", q)],
        rotation: {
          out: steps.map((t) => market(t, "perp", q / 7, "sell")),
          in: steps.map((t) => market(t, "rtoken", q / 7)),
        },
        perpHoldUntil: ah.now + 24 * 3_600_000,
      },
      ah,
    );
    expect(est.components.funding).toBe(0);
    expect(est.assumptions.join(" ")).not.toMatch(/funding/);
  });

  it("refuses without a basis estimate", () => {
    expect(priceSchedule(schedule, { ...snap, basisSigmaBpsPerSqrtHour: undefined }, {})).toEqual({
      ok: false,
      reason: expect.stringMatching(/basis/),
    });
  });
});

describe("exhaustion", () => {
  it("flags a slice larger than the visible book", () => {
    const visible = rtokenBook.asks.reduce((s, l) => s + l.sz, 0);
    const est = price({ parentQty: visible * 2, entry: [market(now, "rtoken", visible * 2)] });
    expect(est.exhausted).toBe(true);
  });
});
