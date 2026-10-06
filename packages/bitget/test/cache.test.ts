import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceCache, stableKey } from "../src/cache.js";
import { addDays, nyDate, nyOffsetMinutes, nyWallToUtc, parseNyLocal } from "../src/nytime.js";

describe("New York time", () => {
  it("tracks DST through the IANA zone", () => {
    expect(nyOffsetMinutes(Date.UTC(2026, 9, 6, 7))).toBe(-240);
    expect(nyOffsetMinutes(Date.UTC(2026, 10, 2, 12))).toBe(-300);
    expect(nyOffsetMinutes(Date.UTC(2026, 2, 8, 6, 59))).toBe(-300);
    expect(nyOffsetMinutes(Date.UTC(2026, 2, 8, 7, 0))).toBe(-240);
  });

  it("converts wall clock to epoch on both sides of the switch", () => {
    expect(new Date(nyWallToUtc(2026, 10, 30, 20)).toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(new Date(nyWallToUtc(2026, 11, 26, 20)).toISOString()).toBe("2026-11-27T01:00:00.000Z");
    expect(new Date(parseNyLocal("2026-11-25 20:00")).toISOString()).toBe("2026-11-26T01:00:00.000Z");
    expect(Number.isNaN(parseNyLocal("not a date"))).toBe(true);
  });

  it("does date arithmetic on NY calendar dates", () => {
    expect(nyDate(Date.UTC(2026, 9, 6, 3))).toBe("2026-10-05");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("SourceCache", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const policy = { ttlMs: 1000, maxStaleMs: 60_000, retryAfterMs: 5_000 };

  it("serves live, then cache hits within the TTL", async () => {
    let t = 0;
    const cache = new SourceCache({ clock: () => t });
    let calls = 0;
    const load = async () => ({ value: ++calls, asOf: 7 });
    const a = await cache.fetch("k", "src", policy, load);
    expect(a.source).toMatchObject({ id: "src", status: "live", asOf: 7 });
    t = 500;
    const b = await cache.fetch("k", "src", policy, load);
    expect(b).toMatchObject({ data: 1, source: { status: "cached", asOf: 7 } });
    expect(calls).toBe(1);
  });

  it("falls back to the last observed value, then to unavailable with the outage start", async () => {
    let t = 0;
    const cache = new SourceCache({ clock: () => t });
    await cache.fetch("k", "src", policy, async () => ({ value: "v1", asOf: 1 }));
    t = 2_000;
    const fail = async () => {
      throw new Error("upstream 503");
    };
    const stale = await cache.fetch("k", "src", policy, fail);
    expect(stale.data).toBe("v1");
    expect(stale.source).toMatchObject({ status: "cached", asOf: 1, since: 2_000 });
    expect(stale.source.detail).toMatch(/live fetch failed: upstream 503; serving value stored 2 s ago/);
    t = 70_000;
    const gone = await cache.fetch("k", "src", policy, fail);
    expect(gone).toMatchObject({ data: null, source: { status: "unavailable", since: 2_000, asOf: 1 } });
  });

  it("opens a circuit breaker after a failure and closes it after a success", async () => {
    let t = 0;
    const cache = new SourceCache({ clock: () => t });
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("timeout");
    };
    await cache.fetch("k", "src", policy, fail);
    t = 1_000;
    const skipped = await cache.fetch("k", "src", policy, fail);
    expect(calls).toBe(1);
    expect(skipped.source.detail).toMatch(/retry deferred/);
    t = 6_000;
    const ok = await cache.fetch("k", "src", policy, async () => ({ value: 1, asOf: 6_000 }));
    expect(ok.source.status).toBe("live");
    expect(cache.status("k").downSince).toBeUndefined();
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cache = new SourceCache();
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { value: calls, asOf: null };
    };
    const [a, b] = await Promise.all([
      cache.fetch("k", "s", policy, load),
      cache.fetch("k", "s", policy, load),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("persists entries and outage state to the cache directory", async () => {
    dir = mkdtempSync(join(tmpdir(), "slipway-cache-"));
    let t = 100;
    const first = new SourceCache({ dir, clock: () => t });
    await first.fetch("bitget-mcp:x", "s", policy, async () => ({ value: { a: 1 }, asOf: 100 }));
    t = 10_000;
    const second = new SourceCache({ dir, clock: () => t });
    const r = await second.fetch("bitget-mcp:x", "s", policy, async () => {
      throw new Error("down");
    });
    expect(r).toMatchObject({ data: { a: 1 }, source: { status: "cached", asOf: 100, since: 10_000 } });
    const third = new SourceCache({ dir, clock: () => t });
    expect(third.status("bitget-mcp:x").downSince).toBe(10_000);
  });

  it("builds order-independent keys", () => {
    expect(stableKey({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(stableKey({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
});
