import { createSlipwayMcpHandler } from "@slipway/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcp = createSlipwayMcpHandler({ onerror: (e) => console.error("mcp", e) });

export const GET = (req: Request) => mcp.fetch(req);
export const POST = (req: Request) => mcp.fetch(req);
export const DELETE = (req: Request) => mcp.fetch(req);
