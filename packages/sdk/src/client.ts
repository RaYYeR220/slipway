// Typed client for the Slipway HTTP API. Works in browsers, Node and edge runtimes (fetch only).
import type {
  ApiError,
  ExplainResponse,
  KeysData,
  MarketResponse,
  OptionsRequest,
  OptionsResponse,
  PlanRequest,
  PlanResponse,
  ResearchResponse,
  TicketsRequest,
  TicketsResponse,
  TideResponse,
  TrackRecordResponse,
} from "./types.js";

export class SlipwayApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = "SlipwayApiError";
  }
  get code(): string {
    return this.body?.error.code ?? "ERROR";
  }
}

export interface SlipwayClientOptions {
  /** Origin the API is mounted on, e.g. "https://slipway.example" (default: same origin). */
  baseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
}

export class SlipwayClient {
  private readonly base: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly headers: Record<string, string>;

  constructor(opts: SlipwayClientOptions = {}) {
    this.base = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.headers = opts.headers ?? {};
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = { method, headers: { accept: "application/json", ...this.headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    if (signal) init.signal = signal;
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new SlipwayApiError(res.status, (json as ApiError | null) ?? null);
    return json as T;
  }

  /** Every priced strategy, the best per family, the TWAP baseline and a gate preview. */
  options(req: OptionsRequest, signal?: AbortSignal): Promise<OptionsResponse> {
    return this.call("POST", "/api/plan/options", req, signal);
  }

  /** Gate and sign one strategy; keep `data.signedPlan` to request tickets. */
  plan(req: PlanRequest, signal?: AbortSignal): Promise<PlanResponse> {
    return this.call("POST", "/api/plan", req, signal);
  }

  /** Dry-run tickets for an ALLOW plan; a refusal comes back as `data.ok === false` with the gate's fixes. */
  tickets(req: TicketsRequest, signal?: AbortSignal): Promise<TicketsResponse> {
    return this.call("POST", "/api/tickets", req, signal);
  }

  market(symbol: string, signal?: AbortSignal): Promise<MarketResponse> {
    return this.call("GET", `/api/market/${encodeURIComponent(symbol)}`, undefined, signal);
  }

  tide(symbol: string, signal?: AbortSignal): Promise<TideResponse> {
    return this.call("GET", `/api/tide/${encodeURIComponent(symbol)}`, undefined, signal);
  }

  trackRecord(symbol?: string, signal?: AbortSignal): Promise<TrackRecordResponse> {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return this.call("GET", `/api/track-record${q}`, undefined, signal);
  }

  research(symbol: string, signal?: AbortSignal): Promise<ResearchResponse> {
    return this.call("GET", `/api/research/${encodeURIComponent(symbol)}`, undefined, signal);
  }

  explain(topic: string, signal?: AbortSignal): Promise<ExplainResponse> {
    return this.call("GET", `/api/explain/${encodeURIComponent(topic)}`, undefined, signal);
  }

  /** The desk's plan-signing public key, to verify signed plans independently. */
  keys(signal?: AbortSignal): Promise<KeysData> {
    return this.call("GET", "/api/keys", undefined, signal);
  }
}
