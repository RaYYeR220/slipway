import { describe, expect, it } from "vitest";
import { checkNumbers, extractNumbers } from "../src/number-guard.js";

const tools = [
  {
    best: { id: "sliced:perp:n12:t900", expectedBps: 8.5234, sdBps: 13.61, notionalUsd: 250000 },
    slices: [{}, {}, {}],
    arrivalMid: 239.574,
    funding: { rate: 0.000089, intervalHours: 8 },
    session: { nyLocal: "2026-10-06 09:30" },
  },
];

describe("extractNumbers", () => {
  it("reads plain, signed, grouped and suffixed numbers with their display precision", () => {
    const got = extractNumbers("Cost 8.5 bp ± 13.6, $250,000 or $250k, mid -1.2%, 1.5M shares").map((n) => [
      n.value,
      n.decimals,
    ]);
    expect(got).toEqual([
      [8.5, 1],
      [13.6, 1],
      [250000, 0],
      [250000, 0],
      [-1.2, 1],
      [1_500_000, 1],
    ]);
  });

  it("treats clock times and dates as single tokens", () => {
    const got = extractNumbers("on 2026-10-06 wait until 09:30 ET");
    expect(got.map((t) => [t.raw, t.unit])).toEqual([
      ["2026-10-06", "date"],
      ["09:30", "time"],
    ]);
  });

  it("exempts only known identifier shapes; other digits glued to letters are surfaced", () => {
    const got = extractNumbers("rNVDA vs S2, sliced:perp:n12:t900, RNVDAUSDT, v3 and 0x06cD");
    expect(got.map((t) => [t.raw, t.unit])).toEqual([["S2", "glued"]]);
  });

  it("normalises full-width digits before parsing", () => {
    expect(extractNumbers("８.５ bp").map((t) => t.value)).toEqual([8.5]);
  });
});

describe("checkNumbers", () => {
  it("accepts numbers that round from a tool value", () => {
    const r = checkNumbers("Expected 8.5 bp with sd 13.6 bp on $250,000 at mid 239.57.", tools);
    expect(r.ok).toBe(true);
    expect(r.unverified).toEqual([]);
  });

  it("accepts scaled forms: k suffix, fractions shown as percent, array counts, attached units", () => {
    expect(checkNumbers("$250k in 3 slices; funding 0.0089% every 8h", tools).ok).toBe(true);
  });

  it("accepts clock times and dates present in tool strings", () => {
    expect(checkNumbers("Wait for 09:30 on 2026-10-06.", tools).ok).toBe(true);
    expect(checkNumbers("Wait for 10:00.", tools).ok).toBe(false);
  });

  it("flags a number no tool produced (fails closed)", () => {
    const r = checkNumbers("Expected 7.9 bp, about 40% cheaper than TWAP.", tools);
    expect(r.ok).toBe(false);
    expect(r.unverified.map((u) => u.raw)).toEqual(["7.9", "40%"]);
  });

  it("does not let coarse rounding stretch a number", () => {
    expect(checkNumbers("8.6 bp", tools).ok).toBe(false); // wrong at its own precision
    expect(checkNumbers("about 9 bp", tools).ok).toBe(false); // 8.52 → 9 is a 5.6% stretch
    expect(checkNumbers("about 8.5 bp", tools).ok).toBe(true);
  });

  it("requires the written sign to match", () => {
    expect(checkNumbers("saves -8.5 bp", tools).ok).toBe(false);
    expect(checkNumbers("costs +8.5 bp", tools).ok).toBe(true);
  });

  it("rejects digits hidden inside words", () => {
    const r = checkNumbers("Expected x9bp, or 8,5bp in some locales.", tools);
    expect(r.ok).toBe(false);
    expect(r.unverified.map((u) => u.unit)).toEqual(["glued", "glued"]);
  });

  it("allows numbers the user said themselves and explicit allowlisted tokens", () => {
    expect(checkNumbers("You asked for $40k of NVDA.", tools, { userText: "buy $40k NVDA" }).ok).toBe(true);
    expect(checkNumbers("Season S2 desk.", tools, { allow: ["S2"] }).ok).toBe(true);
  });

  it("masks unverified numbers in the redacted text", () => {
    expect(checkNumbers("Expected 7.9 bp.", tools).redacted).toBe("Expected [unverified] bp.");
  });
});
