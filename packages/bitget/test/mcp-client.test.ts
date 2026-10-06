import { describe, expect, it } from "vitest";
import { McpError, McpHttpClient, parseSseText, SseDecoder } from "../src/mcp-client.js";
import { type Exchange, fixture, mcpReplay, withId } from "./helpers.js";

const BITGET = "mcp/bitget-mcp.session.json";
const SIGNAL = "mcp/signal-mcp.session.json";

describe("SSE decoding", () => {
  it("handles comment keep-alives (the signal server's `: ping` lines), CRLF and multi-line data", () => {
    const slow = fixture<Exchange[]>(SIGNAL).find((e) => e.response.body.startsWith(": ping")) as Exchange;
    const events = parseSseText(slow.response.body);
    expect(events).toHaveLength(1);
    expect(JSON.parse((events[0] as { data: string }).data)).toMatchObject({ jsonrpc: "2.0" });
    expect(parseSseText("event: message\r\ndata: a\r\ndata: b\r\nid: 7\r\n\r\n")).toEqual([
      { event: "message", data: "a\nb", id: "7" },
    ]);
  });

  it("reassembles events split across arbitrary chunk boundaries", () => {
    const body = (fixture<Exchange[]>(BITGET)[0] as Exchange).response.body;
    const d = new SseDecoder();
    const out = [];
    for (let i = 0; i < body.length; i += 7) out.push(...d.push(body.slice(i, i + 7)));
    out.push(...d.end());
    expect(out).toHaveLength(1);
    expect(JSON.parse((out[0] as { data: string }).data).result.serverInfo).toEqual({
      name: "bitget-mcp-server",
      version: "4.0.5",
    });
  });
});

describe("McpHttpClient over a recorded bitget-mcp session", () => {
  it("initializes, carries the session id, lists tools and calls guide", async () => {
    const seen: Record<string, string>[] = [];
    const replay = mcpReplay(BITGET);
    const client = new McpHttpClient({
      url: "https://agent.bitget.com/mcp",
      fetch: async (url, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return replay(url, init);
      },
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["guide", "do_query"]);
    expect(client.serverInfo).toEqual({ name: "bitget-mcp-server", version: "4.0.5" });
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(replay.calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(seen[0]?.["mcp-session-id"]).toBeUndefined();
    expect(seen[1]).toMatchObject({
      "mcp-session-id": replay.sessionId,
      "mcp-protocol-version": "2025-06-18",
    });
    const guide = await client.callTool("guide", {});
    expect(guide.structuredContent).toMatchObject({
      categories: expect.arrayContaining([expect.objectContaining({ key: "equity", entry_count: 22 })]),
    });
  });

  it("re-initializes once when the server has expired the session (HTTP 404)", async () => {
    const replay = mcpReplay(BITGET);
    let expired = false;
    const client = new McpHttpClient({
      url: "u",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "tools/list" && !expired) {
          expired = true;
          return new Response("session not found", { status: 404 });
        }
        return replay(url, init);
      },
    });
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(replay.calls).toEqual([
      "initialize",
      "notifications/initialized",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("accepts plain JSON responses and surfaces JSON-RPC errors", async () => {
    const init = fixture<Exchange[]>(BITGET)[0] as Exchange;
    const client = new McpHttpClient({
      url: "u",
      fetch: async (_url, init2) => {
        const body = JSON.parse(String(init2?.body));
        if (body.method === "initialize") {
          const data = init.response.body
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5) as string;
          return new Response(withId(data.trim(), body.id), {
            headers: { "content-type": "application/json", "mcp-session-id": "s1" },
          });
        }
        if (body.id === undefined) return new Response(null, { status: 202 });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Unknown tool: nope" },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const err = await client.callTool("nope", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ kind: "rpc", code: -32602 });
  });

  it("times out a hung tool call with a typed error", async () => {
    const replay = mcpReplay(SIGNAL);
    const client = new McpHttpClient({
      url: "u",
      fetch: (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method !== "tools/call") return replay(url, init);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      },
    });
    const err = await client.callTool("macro_indicators", { action: "fomc_news" }, 50).catch((e) => e);
    expect(err).toMatchObject({ kind: "timeout" });
  });

  it("maps HTTP failures to typed errors", async () => {
    const client = new McpHttpClient({
      url: "u",
      fetch: async () => new Response("<html>502</html>", { status: 502 }),
    });
    await expect(client.connect()).rejects.toMatchObject({ kind: "http", status: 502 });
  });
});

describe("handshake ordering", () => {
  it("lets concurrent callers share one handshake and sends nothing before notifications/initialized", async () => {
    const replay = mcpReplay(BITGET);
    const order: string[] = [];
    const client = new McpHttpClient({
      url: "u",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        order.push(body.method);
        if (body.method === "notifications/initialized") await new Promise((r) => setTimeout(r, 20));
        return replay(url, init);
      },
    });
    await Promise.all([client.listTools(), client.callTool("guide", {}), client.listTools()]);
    expect(order.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
    expect(order.filter((m) => m === "initialize")).toHaveLength(1);
  });

  it("retries the whole handshake after a failed initialized notification", async () => {
    const replay = mcpReplay(BITGET);
    let failOnce = true;
    const client = new McpHttpClient({
      url: "u",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized" && failOnce) {
          failOnce = false;
          return new Response("nope", { status: 500 });
        }
        return replay(url, init);
      },
    });
    await expect(client.listTools()).rejects.toMatchObject({ kind: "http", status: 500 });
    expect(client.protocolVersion).toBeNull();
    expect(await client.listTools()).toHaveLength(2);
  });
});
