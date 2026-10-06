#!/usr/bin/env node
// stdio entry for desktop MCP clients: { "command": "npx", "args": ["-y", "@slipway/mcp"] }.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Desk } from "@slipway/agent";
import { createSlipwayMcpServer } from "./server.js";

const desk = new Desk();
const handle = serveStdio(() => createSlipwayMcpServer(desk), {
  onerror: (e) => process.stderr.write(`slipway-mcp: ${e.message}\n`),
});
const stop = () => void handle.close().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
