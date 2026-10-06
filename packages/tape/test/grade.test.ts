import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { LoadedSnapshot } from "@slipway/bitget";
import { type Book, costVsMid, type ForecastEntry, mid, walk } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { evalContext, type Graded, gradePlans, groupPlans, scheduleOf } from "../src/grade/grade.js";
import { gradableUntil, HOUR_FINAL_AFTER_MS } from "../src/grade/job.js";
import { horizonBucket, orderRealized, type ScheduleSlice, tradeThroughFill } from "../src/grade/realize.js";
import { type BookRecord, toBook } from "../src/records.js";
import { FsTapeSource } from "../src/source.js";
import { fix, readJson } from "./helpers.js";

const entries = readJson<ForecastEntry[]>("eval", "entries.json");
const snap = readJson<LoadedSnapshot>("eval", "snapshot.json.gz");
const { order } = readJson<{ order: { i: number; roles: Record<string, string | null> } }>(
  "eval",
  "order.json",
);
const tape = new FsTapeSource(fix("eval-tape"));
const books: Book[] = gunzipSync(readFileSync(fix("eval-tape", "books", "2026-10-06T06.jsonl.gz")))
  .toString()
  .split("\n")
  .filter(Boolean)
  .map((l) => toBook(JSON.parse(l) as BookRecord));
const tapeEnd = Math.max(...books.map((b) => b.ts));
const plans = groupPlans(entries);
const ctx = evalContext(snap, { batchId: "20261006T0610Z", order: order.i });

const nearest = (venue: string, t: number): Book | null => {
  let best: Book | null = null;
  for (const b of books)
    if (
      b.venue === venue &&
      Math.abs(b.ts - t) <= 2000 &&
      (!best || Math.abs(b.ts - t) < Math.abs(best.ts - t))
    )
      best = b;
  return best;
};

async function grade(now = tapeEnd + 60_000, end = tapeEnd): Promise<Graded[]> {
  return gradePlans(tape, { chain: "eval", plans, context: async () => ctx, now, tapeEnd: end });
}
const orderRow = (rows: Graded[], strategyId: string) =>
  rows.find((g) => g.scope === "order" && g.strategyId === strategyId) as Graded;

describe("grading against the recorded book (real MSTR forecasts, overnight 2026-10-06)", () => {
  it("rebuilds the committed schedules from the ledger", () => {
    const byId = Object.fromEntries(plans.map((p) => [p.order.strategyId, scheduleOf(p)]));
    expect(byId["immediate:perp"]).toHaveLength(1);
    expect(byId["sliced:perp:n2:t60"]?.map((s) => s.t - (byId["sliced:perp:n2:t60"]?.[0]?.t ?? 0))).toEqual([
      0, 60_000,
    ]);
    expect(byId["passive:perp:T60"]).toEqual([
      expect.objectContaining({ kind: "limit", restSec: 60, venue: "perp" }),
    ]);
    expect(byId["perp_then_rotate:after_hours:r12"]).toHaveLength(25);
  });

  it("grades an immediate order exactly as a walk of the nearest real book, vs the arrival mid, plus the taker fee", async () => {
    const rows = await grade();
    const g = orderRow(rows, "immediate:perp");
    const e = entries.find((x) => x.id === g.id) as ForecastEntry;
    const book = nearest("perp", e.at) as Book;
    expect(book).not.toBeNull();
    const w = walk(book, "buy", e.qty);
    const expected = costVsMid("buy", w.avgPx, mid(snap.books.perp as Book)) + snap.fees.perp.taker * 1e4;
    expect(g.status).toBe("graded");
    expect(g.realized?.REPRODUCIBLE).toBeCloseTo(expected, 10);
    expect(g.realized?.MODELED).toBeCloseTo(expected, 10);
    expect(g.horizon).toBe("0-60s");
    expect(g.roles).toBeUndefined();
    const slice = rows.find((r) => r.planHash === g.planHash && r.scope === "slice") as Graded;
    expect(slice.realized?.REPRODUCIBLE).toBeCloseTo(expected, 10);
    expect(slice.bookGapMs).toBe(Math.abs(book.ts - e.at));
  });

  it("orders the own-impact conventions: shadow ≤ modeled ≤ no-refill", async () => {
    const g = orderRow(await grade(), "sliced:perp:n2:t60");
    expect(g.status).toBe("graded");
    const r = g.realized as Record<string, number>;
    expect(r.REPRODUCIBLE).toBeLessThanOrEqual((r.MODELED as number) + 1e-12);
    expect(r.MODELED).toBeLessThanOrEqual((r.BOUND as number) + 1e-12);
    expect(g.horizon).toBe(horizonBucket((g.until - g.registeredAt) / 1000));
  });

  it("leaves rToken slices ungraded when no book was recorded within 2 s, and never imputes", async () => {
    const rows = await grade();
    const g = orderRow(rows, "immediate:rtoken");
    const e = entries.find((x) => x.id === g.id) as ForecastEntry;
    if (nearest("rtoken", e.at)) expect(g.status).toBe("graded");
    else {
      expect(g.status).toBe("ungraded");
      expect(g.reason).toBe("no recorded book within the match window");
      expect(g.realized?.REPRODUCIBLE).toBeNull();
    }
  });

  it("grades a passive order with the trade-through fill rule", async () => {
    const g = orderRow(await grade(), "passive:perp:T60");
    expect(["graded", "ungraded"]).toContain(g.status);
    expect(g.filledFrac).toBeGreaterThanOrEqual(0);
    expect(g.filledFrac).toBeLessThanOrEqual(1);
  });

  it("keeps forecasts pending until they are due and the tape reaches them", async () => {
    const rows = await grade();
    expect(orderRow(rows, "wait:perp:after_hours:n24:t30").status).toBe("pending");
    expect(orderRow(rows, "perp_then_rotate:after_hours:r12").status).toBe("pending");
    const early = await grade(entries[0]?.at ?? 0, tapeEnd);
    expect(early.every((g) => g.status === "pending")).toBe(true);
    const noTape = await grade(tapeEnd + 60_000, (entries[0]?.at ?? 0) + 1_000);
    expect(orderRow(noTape, "immediate:perp").status).toBe("pending");
  });
});

describe("realization rules", () => {
  it("fills passive orders only on prints strictly through the resting price", () => {
    const prints = [
      { ts: 1, px: 100, sz: 5, side: "sell" as const },
      { ts: 2, px: 99.9, sz: 2, side: "sell" as const },
      { ts: 3, px: 99.8, sz: 10, side: "buy" as const },
      { ts: 4, px: 99.7, sz: 1, side: "sell" as const },
    ];
    expect(tradeThroughFill("buy", 100, 10, prints)).toBe(3);
    expect(tradeThroughFill("buy", 100, 2.5, prints)).toBe(2.5);
    expect(tradeThroughFill("sell", 99.75, 4, prints)).toBe(4);
  });

  it("propagates a missing slice to the order instead of averaging what is left", () => {
    const s: ScheduleSlice[] = [
      { t: 0, venue: "perp", side: "buy", qty: 1, kind: "market" },
      { t: 1, venue: "perp", side: "buy", qty: 1, kind: "market" },
    ];
    const full = { REPRODUCIBLE: 2, MODELED: 3, BOUND: 4 };
    const r = orderRealized(s, [{ realized: full }, { realized: { ...full, BOUND: null } }], 2);
    expect(r).toEqual({ REPRODUCIBLE: 2, MODELED: 3, BOUND: null });
    expect(orderRealized(s, [{ realized: full }, { realized: full }], 2, 1.5).REPRODUCIBLE).toBe(3.5);
  });

  it("buckets horizons as pre-registered", () => {
    expect([0, 60, 61, 900, 901, 21_600, 21_601].map(horizonBucket)).toEqual([
      "0-60s",
      "0-60s",
      "1-15m",
      "1-15m",
      "15m-6h",
      "15m-6h",
      ">6h",
    ]);
  });
});

describe("grading horizon", () => {
  it("grades only hours that are closed and published", async () => {
    const h06 = Date.parse("2026-10-06T06:00:00Z");
    expect(await gradableUntil(tape, h06 + 3_600_000 + HOUR_FINAL_AFTER_MS)).toBe(h06 + 3_600_000);
    expect(await gradableUntil(tape, h06 + 3_600_000 + HOUR_FINAL_AFTER_MS - 1)).toBe(0);
  });
});
