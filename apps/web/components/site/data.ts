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

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A 200 with the wrong shape is reported like any other failure, never cast and rendered.
async function getShaped<T>(
  url: string,
  revalidate: number,
  what: string,
  valid: (d: unknown) => boolean,
): Promise<Fetched<T>> {
  const r = await getJson<unknown>(url, revalidate);
  if (!r.ok) return r;
  return valid(r.data)
    ? { ok: true, data: r.data as T, url }
    : { ok: false, error: `malformed ${what}`, url };
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
const isTrackRecord = (d: unknown) =>
  isObj(d) &&
  isObj(d.protocol) &&
  typeof d.protocol.hash === "string" &&
  isObj(d.counts) &&
  isObj(d.ungradedReasons) &&
  isObj(d.headToHead) &&
  isObj(d.accuracy) &&
  isObj(d.calibration) &&
  (d.ablation === null || (isObj(d.ablation) && Array.isArray(d.ablation.sources))) &&
  Array.isArray(d.losses) &&
  isObj(d.anchoring) &&
  Array.isArray(d.notes);

export const getTrackRecord = () =>
  getShaped<TrackRecord>(TRACK_RECORD_URL, 60, "track record", isTrackRecord);

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
const isAtlas = (d: unknown) =>
  isObj(d) &&
  isObj(d.atlas) &&
  Object.values(d.atlas).every(isObj) &&
  isObj(d.window) &&
  (d.flags === undefined || Array.isArray(d.flags));

export const getAtlas = () => getShaped<AtlasDoc>(ATLAS_URL, 60, "atlas", isAtlas);

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
  source: string; // where the points came from, shown under the figure
  files: number;
  filesListed: number;
  from: number | null;
  to: number | null;
  points: GradePoint[];
}

/* ---------- derived/track-record-points.json (published by every grade run) ---------- */

interface PublishedPoint {
  id: string;
  symbol: string;
  venue: string;
  session: string;
  family: string;
  scope: "order" | "slice";
  horizonSec: number;
  registeredAt: number;
  at: number;
  predicted: { p50: number; p10?: number; p90?: number };
  realized: { shadow: number; modeled?: number; bound?: number };
}

export const POINTS_URL = `${PUBLIC_BASE}/derived/track-record-points.json`;

const horizonBucket = (s: number) =>
  s <= 60 ? "0-60s" : s <= 900 ? "1-15m" : s <= 21_600 ? "15m-6h" : ">6h";

// reduce, not Math.min(...ts): a spread of thousands of points can overflow the call stack.
const timeSpan = (ts: number[]) =>
  ts.length
    ? { from: ts.reduce((a, b) => Math.min(a, b)), to: ts.reduce((a, b) => Math.max(a, b)) }
    : { from: null, to: null };

async function getPublishedPoints(): Promise<Fetched<GradeSample>> {
  const r = await getJson<{ points?: PublishedPoint[] } | PublishedPoint[]>(POINTS_URL, 60);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? r.data : (r.data?.points ?? []);
  const points: GradePoint[] = (Array.isArray(rows) ? rows : [])
    .filter(
      (p) =>
        p?.scope === "order" &&
        typeof p.realized?.shadow === "number" &&
        p.predicted &&
        typeof p.predicted.p50 === "number",
    )
    .map((p) => ({
      at: p.at,
      symbol: p.symbol,
      venue: p.venue,
      session: p.session,
      family: p.family,
      horizon: horizonBucket(p.horizonSec),
      chosen: false,
      p10: p.predicted.p10 ?? null,
      p50: p.predicted.p50,
      p90: p.predicted.p90 ?? null,
      realized: {
        // omitted labels equal the shadow fill at the published precision
        REPRODUCIBLE: p.realized.shadow,
        MODELED: p.realized.modeled ?? p.realized.shadow,
        BOUND: p.realized.bound ?? p.realized.shadow,
      },
    }));
  if (!points.length) return { ok: false, error: "no graded order points published", url: POINTS_URL };
  return {
    ok: true,
    url: POINTS_URL,
    data: {
      source: "derived/track-record-points.json · the latest graded order-level forecasts",
      files: 1,
      filesListed: 1,
      ...timeSpan(points.map((p) => p.at)),
      points,
    },
  };
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
    const items = r.data?.items;
    for (const it of Array.isArray(items) ? items : []) if (typeof it?.name === "string") names.push(it.name);
    token = r.data?.nextPageToken;
    if (!token) break;
  }
  return { ok: true, data: names, url: `${LISTING_BASE}?prefix=${prefix}` };
}

/** Graded order-level forecasts: the published points file, else the most recent `maxFiles` raw grade files. */
export async function getGradeSample(maxFiles = 48): Promise<Fetched<GradeSample>> {
  try {
    return await readGradeSample(maxFiles);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), url: POINTS_URL };
  }
}

async function readGradeSample(maxFiles: number): Promise<Fetched<GradeSample>> {
  const published = await getPublishedPoints();
  if (published.ok) return published;
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
      if (g?.scope !== "order" || g.status !== "graded" || !g.realized || typeof g.p50 !== "number") continue;
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
  return {
    ok: true,
    url: listed.url,
    data: {
      source: `grades/eval/ · latest ${read} of ${names.length} grade files, one batch each`,
      files: read,
      filesListed: names.length,
      ...timeSpan(points.map((p) => p.at)),
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
