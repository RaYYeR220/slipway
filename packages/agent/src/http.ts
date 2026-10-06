// Framework-agnostic route handlers (web Request -> Response) for the Slipway HTTP API. A Next.js app mounts each
// one 1:1 (e.g. app/api/market/[symbol]/route.ts: `GET = (req, { params }) => api.market(req, params.symbol)`);
// `dispatch` serves every route from one catch-all.
import type { ApiError, KeysData } from "@slipway/sdk";
import type { UIMessage } from "ai";
import { z } from "zod";
import { DEFAULT_PROFILE, OptionsRequestSchema, PlanRequestSchema, ProfileSchema } from "./desk/schemas.js";
import { Desk, DeskError } from "./desk/service.js";
import { type AgentOptions, runTurn } from "./llm/agent.js";

const MAX_BODY = 512 * 1024;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const STATUS: Record<ApiError["error"]["code"], number> = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  NO_MARKET: 503,
  UNAVAILABLE: 503,
  ERROR: 500,
};

function fail(e: unknown): Response {
  if (e instanceof DeskError)
    return json(
      { error: { code: e.code, message: e.message }, sources: e.sources } satisfies ApiError,
      STATUS[e.code],
    );
  if (e instanceof z.ZodError) {
    const message = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return json({ error: { code: "BAD_INPUT", message }, sources: [] } satisfies ApiError, 400);
  }
  // Unexpected errors can carry upstream URLs or internals: log them, answer generically.
  console.error("slipway api error", e);
  return json({ error: { code: "ERROR", message: "internal error" }, sources: [] } satisfies ApiError, 500);
}

// Reads at most MAX_BODY bytes, whatever Content-Length claims, so an unbounded stream cannot exhaust memory.
async function body(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) throw new DeskError(`body larger than ${MAX_BODY} bytes`, "BAD_INPUT");
  const reader = req.body?.getReader();
  if (!reader) throw new DeskError("body is not JSON", "BAD_INPUT");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new DeskError(`body larger than ${MAX_BODY} bytes`, "BAD_INPUT");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DeskError("body is not JSON", "BAD_INPUT");
  }
}

// The public demo needs no credentials, so the model route is bounded instead: a per-client token bucket
// (best effort per server instance), a cap on conversation length, and a cap on characters sent upstream.
const CHAT_LIMIT = { burst: 6, perMinute: 6, maxMessages: 24, maxChars: 24_000 };
const buckets = new Map<string, { tokens: number; at: number }>();

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "anon";
}

function takeToken(key: string, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: CHAT_LIMIT.burst, at: now };
  b.tokens = Math.min(CHAT_LIMIT.burst, b.tokens + ((now - b.at) / 60_000) * CHAT_LIMIT.perMinute);
  b.at = now;
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const TicketsRequestSchema = z.object({
  signedPlan: z.looseObject({
    plan: z.looseObject({
      intent: z.looseObject({ symbol: z.string() }),
      strategy: z.looseObject({ slices: z.array(z.unknown()) }),
    }),
    gate: z.looseObject({ verdict: z.string(), checks: z.array(z.unknown()) }),
    hash: z.string(),
    sig: z.string(),
    pubkey: z.string(),
    issuedAt: z.number(),
  }),
});

const ChatRequestSchema = z.object({
  messages: z.array(z.looseObject({ role: z.string() })),
  profile: ProfileSchema.optional(),
});

export interface ApiHandlers {
  options(req: Request): Promise<Response>;
  plan(req: Request): Promise<Response>;
  tickets(req: Request): Promise<Response>;
  market(req: Request, symbol: string): Promise<Response>;
  tide(req: Request, symbol: string): Promise<Response>;
  trackRecord(req: Request): Promise<Response>;
  research(req: Request, symbol: string): Promise<Response>;
  explain(req: Request, topic: string): Promise<Response>;
  keys(req: Request): Promise<Response>;
  chat(req: Request): Promise<Response>;
  /** Routes any of the above by method + path (`/api/...`); 404 otherwise. */
  dispatch(req: Request): Promise<Response>;
}

export function createApiHandlers(desk: Desk = new Desk(), agent: AgentOptions = {}): ApiHandlers {
  const guard = (f: () => Promise<Response>) => f().catch(fail);
  const h: Omit<ApiHandlers, "dispatch"> = {
    options: (req) =>
      guard(async () => {
        const b = OptionsRequestSchema.parse(await body(req));
        return json(await desk.priceOptions(b.intent, b.profile ?? DEFAULT_PROFILE));
      }),
    plan: (req) =>
      guard(async () => {
        const b = PlanRequestSchema.parse(await body(req));
        return json(await desk.buildPlan(b.intent, b.profile ?? DEFAULT_PROFILE, b.strategyId));
      }),
    tickets: (req) =>
      guard(async () => {
        const raw = await body(req);
        TicketsRequestSchema.parse(raw);
        // The original object is passed on: re-serialising through a schema could alter what the hash covers.
        return json(await desk.issueTickets((raw as { signedPlan: never }).signedPlan));
      }),
    market: (_req, symbol) => guard(async () => json(await desk.marketState(symbol))),
    tide: (_req, symbol) => guard(async () => json(await desk.liquidityTide(symbol))),
    trackRecord: (req) =>
      guard(async () =>
        json(await desk.trackRecord(new URL(req.url).searchParams.get("symbol") ?? undefined)),
      ),
    research: (_req, symbol) => guard(async () => json(await desk.research(symbol))),
    explain: (_req, topic) => guard(async () => json(desk.explain(topic))),
    keys: () =>
      guard(async () => json({ ...(await desk.publicKey()), domain: "slipway-plan-v1" } satisfies KeysData)),
    chat: (req) =>
      guard(async () => {
        if (!takeToken(clientKey(req), Date.now()))
          return json(
            { error: { code: "BAD_INPUT", message: "too many requests, wait a minute" }, sources: [] },
            429,
          );
        const b = ChatRequestSchema.parse(await body(req));
        if (b.messages.length > CHAT_LIMIT.maxMessages || JSON.stringify(b.messages).length > CHAT_LIMIT.maxChars)
          throw new DeskError("conversation too long, start a new one", "BAD_INPUT");
        return runTurn(
          { messages: b.messages as unknown as UIMessage[], profile: b.profile ?? DEFAULT_PROFILE },
          { desk, ...agent },
        );
      }),
  };
  const routes: [string, RegExp, (req: Request, m: RegExpExecArray) => Promise<Response>][] = [
    ["POST", /^\/api\/plan\/options\/?$/, (r) => h.options(r)],
    ["POST", /^\/api\/plan\/?$/, (r) => h.plan(r)],
    ["POST", /^\/api\/tickets\/?$/, (r) => h.tickets(r)],
    ["GET", /^\/api\/market\/([^/]+)\/?$/, (r, m) => h.market(r, decodeURIComponent(m[1] as string))],
    ["GET", /^\/api\/tide\/([^/]+)\/?$/, (r, m) => h.tide(r, decodeURIComponent(m[1] as string))],
    ["GET", /^\/api\/track-record\/?$/, (r) => h.trackRecord(r)],
    ["GET", /^\/api\/research\/([^/]+)\/?$/, (r, m) => h.research(r, decodeURIComponent(m[1] as string))],
    ["GET", /^\/api\/explain\/([^/]+)\/?$/, (r, m) => h.explain(r, decodeURIComponent(m[1] as string))],
    ["GET", /^\/api\/keys\/?$/, (r) => h.keys(r)],
    ["POST", /^\/api\/chat\/?$/, (r) => h.chat(r)],
  ];
  return {
    ...h,
    dispatch: async (req) => {
      const path = new URL(req.url).pathname;
      for (const [method, re, f] of routes) {
        const m = re.exec(path);
        if (!m) continue;
        if (req.method !== method)
          return json({ error: { code: "BAD_INPUT", message: `use ${method}` }, sources: [] }, 405);
        return f(req, m);
      }
      return json({ error: { code: "NOT_FOUND", message: `no route ${path}` }, sources: [] }, 404);
    },
  };
}
