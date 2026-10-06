import { describe, expect, it } from "vitest";
import { createApiHandlers } from "../../agent/src/http.js";
import { recordedDesk } from "../../agent/test/support/desk.js";
import { SlipwayApiError, SlipwayClient } from "../src/index.js";

const api = createApiHandlers(recordedDesk());
const client = new SlipwayClient({
  baseUrl: "https://slipway.test/",
  fetch: (url, init) => api.dispatch(new Request(url, init)),
});
const intent = {
  symbol: "NVDA",
  side: "buy" as const,
  notionalUsd: 40_000,
  venues: ["rtoken" as const],
  urgency: "patient" as const,
};

describe("SlipwayClient against the route handlers (in-process)", () => {
  it("runs the full options -> plan -> tickets flow with typed responses", async () => {
    const options = await client.options({ intent });
    expect(options.data.best?.kind).toBe("sliced");
    expect(options.data.gate?.verdict).toBe("allow");
    const plan = await client.plan({ intent, strategyId: options.data.best?.id ?? "best" });
    expect(plan.data.planId).toHaveLength(12);
    const tickets = await client.tickets({ signedPlan: plan.data.signedPlan });
    expect(tickets.data.ok && tickets.data.tickets.every((t) => t.bgc.endsWith("--dry-run"))).toBe(true);
  });

  it("reads market, tide, track record, research, explain and keys", async () => {
    expect((await client.market("NVDA")).data.venues.perp?.book?.levels.bids).toBe(100);
    expect((await client.tide("NVDA")).data.bySession[0]?.session).toBe("overnight");
    expect((await client.trackRecord("NVDA")).data.status).toBe("unavailable");
    expect((await client.research("NVDA")).data.technicals?.bars).toBe(24);
    expect((await client.explain("wait")).data.title).toBe("Wait");
    expect((await client.keys()).alg).toBe("Ed25519");
  });

  it("raises SlipwayApiError with the server's code and message", async () => {
    const err = await client.plan({ intent, strategyId: "no-such-strategy" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlipwayApiError);
    expect(err).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: expect.stringMatching(/not available on current data/),
    });
  });
});
