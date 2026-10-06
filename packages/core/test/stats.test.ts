import { describe, expect, it } from "vitest";
import {
  lag1Autocorrelation,
  mad,
  madSigma,
  mean,
  median,
  poissonTail,
  quantile,
  quantiles3,
  robustRms,
  Z90,
} from "../src/stats.js";
import { mulberry32 } from "./helpers.js";

describe("quantile", () => {
  it("interpolates linearly between order statistics (type 7)", () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([4, 1, 3, 2], 0)).toBe(1);
    expect(quantile([4, 1, 3, 2], 1)).toBe(4);
    expect(quantile([10, 20], 0.1)).toBeCloseTo(11, 12);
  });

  it("does not mutate its input and returns NaN when empty", () => {
    const xs = [3, 1, 2];
    quantile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("returns p10/p50/p90 together", () => {
    const xs = Array.from({ length: 11 }, (_, i) => i);
    expect(quantiles3(xs)).toEqual({ p10: 1, p50: 5, p90: 9 });
  });
});

describe("location and scale", () => {
  it("computes mean and median", () => {
    expect(mean([1, 2, 3, 10])).toBe(4);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(mean([])).toBeNaN();
  });

  it("scales MAD to a normal-consistent sigma and ignores an outlier", () => {
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(madSigma([1, 2, 3, 4, 100])).toBeCloseTo(1.4826, 10);
  });

  it("recovers the sigma of a seeded normal sample", () => {
    const rnd = mulberry32(7);
    const xs = Array.from({ length: 20_000 }, () => {
      const u = Math.max(rnd(), 1e-12);
      return 2 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
    });
    expect(madSigma(xs)).toBeCloseTo(2, 1);
    expect(robustRms(xs)).toBeGreaterThan(1.9);
    expect(robustRms(xs)).toBeLessThan(2.05);
  });

  it("keeps RMS finite and meaningful on zero-inflated data where MAD collapses", () => {
    const xs = [
      ...Array.from({ length: 90 }, () => 0),
      ...Array.from({ length: 10 }, (_, i) => (i % 2 ? 1 : -1)),
    ];
    expect(madSigma(xs)).toBe(0);
    expect(robustRms(xs)).toBeCloseTo(Math.sqrt(0.1), 10);
  });

  it("clips a single glitch in robustRms", () => {
    const xs = [...Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1)), 1000];
    expect(robustRms(xs)).toBeLessThan(2);
  });
});

describe("poissonTail", () => {
  it("matches closed forms for small lambda", () => {
    expect(poissonTail(1, 2)).toBeCloseTo(1 - Math.exp(-2), 12);
    expect(poissonTail(3, 2)).toBeCloseTo(1 - 5 * Math.exp(-2), 12);
  });

  it("handles the edges", () => {
    expect(poissonTail(0, 5)).toBe(1);
    expect(poissonTail(-2, 5)).toBe(1);
    expect(poissonTail(1, 0)).toBe(0);
    expect(poissonTail(2.2, 2)).toBeCloseTo(poissonTail(3, 2), 12);
  });

  it("stays accurate where exp(-lambda) underflows", () => {
    const p = poissonTail(1000, 1000);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.52);
    expect(poissonTail(1300, 1000)).toBeLessThan(1e-15);
  });
});

describe("lag1Autocorrelation", () => {
  it("is near 1 for a persistent series and near 0 for white noise", () => {
    const rnd = mulberry32(11);
    const noise = Array.from({ length: 2000 }, () => rnd());
    let x = 0;
    const ar = noise.map((e) => {
      x = 0.95 * x + (e - 0.5);
      return x;
    });
    expect(lag1Autocorrelation(ar)).toBeGreaterThan(0.9);
    expect(Math.abs(lag1Autocorrelation(noise))).toBeLessThan(0.08);
    expect(lag1Autocorrelation([1, 1, 1])).toBeNaN();
  });
});

describe("Z90", () => {
  it("is the standard normal 90th percentile", () => {
    expect(Z90).toBeCloseTo(1.2815515655, 9);
  });
});
