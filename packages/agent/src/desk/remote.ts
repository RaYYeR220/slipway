// Derived artifacts published by the Slipway tape to its public bucket: the liquidity atlas and the graded
// track record. A missing or malformed artifact is reported as unavailable; nothing is substituted for it.
import { type CachePolicy, type Optional, ref, SourceCache } from "@slipway/bitget";
import type { Atlas, LiquidityStats, MarketSnapshot, SourceRef } from "@slipway/core";

export const BUCKET = "https://storage.googleapis.com/slipway-tape-c48c75";
export const ATLAS_URL = `${BUCKET}/derived/atlas.json`;
export const TRACK_RECORD_URL = `${BUCKET}/derived/track-record.json`;
export const ATLAS_SOURCE = "slipway.atlas";
export const TRACK_RECORD_SOURCE = "slipway.track-record";

export interface AtlasDoc {
  generatedAt: number | string;
  window?: unknown;
  atlas: Atlas;
  gapSigmaBps: Record<string, Record<string, number>>;
  basisSigmaBpsPerSqrtHour: Record<string, number>;
  coverage?: unknown;
  flags?: unknown[];
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const DERIVED_POLICY: CachePolicy = { ttlMs: 10 * 60_000, maxStaleMs: 24 * 3_600_000, retryAfterMs: 60_000 };

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isStats(v: unknown): v is LiquidityStats {
  if (!isRec(v)) return false;
  const s = v as Partial<LiquidityStats>;
  return (
    typeof s.symbol === "string" &&
    (s.venue === "rtoken" || s.venue === "perp") &&
    typeof s.session === "string" &&
    isNum(s.n) &&
    isRec(s.spreadBps) &&
    isRec(s.depthUsd) &&
    (typeof s.sigmaBpsPerSqrtSec === "number" || s.sigmaBpsPerSqrtSec === null) &&
    isRec(s.tradeNotionalPerMin)
  );
}

/** Keeps well-formed entries only; the count of dropped ones is reported in the source detail. */
export function parseAtlasDoc(body: unknown): { doc: AtlasDoc; dropped: number } {
  if (!isRec(body) || !isRec(body.atlas)) throw new Error("atlas.json: no `atlas` object");
  const atlas: Atlas = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(body.atlas)) {
    // JSON has no NaN: a session without a volatility estimate arrives as null and stays "no estimate".
    if (isStats(v) && k === `${v.symbol}|${v.venue}|${v.session}`)
      atlas[k] = { ...v, sigmaBpsPerSqrtSec: v.sigmaBpsPerSqrtSec ?? Number.NaN };
    else dropped++;
  }
  const numMap = (x: unknown): Record<string, number> =>
    isRec(x)
      ? (Object.fromEntries(Object.entries(x).filter(([, n]) => isNum(n))) as Record<string, number>)
      : {};
  const gap: Record<string, Record<string, number>> = {};
  if (isRec(body.gapSigmaBps)) for (const [sym, m] of Object.entries(body.gapSigmaBps)) gap[sym] = numMap(m);
  return {
    doc: {
      generatedAt:
        isNum(body.generatedAt) || typeof body.generatedAt === "string" ? body.generatedAt : "unknown",
      window: body.window,
      atlas,
      gapSigmaBps: gap,
      basisSigmaBpsPerSqrtHour: numMap(body.basisSigmaBpsPerSqrtHour),
      coverage: body.coverage,
      flags: Array.isArray(body.flags) ? body.flags : [],
    },
    dropped,
  };
}

const generatedAtMs = (g: number | string): number | null =>
  typeof g === "number" ? g : Number.isFinite(Date.parse(g)) ? Date.parse(g) : null;

export class DerivedArtifacts {
  constructor(
    private readonly cache: SourceCache = new SourceCache(),
    private readonly fetchImpl: Fetch = (u, i) => fetch(u, i),
    private readonly urls = { atlas: ATLAS_URL, trackRecord: TRACK_RECORD_URL },
  ) {}

  private async json(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res.json();
  }

  atlas(): Promise<Optional<AtlasDoc>> {
    return this.cache.fetch("derived:atlas", ATLAS_SOURCE, DERIVED_POLICY, async () => {
      const { doc, dropped } = parseAtlasDoc(await this.json(this.urls.atlas));
      return {
        value: doc,
        asOf: generatedAtMs(doc.generatedAt),
        detail: `${Object.keys(doc.atlas).length} keys${dropped ? `, ${dropped} malformed dropped` : ""}`,
      };
    });
  }

  trackRecord(): Promise<Optional<unknown>> {
    return this.cache.fetch("derived:track-record", TRACK_RECORD_SOURCE, DERIVED_POLICY, async () => {
      const body = await this.json(this.urls.trackRecord);
      if (!isRec(body)) throw new Error("track-record.json: not an object");
      const g = body.generatedAt;
      return { value: body, asOf: typeof g === "number" || typeof g === "string" ? generatedAtMs(g) : null };
    });
  }
}

/** Static atlas (tests, offline replays) wrapped as an available source. */
export const staticAtlas = (doc: AtlasDoc, asOf: number | null = null): Optional<AtlasDoc> => ({
  data: doc,
  source: ref(ATLAS_SOURCE, "cached", asOf, "static atlas"),
  latencyMs: 0,
});

/** Applies the symbol's atlas slice, gap and basis sigmas to a snapshot and records the atlas source. */
export function withAtlas<S extends MarketSnapshot>(snap: S, atlas: Optional<AtlasDoc>): S {
  const doc = atlas.data;
  const sources: SourceRef[] = [...snap.sources, atlas.source];
  if (!doc) return { ...snap, atlas: {}, sources };
  const own: Atlas = {};
  for (const [k, v] of Object.entries(doc.atlas)) if (v.symbol === snap.symbol) own[k] = v;
  const gap = doc.gapSigmaBps[snap.symbol];
  const basis = doc.basisSigmaBpsPerSqrtHour[snap.symbol];
  return {
    ...snap,
    atlas: own,
    ...(gap ? { gapSigmaBps: gap } : {}),
    ...(basis !== undefined ? { basisSigmaBpsPerSqrtHour: basis } : {}),
    sources,
  };
}
