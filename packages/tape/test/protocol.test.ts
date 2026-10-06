import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  batchIdOf,
  batchStartOf,
  drawBatch,
  loadProtocol,
  mulberry32,
  PROTOCOL_HASH,
} from "../src/eval/protocol.js";

const PROTOCOL = fileURLToPath(new URL("../../../eval/protocol.json", import.meta.url));

describe("pre-registered protocol", () => {
  it("loads only the committed protocol (hash pinned)", async () => {
    const p = await loadProtocol(PROTOCOL);
    expect(p.seed).toBe(20261006);
    await expect(loadProtocol(PROTOCOL, "0".repeat(64))).rejects.toThrow(/hashes to 83106457/);
    expect(PROTOCOL_HASH.startsWith("8310645726")).toBe(true);
  });

  it("mulberry32 matches the reference implementation", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });

  it("draws the same batch for the same 10-minute window, a different one for the next", async () => {
    const p = await loadProtocol(PROTOCOL);
    const t = Date.parse("2026-10-06T06:13:25Z");
    const start = batchStartOf(p, t);
    expect(start).toBe(Date.parse("2026-10-06T06:10:00Z"));
    expect(batchIdOf(start)).toBe("20261006T0610Z");
    const a = drawBatch(p, start);
    expect(drawBatch(p, batchStartOf(p, t + 6 * 60_000))).toEqual(a);
    expect(a.length).toBe(12);
    expect(a[0]).toEqual({ i: 0, symbol: "META", notionalUsd: 100000, side: "sell" });
    expect(drawBatch(p, start + 600_000)).not.toEqual(a);
    // uniform with replacement: every symbol, size and side shows up over a day of batches
    const day = Array.from({ length: 144 }, (_, k) => drawBatch(p, start + k * 600_000)).flat();
    expect(new Set(day.map((o) => o.symbol)).size).toBe(18);
    expect(new Set(day.map((o) => o.notionalUsd))).toEqual(new Set([5000, 25000, 100000]));
    expect(new Set(day.map((o) => o.side))).toEqual(new Set(["buy", "sell"]));
  });
});
