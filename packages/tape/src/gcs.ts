// Minimal Google Cloud Storage JSON-API client (no SDK): multipart uploads with generation preconditions,
// downloads, listing and deletes. Access tokens come from, in order: GCS_ACCESS_TOKEN, a service-account key
// (GOOGLE_APPLICATION_CREDENTIALS / GCS_SA_KEY_JSON), the GCE metadata server (the VM), or `gcloud` (local dev).
import { exec } from "node:child_process";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export class PreconditionFailed extends Error {
  constructor(readonly object: string) {
    super(`precondition failed for ${object}`);
    this.name = "PreconditionFailed";
  }
}

export type TokenProvider = () => Promise<string>;

interface Cached {
  token: string;
  expiresAt: number;
}

const cache = (fetchToken: () => Promise<{ token: string; ttlSec: number }>): TokenProvider => {
  let c: Cached | null = null;
  return async () => {
    if (c && Date.now() < c.expiresAt - 60_000) return c.token;
    const t = await fetchToken();
    c = { token: t.token, expiresAt: Date.now() + t.ttlSec * 1000 };
    return c.token;
  };
};

export const metadataToken = (): TokenProvider =>
  cache(async () => {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) },
    );
    if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
    const b = (await res.json()) as { access_token: string; expires_in: number };
    return { token: b.access_token, ttlSec: b.expires_in };
  });

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export const serviceAccountToken = (key: ServiceAccountKey): TokenProvider =>
  cache(async () => {
    const now = Math.floor(Date.now() / 1000);
    const aud = key.token_uri ?? "https://oauth2.googleapis.com/token";
    const claims = {
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    const res = await fetch(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(sig)}`,
      }),
    });
    if (!res.ok) throw new Error(`service-account token: HTTP ${res.status} ${await res.text()}`);
    const b = (await res.json()) as { access_token: string; expires_in: number };
    return { token: b.access_token, ttlSec: b.expires_in };
  });

export const gcloudToken = (): TokenProvider =>
  cache(async () => {
    const { stdout } = await promisify(exec)("gcloud auth print-access-token");
    return { token: stdout.trim(), ttlSec: 1800 };
  });

export async function defaultTokenProvider(env = process.env): Promise<TokenProvider> {
  if (env.GCS_ACCESS_TOKEN) {
    const t = env.GCS_ACCESS_TOKEN;
    return async () => t;
  }
  const keyJson =
    env.GCS_SA_KEY_JSON ??
    (env.GOOGLE_APPLICATION_CREDENTIALS ? await readFile(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8") : null);
  if (keyJson) return serviceAccountToken(JSON.parse(keyJson) as ServiceAccountKey);
  const md = metadataToken();
  try {
    await md();
    return md;
  } catch {
    return gcloudToken();
  }
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  /** Store gzip bytes with Content-Encoding: gzip (served decompressed to clients that do not accept gzip). */
  gzip?: boolean;
  /** "0" = only if the object does not exist; otherwise the generation the object must currently have. */
  ifGenerationMatch?: string;
}

export interface StoredObject {
  data: Buffer;
  generation: string;
}

const API = "https://storage.googleapis.com";

export class GcsClient {
  constructor(
    readonly bucket: string,
    private readonly token: TokenProvider,
  ) {}

  private async auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async put(name: string, body: Buffer, o: PutOptions = {}): Promise<string> {
    const { gzipSync } = await import("node:zlib");
    const data = o.gzip ? gzipSync(body) : body;
    const meta: Record<string, string> = { name, contentType: o.contentType ?? "application/octet-stream" };
    if (o.cacheControl) meta.cacheControl = o.cacheControl;
    if (o.gzip) meta.contentEncoding = "gzip";
    const boundary = `slipway${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${meta.contentType}\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const u = new URL(`${API}/upload/storage/v1/b/${this.bucket}/o`);
    u.searchParams.set("uploadType", "multipart");
    if (o.ifGenerationMatch !== undefined) u.searchParams.set("ifGenerationMatch", o.ifGenerationMatch);
    const res = await fetch(u, {
      method: "POST",
      headers: { ...(await this.auth()), "content-type": `multipart/related; boundary=${boundary}` },
      body: payload,
    });
    if (res.status === 412) throw new PreconditionFailed(name);
    if (!res.ok) throw new Error(`upload ${name}: HTTP ${res.status} ${await res.text()}`);
    return ((await res.json()) as { generation: string }).generation;
  }

  async get(name: string): Promise<StoredObject | null> {
    const res = await fetch(`${API}/storage/v1/b/${this.bucket}/o/${encodeURIComponent(name)}?alt=media`, {
      headers: await this.auth(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`get ${name}: HTTP ${res.status}`);
    const generation = res.headers.get("x-goog-generation") ?? "";
    return { data: Buffer.from(await res.arrayBuffer()), generation };
  }

  async delete(name: string, ifGenerationMatch?: string): Promise<void> {
    const u = new URL(`${API}/storage/v1/b/${this.bucket}/o/${encodeURIComponent(name)}`);
    if (ifGenerationMatch) u.searchParams.set("ifGenerationMatch", ifGenerationMatch);
    const res = await fetch(u, { method: "DELETE", headers: await this.auth() });
    if (res.status === 412) throw new PreconditionFailed(name);
    if (!res.ok && res.status !== 404) throw new Error(`delete ${name}: HTTP ${res.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const u = new URL(`${API}/storage/v1/b/${this.bucket}/o`);
      u.searchParams.set("prefix", prefix);
      u.searchParams.set("fields", "items(name),nextPageToken");
      if (token) u.searchParams.set("pageToken", token);
      const res = await fetch(u, { headers: await this.auth() });
      if (!res.ok) throw new Error(`list ${prefix}: HTTP ${res.status}`);
      const b = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
      for (const it of b.items ?? []) out.push(it.name);
      token = b.nextPageToken;
    } while (token);
    return out;
  }
}

export const DERIVED_CACHE_CONTROL = "no-cache, max-age=30";
