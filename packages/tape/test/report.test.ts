import { fileURLToPath } from "node:url";
import type { LoadedSnapshot } from "@slipway/bitget";
import { type ForecastEntry, mean } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { loadProtocol } from "../src/eval/protocol.js";
import { ABLATIONS, replayAblations } from "../src/grade/ablation.js";
import type { Graded } from "../src/grade/grade.js";
import { primaryVenue } from "../src/grade/job.js";
import {
  accuracy,
  bootstrapMeanCi,
  calibration,
  compare,
  lossesOf,
  orderOutcomes,
} from "../src/grade/report.js";
import { readJson } from "./helpers.js";

const PROTOCOL = fileURLToPath(new URL("../../../eval/protocol.json", import.meta.url));
const snap = readJson<LoadedSnapshot>("eval", "snapshot.json.gz");
const entries = readJson<ForecastEntry[]>("eval", "entries.json");

// graded rows shaped from the real fixture forecasts with given realized costs
const row = (over: Partial<Graded>): Graded => ({
  chain: "eval",
  id: "x:order",
  hash: "h",
  planHash: "p",
  strategyId: "immediate:perp",
  family: "immediate",
  scope: "order",
  symbol: "MSTR",
  side: "buy",
  venue: "perp",
  session: "overnight",
  qty: 1,
  at: 0,
  until: 0,
  registeredAt: 0,
  horizon: "0-60s",
  p50: 5,
  p10: 3,
  p90: 7,
  status: "graded",
  realized: { REPRODUCIBLE: 5, MODELED: 5, BOUND: 5 },
  ...over,
});

describe("track-record statistics", () => {
  it("bootstrap CI is seeded, reproducible and brackets the mean", () => {
    const xs = entries.map((e) => e.predicted.p50);
    const a = bootstrapMeanCi(xs, 20261006);
    expect(bootstrapMeanCi(xs, 20261006)).toEqual(a);
    expect(a[0]).toBeLessThanOrEqual(mean(xs));
    expect(a[1]).toBeGreaterThanOrEqual(mean(xs));
    expect(bootstrapMeanCi([2, 2, 2], 1)).toEqual([2, 2]);
  });

  it("accuracy: MAE, bias and p10–p90 coverage per venue × session × horizon", () => {
    const rows = [
      row({ realized: { REPRODUCIBLE: 6, MODELED: 6, BOUND: 6 } }),
      row({ realized: { REPRODUCIBLE: 9, MODELED: 9, BOUND: 9 } }),
      row({ status: "ungraded", realized: { REPRODUCIBLE: null, MODELED: null, BOUND: null } }),
    ];
    const [a] = accuracy(rows, "REPRODUCIBLE");
    expect(a).toMatchObject({
      scope: "order",
      venue: "perp",
      session: "overnight",
      horizon: "0-60s",
      n: 2,
      maeBps: 2.5,
      biasBps: -2.5,
    });
    expect(a?.coverage).toEqual({ n: 2, inside: 1, rate: 0.5 });
  });

  it("calibration only uses outcomes known before a forecast was registered", () => {
    const rows = [0, 1, 2, 3].map((k) =>
      row({
        hash: `h${k}`,
        registeredAt: k * 600_000,
        until: k * 600_000 + 1_000,
        p50: 4,
        realized: { REPRODUCIBLE: 8, MODELED: 8, BOUND: 8 },
      }),
    );
    const [c] = calibration(rows, "REPRODUCIBLE", 0);
    expect(c?.evalN).toBe(3); // the first forecast has nothing earlier to calibrate on
    expect(c?.k).toBeCloseTo(2, 12);
    expect(c?.maeRawBps).toBe(4);
    expect(c?.maeCalibratedBps).toBeCloseTo(0, 12);
    const [shrunk] = calibration(rows, "REPRODUCIBLE", 20);
    expect(shrunk?.k).toBeCloseTo((4 * 2 + 20) / (4 + 20), 12);
  });

  it("head-to-head lists every group where the chosen plan loses", () => {
    const mk = (k: number, chosen: number, base: number) => [
      row({
        hash: `c${k}`,
        batchId: "b",
        order: k,
        roles: ["chosen"],
        realized: { REPRODUCIBLE: chosen, MODELED: chosen, BOUND: chosen },
      }),
      row({
        hash: `i${k}`,
        batchId: "b",
        order: k,
        roles: ["immediate:perp"],
        realized: { REPRODUCIBLE: base, MODELED: base, BOUND: base },
      }),
    ];
    const rows = [...mk(0, 5, 7), ...mk(1, 6, 4), ...mk(2, 3, 3)];
    const orders = [0, 1, 2].map((k) => ({
      key: `b:${k}`,
      session: "overnight",
      symbol: k === 1 ? "COIN" : "MSTR",
      notionalUsd: 5000,
      primary: "perp",
    }));
    const { all, diffs } = compare(orderOutcomes(rows, orders), "immediate", "REPRODUCIBLE", 1);
    expect(all).toMatchObject({ n: 3, wins: 1, losses: 1, ties: 1 });
    expect(all.meanDiffBps).toBeCloseTo(0, 12);
    const losses = lossesOf(diffs, "chosen vs immediate", 1);
    expect(losses.map((l) => l.group)).toEqual(["symbol=COIN"]);
    expect(losses[0]?.meanDiffBps).toBe(2);
  });
});

describe("source ablation on a real saved snapshot", () => {
  it("reproduces the registered choice with all sources and replays each removal", async () => {
    const p = await loadProtocol(PROTOCOL);
    const { order } = readJson<{
      order: { side: "buy" | "sell"; notionalUsd: number; roles: Record<string, string> };
    }>("eval", "order.json");
    const rep = replayAblations(
      snap,
      { symbol: "MSTR", side: order.side, notionalUsd: order.notionalUsd },
      p.profile,
    );
    expect(rep.baseline?.id).toBe(order.roles.chosen);
    expect(rep.replays.map((r) => r.source)).toEqual(ABLATIONS.map((a) => a.source));
    const noPerp = rep.replays.find((r) => r.source === "bitget.mix.orderbook");
    expect(noPerp?.chosen?.slices.every((s) => s.venue === "rtoken")).toBe(true);
    expect(primaryVenue(snap)).toBe("rtoken");
  });
});
