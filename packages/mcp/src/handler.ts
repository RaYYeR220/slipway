// Streamable HTTP endpoint (spec 2026-07-28, stateless 2025-era fallback) as a web-standard handler.
// Next.js: `const mcp = createSlipwayMcpHandler(); export const POST = (req: Request) => mcp.fetch(req);` (GET too).
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Desk } from "@slipway/agent";
import { createSlipwayMcpServer } from "./server.js";

export function createSlipwayMcpHandler(
  opts: { desk?: Desk; onerror?: (e: Error) => void } = {},
): McpHttpHandler {
  const desk = opts.desk ?? new Desk();
  return createMcpHandler(() => createSlipwayMcpServer(desk), {
    legacy: "stateless",
    ...(opts.onerror ? { onerror: opts.onerror } : {}),
  });
}
