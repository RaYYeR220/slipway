// Freshness-aware source cache: in-memory with optional JSON-file persistence.
// A failed live fetch degrades to the last observed value (status "cached", still timestamped with its own asOf)
// within `maxStaleMs`, else to `status: "unavailable"` with the time the outage was first seen. Never a default value.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceRef } from "@slipway/core";
import type { Clock } from "./http.js";
import type { Optional } from "./types.js";

interface Entry {
  value?: unknown;
  asOf?: number | null;
  storedAt?: number;
  downSince?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface CachePolicy {
  /** Serve from cache without calling the source while the entry is younger than this. */
  ttlMs: number;
  /** After a failed fetch, keep serving the last value while it is younger than this. */
  maxStaleMs: number;
  /** After a failure, do not call the source again for this long (circuit breaker). */
  retryAfterMs?: number;
}

export interface Loaded<T> {
  value: T;
  asOf: number | null;
  detail?: string;
}

export class SourceCache {
  private readonly mem = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  readonly clock: Clock;

  constructor(private readonly opts: { dir?: string; clock?: Clock } = {}) {
    this.clock = opts.clock ?? Date.now;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  }

  private file(key: string): string | null {
    if (!this.opts.dir) return null;
    const readable = key.replace(/[^\w.-]+/g, "_").slice(0, 60);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return join(this.opts.dir, `${readable}.${hash}.json`);
  }

  private entry(key: string): Entry {
    let e = this.mem.get(key);
    if (e) return e;
    e = {};
    const f = this.file(key);
    if (f) {
      try {
        e = JSON.parse(readFileSync(f, "utf8")) as Entry;
      } catch {}
    }
    this.mem.set(key, e);
    return e;
  }

  private persist(key: string, e: Entry): void {
    const f = this.file(key);
    if (!f) return;
    try {
      writeFileSync(f, JSON.stringify(e));
    } catch {}
  }

  peek<T>(key: string): { value: T; asOf: number | null; storedAt: number } | undefined {
    const e = this.entry(key);
    return e.storedAt === undefined
      ? undefined
      : { value: e.value as T, asOf: e.asOf ?? null, storedAt: e.storedAt };
  }

  put(key: string, value: unknown, asOf: number | null): void {
    const e: Entry = { value, asOf, storedAt: this.clock() };
    this.mem.set(key, e);
    this.persist(key, e);
  }

  fail(key: string, error: string): number {
    const e = this.entry(key);
    const now = this.clock();
    e.downSince ??= now;
    e.lastFailureAt = now;
    e.lastError = error;
    this.persist(key, e);
    return e.downSince;
  }

  status(key: string): { downSince?: number; lastFailureAt?: number; lastError?: string } {
    const { downSince, lastFailureAt, lastError } = this.entry(key);
    return { downSince, lastFailureAt, lastError };
  }

  /** Runs `load` behind the cache policy and always resolves (never throws). Concurrent calls share one load. */
  async fetch<T>(
    key: string,
    sourceId: string,
    policy: CachePolicy,
    load: () => Promise<Loaded<T>>,
  ): Promise<Optional<T>> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<Optional<T>>;
    const p = this.run(key, sourceId, policy, load).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run<T>(
    key: string,
    sourceId: string,
    policy: CachePolicy,
    load: () => Promise<Loaded<T>>,
  ): Promise<Optional<T>> {
    const now = this.clock();
    const e = this.entry(key);
    const age = e.storedAt === undefined ? Number.POSITIVE_INFINITY : now - e.storedAt;
    if (age <= policy.ttlMs) {
      return {
        data: e.value as T,
        source: ref(sourceId, "cached", e.asOf ?? null, `cache hit, stored ${fmtAge(age)} ago`),
        latencyMs: 0,
      };
    }
    const breakerOpen =
      e.lastFailureAt !== undefined &&
      policy.retryAfterMs !== undefined &&
      now - e.lastFailureAt < policy.retryAfterMs;
    let spentMs = 0;
    if (!breakerOpen) {
      const t0 = performance.now();
      try {
        const got = await load();
        const latencyMs = Math.round(performance.now() - t0);
        const fresh: Entry = { value: got.value, asOf: got.asOf, storedAt: this.clock() };
        this.mem.set(key, fresh);
        this.persist(key, fresh);
        return {
          data: got.value,
          source: ref(sourceId, "live", got.asOf, got.detail ?? `${latencyMs} ms`),
          latencyMs,
        };
      } catch (err) {
        spentMs = Math.round(performance.now() - t0);
        this.fail(key, err instanceof Error ? err.message : String(err));
      }
    }
    const since = e.downSince ?? now;
    const why = `${breakerOpen ? "source down, retry deferred" : "live fetch failed"}: ${e.lastError ?? "unknown error"}`;
    if (e.storedAt !== undefined && age <= policy.maxStaleMs) {
      return {
        data: e.value as T,
        source: {
          ...ref(sourceId, "cached", e.asOf ?? null, `${why}; serving value stored ${fmtAge(age)} ago`),
          since,
        },
        latencyMs: spentMs,
      };
    }
    return {
      data: null,
      source: { ...ref(sourceId, "unavailable", e.asOf ?? null, why), since },
      latencyMs: spentMs,
    };
  }
}

export function ref(
  id: string,
  status: SourceRef["status"],
  asOf: number | null,
  detail?: string,
): SourceRef {
  return detail === undefined ? { id, status, asOf } : { id, status, asOf, detail };
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Stable key fragment for a params object. */
export function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${k}:${stableKey((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
