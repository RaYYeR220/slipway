// Server-side readers for Slipway's public, keyless data: the derived track record and atlas, per-forecast grades
// and anchor files in the public tape bucket. Every reader returns { ok:false, error } instead of inventing data.
import type { LiquidityStats } from "@slipway/core";

export const BUCKET = "slipway-tape-c48c75";
export const PUBLIC_BASE = `https://storage.googleapis.com/${BUCKET}`;
export const LISTING_BASE = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
export const REPO_URL = "https://github.com/RaYYeR220/slipway";

export type Fetched<T> = { ok: true; data: T; url: string } | { ok: false; error: string; url: string };

async function getJson<T>(url: string, revalidate = 60): Promise<Fetched<T>> {
  try {
    const res = await fetch(url, { next: { revalidate } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url };
    return { ok: true, data: (await res.json()) as T, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), url };
  }
}

/* ---------- track record (derived/track-record.json, written by the grader) ---------- */

export type Label = "REPRODUCIBLE" | "MODELED" | "BOUND";
export const LABELS: Label[] = ["REPRODUCIBLE", "MODELED", "BOUND"];

export interface Counts {
  entries: number;
  graded: number;
  ungraded: number;
  pending: number;
}
export interface AccuracyRow {
  scope: "order" | "slice";
  venue: string;
  session: string;
  horizon: string;
  n: number;
  maeBps: number;
  biasBps: number;
  coverage?: { n: number; inside: number; rate: number };
}
export interface Comparison {
  n: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  meanDiffBps: number;
  ci95: [number, number];
}
export interface CalibrationRow {
  venue: string;
  session: string;
  evalN: number;
  k: number;
  maeRawBps: number;
  maeCalibratedBps: number;
}
export interface AblationRow {
  source: string;
  fallback: string;
  orders: number;
  changed: number;
  changedShare: number;
  deltaRealizedBps: { n: number; mean: number; ci95: [number, number] } | null;
  deltaAbsErrorBps: { n: number; mean: number } | null;
}
export interface LossRow {
  comparison: string;
  group: string;
  n: number;
  meanDiffBps: number;
  ci95: [number, number];
}
export interface TrackRecord {
  generatedAt: number;
  protocol: { name: string; version: number; hash: string };
  tapeEnd: number | null;
  primaryLabel: string;
  labels: string[];
  counts: Record<string, Counts>;
  ungradedReasons: Record<string, number>;
  accuracy: Record<string, AccuracyRow[]>;
  headToHead: Record<string, { vsImmediate?: Comparison | null; vsTwap60?: Comparison | null }>;
  calibration: Record<string, CalibrationRow[]>;
  ablation: {
    batches: number;
    orders: number;
    replayMatchesRegistered: number;
    sources: AblationRow[];
  } | null;
  losses: LossRow[];
  anchoring: { anchoredBeforeOutcome: number; ledgerTimestampedOnly: number };
  notes: string[];
}

export const TRACK_RECORD_URL = `${PUBLIC_BASE}/derived/track-record.json`;
export const getTrackRecord = () => getJson<TrackRecord>(TRACK_RECORD_URL, 60);

/* ---------- atlas (derived/atlas.json, written by the atlas builder) ---------- */

export interface AtlasDoc {
  generatedAt: number;
  window: { from: number; to: number };
  atlas: Record<string, LiquidityStats>;
  gapSigmaBps?: Record<string, Record<string, number>>;
  basisSigmaBpsPerSqrtHour?: Record<string, number>;
  coverage?: Record<string, { snapshots: number; trades: number; hours: number }>;
  flags?: string[];
}

export const ATLAS_URL = `${PUBLIC_BASE}/derived/atlas.json`;
export const getAtlas = () => getJson<AtlasDoc>(ATLAS_URL, 60);

/* ---------- per-forecast grades (grades/eval/<date>/<ledger file>.json) ---------- */

export interface GradeEntry {
  id: string;
  scope: "order" | "slice";
  symbol: string;
  side: string;
  venue: string;
  session: string;
  family: string;
  strategyId: string;
  horizon: string;
  at: number;
  until: number;
  registeredAt: number;
  p10?: number;
  p50: number;
  p90?: number;
  status: "graded" | "ungraded" | "pending";
  roles?: string[];
  realized?: Partial<Record<Label, number | null>>;
}

/** One graded order-level forecast, trimmed for plotting. */
export interface GradePoint {
  at: number;
  symbol: string;
  venue: string;
  session: string;
  family: string;
  horizon: string;
  chosen: boolean;
  p10: number | null;
  p50: number;
  p90: number | null;
  realized: Record<Label, number | null>;
}

export interface GradeSample {
  files: number;
  filesListed: number;
  from: number | null;
  to: number | null;
  points: GradePoint[];
}

interface Listing {
  items?: { name: string }[];
  nextPageToken?: string;
}

async function listNames(prefix: string, revalidate = 60): Promise<Fetched<string[]>> {
  const names: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${LISTING_BASE}?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken&maxResults=1000${
      token ? `&pageToken=${encodeURIComponent(token)}` : ""
    }`;
    const r = await getJson<Listing>(url, revalidate);
    if (!r.ok) return { ok: false, error: r.error, url: r.url };
    for (const it of r.data.items ?? []) names.push(it.name);
    token = r.data.nextPageToken;
    if (!token) break;
  }
  return { ok: true, data: names, url: `${LISTING_BASE}?prefix=${prefix}` };
}

/** The most recent `maxFiles` grade files (one per eval batch), order-level graded forecasts only. */
export async function getGradeSample(maxFiles = 48): Promise<Fetched<GradeSample>> {
  const listed = await listNames("grades/eval/");
  if (!listed.ok) return listed;
  const names = listed.data.filter((n) => n.endsWith(".json")).sort();
  const pick = names.slice(-maxFiles);
  const files = await Promise.all(pick.map((n) => getJson<GradeEntry[]>(`${PUBLIC_BASE}/${n}`, 300)));
  const points: GradePoint[] = [];
  let read = 0;
  for (const f of files) {
    if (!f.ok || !Array.isArray(f.data)) continue;
    read++;
    for (const g of f.data) {
      if (g.scope !== "order" || g.status !== "graded" || !g.realized) continue;
      points.push({
        at: g.until ?? g.at,
        symbol: g.symbol,
        venue: g.venue,
        session: g.session,
        family: g.family,
        horizon: g.horizon,
        chosen: g.roles?.includes("chosen") ?? false,
        p10: typeof g.p10 === "number" ? g.p10 : null,
        p50: g.p50,
        p90: typeof g.p90 === "number" ? g.p90 : null,
        realized: {
          REPRODUCIBLE: g.realized.REPRODUCIBLE ?? null,
          MODELED: g.realized.MODELED ?? null,
          BOUND: g.realized.BOUND ?? null,
        },
      });
    }
  }
  if (!read) return { ok: false, error: "no grade file could be read", url: listed.url };
  const ts = points.map((p) => p.at);
  return {
    ok: true,
    url: listed.url,
    data: {
      files: read,
      filesListed: names.length,
      from: ts.length ? Math.min(...ts) : null,
      to: ts.length ? Math.max(...ts) : null,
      points,
    },
  };
}

/* ---------- anchoring ---------- */

export interface AnchorStatus {
  deployed: boolean;
  config: Record<string, unknown> | null;
  files: number;
  error?: string;
}

export async function getAnchorStatus(): Promise<AnchorStatus> {
  const cfg = await getJson<Record<string, unknown>>(`${PUBLIC_BASE}/anchors/config.json`, 120);
  const listed = await listNames("anchors/", 120);
  const files = listed.ok ? listed.data.filter((n) => /anchors\/\d+\.json$/.test(n)).length : 0;
  if (cfg.ok) return { deployed: true, config: cfg.data, files };
  return {
    deployed: false,
    config: null,
    files,
    ...(cfg.error.startsWith("HTTP 404") ? {} : { error: cfg.error }),
  };
}

export async function getLedgerCount(): Promise<number | null> {
  const listed = await listNames("ledger/eval/", 120);
  return listed.ok ? listed.data.filter((n) => n.endsWith(".jsonl")).length : null;
}
