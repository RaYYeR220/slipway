// Where the recorded tape lives: a local directory (`<dir>/<stream>/<YYYY-MM-DDTHH>.jsonl.gz`, as the recorder
// writes it) or the public GCS bucket the VM syncs it to. Both expose the same hourly gzip files.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const STREAMS = ["books", "depth", "trades", "tickers", "states"] as const;
export type Stream = (typeof STREAMS)[number];

export const PUBLIC_BUCKET = "slipway-tape-c48c75";
export const PUBLIC_BASE = `https://storage.googleapis.com/${PUBLIC_BUCKET}`;

const HOUR_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl\.gz$/;
export const HOUR_MS = 3_600_000;

/** UTC hour bucket of a timestamp, as used in tape file names ("2026-10-06T04"). */
export const hourKey = (ts: number): string => new Date(ts).toISOString().slice(0, 13);
export const hourStart = (key: string): number => Date.parse(`${key}:00:00Z`);

export interface TapeSource {
  readonly label: string;
  /** Hour keys present for a stream, ascending. */
  hours(stream: Stream): Promise<string[]>;
  /** Raw gzip bytes of one hour file, or null if it does not exist. */
  open(stream: Stream, hour: string): Promise<Readable | null>;
}

export class FsTapeSource implements TapeSource {
  readonly label: string;
  constructor(readonly dir: string) {
    this.label = `fs:${dir}`;
  }

  async hours(stream: Stream): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, stream));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names
      .map((n) => HOUR_FILE.exec(n)?.[1])
      .filter((h): h is string => h !== undefined)
      .sort();
  }

  async open(stream: Stream, hour: string): Promise<Readable | null> {
    const file = join(this.dir, stream, `${hour}.jsonl.gz`);
    try {
      await stat(file);
    } catch {
      return null;
    }
    return createReadStream(file, { highWaterMark: 1 << 16 });
  }
}

/** Public bucket over HTTPS: listing through the JSON API (public for allUsers buckets), bytes via the object URL. */
/**
 * Public bucket over HTTPS: listing through the JSON API (public for allUsers buckets), bytes via the object URL
 * pinned to the listed generation, so an edge-cached copy of a still-growing hour can never be served stale.
 */
export class HttpTapeSource implements TapeSource {
  readonly label: string;
  private readonly generations = new Map<string, string>();
  constructor(
    readonly bucket = PUBLIC_BUCKET,
    readonly prefix = "tape/raw",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.label = `gs://${bucket}/${prefix}`;
  }

  async hours(stream: Stream): Promise<string[]> {
    const objects = await listPublicObjects(this.bucket, `${this.prefix}/${stream}/`, this.fetchImpl);
    const out: string[] = [];
    for (const o of objects) {
      const h = HOUR_FILE.exec(o.name.slice(o.name.lastIndexOf("/") + 1))?.[1];
      if (!h) continue;
      this.generations.set(`${stream}/${h}`, o.generation);
      out.push(h);
    }
    return out.sort();
  }

  async open(stream: Stream, hour: string): Promise<Readable | null> {
    if (!this.generations.has(`${stream}/${hour}`)) await this.hours(stream);
    const gen = this.generations.get(`${stream}/${hour}`);
    if (!gen) return null;
    const url = `https://storage.googleapis.com/${this.bucket}/${this.prefix}/${stream}/${hour}.jsonl.gz?generation=${gen}`;
    const res = await this.fetchImpl(url);
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  }
}

/** Objects (name, generation) under a prefix of a public bucket (JSON API, paginated). */
export async function listPublicObjects(
  bucket: string,
  prefix: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; generation: string }[]> {
  const out: { name: string; generation: string }[] = [];
  let token: string | undefined;
  do {
    const u = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
    u.searchParams.set("prefix", prefix);
    u.searchParams.set("fields", "items(name,generation),nextPageToken");
    u.searchParams.set("maxResults", "1000");
    if (token) u.searchParams.set("pageToken", token);
    const res = await fetchImpl(u.toString());
    if (!res.ok) throw new Error(`list gs://${bucket}/${prefix}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      items?: { name: string; generation: string }[];
      nextPageToken?: string;
    };
    out.push(...(body.items ?? []));
    token = body.nextPageToken;
  } while (token);
  return out;
}

export const listPublic = async (bucket: string, prefix: string, fetchImpl: typeof fetch = fetch) =>
  (await listPublicObjects(bucket, prefix, fetchImpl)).map((o) => o.name);

/** HTTP source that keeps a local copy of closed hours (immutable once the recorder rotated and synced them). */
export class CachedTapeSource implements TapeSource {
  readonly label: string;
  constructor(
    private readonly inner: TapeSource,
    private readonly cacheDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.label = `${inner.label} (cache ${cacheDir})`;
  }

  hours(stream: Stream) {
    return this.inner.hours(stream);
  }

  async open(stream: Stream, hour: string): Promise<Readable | null> {
    const file = join(this.cacheDir, stream, `${hour}.jsonl.gz`);
    try {
      await stat(file);
      return createReadStream(file, { highWaterMark: 1 << 16 });
    } catch {}
    const body = await this.inner.open(stream, hour);
    if (!body || hourStart(hour) + HOUR_MS + 10 * 60_000 > this.clock()) return body;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await pipeline(body, createWriteStream(tmp));
    await rename(tmp, file);
    return createReadStream(file, { highWaterMark: 1 << 16 });
  }
}

/** First source that has an hour wins (e.g. the VM's own recording, then the bucket for older hours). */
export class UnionTapeSource implements TapeSource {
  readonly label: string;
  constructor(private readonly sources: readonly TapeSource[]) {
    this.label = sources.map((s) => s.label).join(" + ");
  }

  async hours(stream: Stream): Promise<string[]> {
    const all = new Set<string>();
    for (const s of this.sources) for (const h of await s.hours(stream)) all.add(h);
    return [...all].sort();
  }

  async open(stream: Stream, hour: string): Promise<Readable | null> {
    for (const s of this.sources) {
      if (!(await s.hours(stream)).includes(hour)) continue;
      const r = await s.open(stream, hour);
      if (r) return r;
    }
    return null;
  }
}

/** "dir", "gs://bucket/prefix", or several joined with "|" (earlier wins); `cacheDir` keeps closed GCS hours. */
export function tapeSource(spec: string, cacheDir?: string): TapeSource {
  const parts = spec
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  const one = (p: string): TapeSource => {
    if (!p.startsWith("gs://")) return new FsTapeSource(p);
    const [bucket, ...rest] = p.slice(5).split("/");
    const http = new HttpTapeSource(bucket, rest.join("/") || "tape/raw");
    return cacheDir ? new CachedTapeSource(new MemoHours(http), cacheDir) : new MemoHours(http);
  };
  return parts.length === 1 ? one(parts[0] as string) : new UnionTapeSource(parts.map(one));
}

/** Lists each stream once per process (listing a bucket per open() would cost a request per file). */
class MemoHours implements TapeSource {
  readonly label: string;
  private readonly memo = new Map<Stream, Promise<string[]>>();
  constructor(private readonly inner: TapeSource) {
    this.label = inner.label;
  }
  hours(stream: Stream) {
    let p = this.memo.get(stream);
    if (!p) {
      p = this.inner.hours(stream);
      this.memo.set(stream, p);
    }
    return p;
  }
  open(stream: Stream, hour: string) {
    return this.inner.open(stream, hour);
  }
}
