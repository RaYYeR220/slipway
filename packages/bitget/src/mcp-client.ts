// Minimal MCP client for the streamable-HTTP transport, protocol 2025-06-18 (what both Bitget servers speak):
// initialize -> Mcp-Session-Id -> notifications/initialized, JSON or SSE-framed responses, transparent
// re-initialization when the server forgets the session (HTTP 404), per-request timeouts.
import type { FetchLike } from "./http.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContent {
  type: string;
  text?: string;
}

export interface McpCallResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpErrorKind = "http" | "rpc" | "timeout" | "network" | "protocol";

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: McpErrorKind,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental SSE decoder (WHATWG event-stream rules: comments, multi-line data, CRLF). */
export class SseDecoder {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl = this.buf.search(/\r\n|\r|\n/);
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sep);
      this.line(line, out);
      nl = this.buf.search(/\r\n|\r|\n/);
    }
    return out;
  }

  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        out.push({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...(this.id ? { id: this.id } : {}),
        });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
}

export function parseSseText(text: string): SseEvent[] {
  const d = new SseDecoder();
  return [...d.push(text), ...d.end()];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpClientOptions {
  url: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private connecting: Promise<void> | null = null;
  private ready = false;
  serverInfo: { name: string; version: string } | null = null;
  protocolVersion: string | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  get url(): string {
    return this.opts.url;
  }

  private get fetchImpl(): FetchLike {
    return this.opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Initializes once; concurrent callers share the handshake, and nobody proceeds before `initialized` is sent. */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.ready) return;
    this.connecting = this.initialize().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async initialize(): Promise<void> {
    this.ready = false;
    this.sessionId = null;
    this.protocolVersion = null;
    try {
      const result = (await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.opts.clientInfo ?? { name: "slipway", version: "0.1.0" },
      })) as { protocolVersion?: string; serverInfo?: { name: string; version: string } };
      this.protocolVersion = result.protocolVersion ?? MCP_PROTOCOL_VERSION;
      this.serverInfo = result.serverInfo ?? null;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
      this.ready = true;
    } catch (err) {
      this.sessionId = null;
      this.protocolVersion = null;
      throw err;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.call("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
    const r = (await this.call("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult;
    if (!r || !Array.isArray(r.content))
      throw new McpError(`tools/call ${name}: malformed result`, "protocol");
    return r;
  }

  /** Sends a request on the current session, re-initializing once if the server has expired it. */
  private async call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    await this.connect();
    try {
      return await this.request(method, params, timeoutMs);
    } catch (err) {
      if (err instanceof McpError && err.kind === "http" && err.status === 404 && this.sessionId) {
        this.ready = false;
        await this.connect();
        return this.request(method, params, timeoutMs);
      }
      throw err;
    }
  }

  private async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: "2.0", id, method, params }, id, timeoutMs);
    if (!msg) throw new McpError(`${method}: no response`, "protocol");
    if (msg.error) throw new McpError(`${method}: ${msg.error.message}`, "rpc", undefined, msg.error.code);
    return msg.result;
  }

  private async post(
    body: object,
    id: number | null,
    timeoutMs = this.opts.timeoutMs ?? 20_000,
  ): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw abortAware(err, timeoutMs);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new McpError(`HTTP ${res.status}: ${text.slice(0, 120)}`, "http", res.status);
    }
    if (id === null) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ctype = res.headers.get("content-type") ?? "";
    try {
      if (ctype.includes("text/event-stream")) return await readSseResponse(res, id);
      const text = await res.text();
      if (!text.trim()) return null;
      const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
      return (Array.isArray(parsed) ? parsed.find((m) => m.id === id) : parsed) ?? null;
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw abortAware(err, timeoutMs);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.protocolVersion = null;
    this.ready = false;
    try {
      const res = await this.fetchImpl(this.opts.url, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel().catch(() => {});
    } catch {}
  }
}

function abortAware(err: unknown, timeoutMs: number): McpError {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new McpError(`timeout after ${timeoutMs} ms`, "timeout");
  }
  return new McpError(err instanceof Error ? err.message : String(err), "network");
}

/** Reads SSE events until the JSON-RPC response with `id` arrives, then releases the stream. */
async function readSseResponse(res: Response, id: number): Promise<JsonRpcResponse | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  const match = (events: SseEvent[]): JsonRpcResponse | null => {
    for (const ev of events) {
      if (ev.event !== "message" || !ev.data) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(ev.data) as JsonRpcResponse;
      } catch {
        throw new McpError(`unparseable SSE data: ${ev.data.slice(0, 80)}`, "protocol");
      }
      if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
    }
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const found = done ? match(sse.end()) : match(sse.push(decoder.decode(value, { stream: true })));
      if (found) return found;
      if (done) return null;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
