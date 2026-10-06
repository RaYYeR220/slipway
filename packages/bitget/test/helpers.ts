// Replays recorded real exchanges (test/fixtures, captured by scripts/record-fixtures.ts) as a fetch implementation.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableKey } from "../src/cache.js";
import type { FetchLike } from "../src/http.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface Exchange {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: string };
  latencyMs: number;
  recordedAt: number;
}

export const fixture = <T = Exchange>(rel: string): T =>
  JSON.parse(readFileSync(join(FIX, rel), "utf8")) as T;

/** Parsed body of a recorded REST exchange. */
export const restBody = (name: string): unknown => JSON.parse(fixture(`rest/${name}.json`).response.body);

export const restRecordedAt = (name: string): number => fixture(`rest/${name}.json`).recordedAt;

const VOLATILE = new Set([
  "startTime",
  "endTime",
  "start_time",
  "end_time",
  "start_date",
  "end_date",
  "from_date",
  "to_date",
]);

function urlKey(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE.has(k))
    .sort(([a], [b]) => a.localeCompare(b));
  return `${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

export const respond = (ex: Pick<Exchange, "response">, body = ex.response.body): Response =>
  new Response(ex.response.status === 202 || body === "" ? null : body, {
    status: ex.response.status,
    headers: ex.response.headers,
  });

export interface ReplayLog {
  calls: string[];
}

/** fetch over all recorded REST fixtures, matched on path + query (time params ignored). Unknown URLs throw. */
export function restReplay(
  overrides: Record<string, (url: string) => Response | Promise<Response>> = {},
): FetchLike & ReplayLog {
  const byKey = new Map<string, Exchange>();
  for (const f of readdirSync(join(FIX, "rest"))) {
    const ex = fixture(`rest/${f}`);
    byKey.set(urlKey(ex.request.url), ex);
  }
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    for (const [prefix, handler] of Object.entries(overrides))
      if (path.startsWith(prefix)) return handler(url);
    const ex = byKey.get(urlKey(url));
    if (!ex) throw new Error(`no recorded fixture for ${url}`);
    return respond(ex);
  }) as FetchLike & ReplayLog;
  fn.calls = calls;
  return fn;
}

interface RpcBody {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const rpcKey = (b: RpcBody): string => {
  if (b.method !== "tools/call") return b.method;
  const stable = (o: object) => Object.fromEntries(Object.entries(o).filter(([k]) => !VOLATILE.has(k)));
  const args = Object.fromEntries(
    Object.entries(stable(b.params?.arguments ?? {})).map(([k, v]) => [
      k,
      k === "params" && v && typeof v === "object" ? stable(v) : v,
    ]),
  );
  return `tools/call ${b.params?.name} ${stableKey(args)}`;
};

/** Rewrites the JSON-RPC id inside a recorded (SSE or JSON) body to the id of the live request. */
export function withId(body: string, id: number): string {
  return body.replace(/("jsonrpc":"2\.0","id":)\d+/g, `$1${id}`);
}

/** fetch over a recorded MCP session (tools/call matched on tool name + arguments, time params ignored). */
export function mcpReplay(
  sessionFile: string,
  overrides: Record<string, (body: RpcBody) => Response | Promise<Response>> = {},
): FetchLike & ReplayLog & { sessionId: string } {
  const log = fixture<Exchange[]>(sessionFile);
  const byKey = new Map<string, Exchange>();
  for (const ex of log) byKey.set(rpcKey(ex.request.body as RpcBody), ex);
  const sessionId = log[0]?.response.headers["mcp-session-id"] ?? "";
  const calls: string[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body)) as RpcBody;
    const key = rpcKey(body);
    calls.push(key);
    for (const [prefix, handler] of Object.entries(overrides))
      if (key.startsWith(prefix)) return handler(body);
    const ex = byKey.get(key);
    if (!ex) throw new Error(`no recorded MCP exchange for ${key}`);
    return respond(ex, body.id === undefined ? ex.response.body : withId(ex.response.body, body.id));
  }) as FetchLike & ReplayLog & { sessionId: string };
  fn.calls = calls;
  fn.sessionId = sessionId;
  return fn;
}

/** The decoded tool result payload of one recorded tools/call (first match on tool + predicate). */
export function recordedToolText(
  sessionFile: string,
  tool: string,
  pred: (args: Record<string, unknown>) => boolean = () => true,
): string {
  const ex = fixture<Exchange[]>(sessionFile).find((e) => {
    const b = e.request.body as RpcBody;
    return b.method === "tools/call" && b.params?.name === tool && pred(b.params?.arguments ?? {});
  });
  if (!ex) throw new Error(`no recorded ${tool} call`);
  const line = ex.response.body.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const msg = JSON.parse((line as string).slice(5)) as { result: { content: { text: string }[] } };
  return (msg.result.content[0] as { text: string }).text;
}

export const fakeSleep = (log: number[] = []) => {
  const sleep = async (ms: number) => {
    log.push(ms);
  };
  return Object.assign(sleep, { log });
};
