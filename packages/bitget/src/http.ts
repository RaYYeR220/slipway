// Keyless HTTP JSON client: per-request timeout, retry with full jitter on network errors / 429 / 5xx,
// and token-bucket rate limiting (global + per endpoint group).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Bitget answered with a non-"00000" business code. */
export class BitgetApiError extends Error {
  constructor(
    readonly code: string,
    readonly msg: string,
    readonly url: string,
    readonly status: number,
  ) {
    super(`Bitget ${code}: ${msg}`);
    this.name = "BitgetApiError";
  }
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    this.tokens = burst;
    this.last = clock();
  }

  /** Reserves one token and returns how long the caller must wait before using it. */
  reserve(): number {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.ratePerSec) * 1000);
  }
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Global request rate (req/s). */
  rps?: number;
  /** Stricter per-group rates, e.g. { reality: 1 } for Bitget's 1 req/s/IP Reality endpoints. */
  groupRps?: Record<string, number>;
  clock?: Clock;
  sleep?: Sleep;
  random?: () => number;
  userAgent?: string;
}

export interface HttpResult {
  status: number;
  body: unknown;
  latencyMs: number;
  attempts: number;
  receivedAt: number;
}

const retryable = (status: number): boolean => status === 429 || status >= 500;

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly global: TokenBucket;
  private readonly groups = new Map<string, TokenBucket>();

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
    const rps = opts.rps ?? 10;
    this.global = new TokenBucket(rps, rps, this.clock);
    for (const [group, r] of Object.entries(opts.groupRps ?? {})) {
      this.groups.set(group, new TokenBucket(r, 1, this.clock));
    }
  }

  private async throttle(group?: string): Promise<void> {
    const waits = [this.global.reserve()];
    const bucket = group ? this.groups.get(group) : undefined;
    if (bucket) waits.push(bucket.reserve());
    const wait = Math.max(...waits);
    if (wait > 0) await this.sleep(wait);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const cap = this.opts.maxBackoffMs ?? 4000;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(cap, seconds * 1000);
    const base = this.opts.backoffMs ?? 250;
    return Math.floor(this.random() * Math.min(cap, base * 2 ** attempt));
  }

  async getJson(url: string, group?: string): Promise<HttpResult> {
    const retries = this.opts.retries ?? 2;
    const timeoutMs = this.opts.timeoutMs ?? 8000;
    let lastError = "";
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle(group);
      const started = this.clock();
      const t0 = performance.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": this.opts.userAgent ?? "slipway/0.1" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        lastError =
          err instanceof Error && err.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : String(err);
        lastStatus = null;
        if (attempt < retries) await this.sleep(this.backoff(attempt, null));
        continue;
      }
      const latencyMs = Math.round(performance.now() - t0);
      if (retryable(res.status)) {
        lastError = `HTTP ${res.status}`;
        lastStatus = res.status;
        if (attempt < retries) await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(`non-JSON response (HTTP ${res.status})`, url, res.status, attempt + 1);
      }
      const env = body as { code?: unknown; msg?: unknown };
      if (!res.ok || (typeof env.code === "string" && env.code !== "00000")) {
        throw new BitgetApiError(
          String(env.code ?? res.status),
          String(env.msg ?? res.statusText),
          url,
          res.status,
        );
      }
      return { status: res.status, body, latencyMs, attempts: attempt + 1, receivedAt: started + latencyMs };
    }
    throw new HttpError(`${lastError} after ${retries + 1} attempts`, url, lastStatus, retries + 1);
  }
}
