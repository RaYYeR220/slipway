import { createApiHandlers } from "@slipway/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const api = createApiHandlers();

export const GET = (req: Request) => api.dispatch(req);
export const POST = (req: Request) => api.dispatch(req);
