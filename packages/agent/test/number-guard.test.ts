import { describe, expect, it } from "vitest";
import { checkNumbers, extractNumbers } from "../src/number-guard.js";

const tools = [
  {
    best: { id: "sliced:perp:n12:t900", expectedBps: 8.5234, sdBps: 13.61, notionalUsd: 250000 },
    slices: [{}, {}, {}],
    arrivalMid: 239.574,
    funding: { rate: 0.000089 },
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

  it("treats clock times as one token", () => {
    const got = extractNumbers("wait until 09:30 ET");
    expect(got).toHaveLength(1);
    expect(got[0]?.raw).toBe("09:30");
  });

  it("ignores digits inside identifiers like tickers and strategy ids", () => {
    expect(extractNumbers("rNVDA vs S2 and sliced:perp:n12:t900 and 0x06cD")).toEqual([]);
  });
});

describe("checkNumbers", () => {
  it("accepts numbers that round from a tool value", () => {
    const r = checkNumbers("Expected 8.5 bp with sd 13.6 bp on $250,000 at mid 239.57.", tools);
    expect(r.ok).toBe(true);
    expect(r.unverified).toEqual([]);
  });

  it("accepts scaled forms: k/M suffixes, fractions shown as percent, array counts", () => {
    const r = checkNumbers("$250k in 3 slices; funding 0.0089% per 8h", tools, { allow: ["8"] });
    expect(r.ok).toBe(true);
  });

  it("accepts clock times present in tool strings", () => {
    expect(checkNumbers("Wait for 09:30.", tools).ok).toBe(true);
  });

  it("flags a number no tool produced (fails closed)", () => {
    const r = checkNumbers("Expected 7.9 bp, about 40% cheaper than TWAP.", tools);
    expect(r.ok).toBe(false);
    expect(r.unverified.map((u) => u.raw)).toEqual(["7.9", "40%"]);
  });

  it("does not let a coarser rounding launder a wrong number", () => {
    // 8.5234 rounds to 9 at integer precision, but "8.6" is wrong at its own stated precision.
    expect(checkNumbers("8.6 bp", tools).ok).toBe(false);
    expect(checkNumbers("about 9 bp", tools).ok).toBe(true);
  });

  it("allows numbers the user said themselves", () => {
    const r = checkNumbers("You asked for $40k of NVDA.", tools, { userText: "buy $40k NVDA" });
    expect(r.ok).toBe(true);
  });

  it("masks unverified numbers in the redacted text", () => {
    const r = checkNumbers("Expected 7.9 bp.", tools);
    expect(r.redacted).toBe("Expected [unverified] bp.");
  });
});
