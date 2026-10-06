// Object storage used for everything the tape package publishes (ledger, eval inputs, derived JSON, anchors):
// GCS in production, a local directory in tests and dry runs. Generations give compare-and-swap on both.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  DERIVED_CACHE_CONTROL,
  GcsClient,
  PreconditionFailed,
  type PutOptions,
  type TokenProvider,
} from "./gcs.js";
import { listPublic } from "./source.js";

export { PreconditionFailed };

export interface ObjectStore {
  readonly label: string;
  put(name: string, data: Buffer, o?: PutOptions): Promise<string>;
  get(name: string): Promise<{ data: Buffer; generation: string } | null>;
  delete(name: string, ifGenerationMatch?: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class GcsObjectStore implements ObjectStore {
  readonly label: string;
  readonly client: GcsClient;
  constructor(bucket: string, token: TokenProvider) {
    this.client = new GcsClient(bucket, token);
    this.label = `gs://${bucket}`;
  }
  put(name: string, data: Buffer, o?: PutOptions) {
    return this.client.put(name, data, o);
  }
  get(name: string) {
    return this.client.get(name);
  }
  delete(name: string, ifGenerationMatch?: string) {
    return this.client.delete(name, ifGenerationMatch);
  }
  list(prefix: string) {
    return this.client.list(prefix);
  }
}

const gen = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** Directory-backed store; the generation of an object is a hash of its content. */
export class FsObjectStore implements ObjectStore {
  readonly label: string;
  constructor(readonly dir: string) {
    this.label = `fs:${dir}`;
  }

  private path(name: string) {
    if (name.split("/").some((p) => p === ".." || p === "")) throw new Error(`bad object name ${name}`);
    return join(this.dir, ...name.split("/"));
  }

  async put(name: string, data: Buffer, o: PutOptions = {}): Promise<string> {
    const file = this.path(name);
    await mkdir(dirname(file), { recursive: true });
    if (o.ifGenerationMatch === "0") {
      try {
        await writeFile(file, data, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PreconditionFailed(name);
        throw e;
      }
      return gen(data);
    }
    if (o.ifGenerationMatch !== undefined) {
      const cur = await this.get(name);
      if (!cur || cur.generation !== o.ifGenerationMatch) throw new PreconditionFailed(name);
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    return gen(data);
  }

  async get(name: string) {
    try {
      const data = await readFile(this.path(name));
      return { data, generation: gen(data) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(name: string, ifGenerationMatch?: string) {
    if (ifGenerationMatch !== undefined) {
      const cur = await this.get(name);
      if (cur && cur.generation !== ifGenerationMatch) throw new PreconditionFailed(name);
    }
    await rm(this.path(name), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let names: import("node:fs").Dirent[];
      try {
        names = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n.name);
        if (n.isDirectory()) await walk(p);
        else if (!n.name.endsWith(".tmp")) out.push(relative(this.dir, p).split(sep).join("/"));
      }
    };
    await walk(this.dir);
    return out.filter((n) => n.startsWith(prefix)).sort();
  }
}

/** Publishes a derived JSON document (short cache so the web app sees updates within ~30 s). */
export async function publishJson(store: ObjectStore, name: string, value: unknown): Promise<string> {
  return store.put(name, Buffer.from(JSON.stringify(value)), {
    contentType: "application/json",
    cacheControl: DERIVED_CACHE_CONTROL,
    gzip: true,
  });
}

/** Read-only view of a public bucket over plain HTTPS (no credentials): what judges and `pnpm verify` use. */
export class PublicObjectStore implements ObjectStore {
  readonly label: string;
  constructor(
    readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.label = `https://storage.googleapis.com/${bucket}`;
  }
  async put(): Promise<string> {
    throw new Error("public store is read-only");
  }
  async delete(): Promise<void> {
    throw new Error("public store is read-only");
  }
  async get(name: string) {
    const res = await this.fetchImpl(
      `https://storage.googleapis.com/${this.bucket}/${name.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: { "cache-control": "no-cache" },
      },
    );
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`GET ${name}: HTTP ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      generation: res.headers.get("x-goog-generation") ?? "",
    };
  }
  list(prefix: string) {
    return listPublic(this.bucket, prefix, this.fetchImpl);
  }
}

/** Keeps a local copy of immutable objects (everything except head pointers), so repeated reads cost nothing. */
export class MirrorStore implements ObjectStore {
  readonly label: string;
  private readonly local: FsObjectStore;
  constructor(
    private readonly inner: ObjectStore,
    dir: string,
    private readonly mutable: (name: string) => boolean = (n) =>
      n.endsWith("head.json") || n.startsWith("derived/"),
  ) {
    this.local = new FsObjectStore(dir);
    this.label = `${inner.label} (mirror ${dir})`;
  }
  put(name: string, data: Buffer, o?: PutOptions) {
    return this.inner.put(name, data, o);
  }
  delete(name: string, g?: string) {
    return this.inner.delete(name, g);
  }
  list(prefix: string) {
    return this.inner.list(prefix);
  }
  async get(name: string) {
    if (this.mutable(name)) return this.inner.get(name);
    const hit = await this.local.get(name);
    if (hit) return hit;
    const got = await this.inner.get(name);
    if (got) await this.local.put(name, got.data);
    return got;
  }
}
