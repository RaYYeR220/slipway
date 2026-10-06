import { describe, expect, it } from "vitest";
import { createApiHandlers } from "../src/http.js";
import { recordedDesk, testKeys } from "./support/desk.js";

const ORDER = { symbol: "NVDA", side: "buy", notionalUsd: 40_000, venues: ["rtoken"], urgency: "patient" };
const post = (path: string, body: unknown) =>
  new Request(`http://slipway.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://slipway.test${path}`);

describe("HTTP route handlers (web Request -> Response)", () => {
  const api = createApiHandlers(recordedDesk());

  it("serves options -> plan -> tickets with the signed plan round-tripping through JSON", async () => {
    const opt = await api.dispatch(post("/api/plan/options", { intent: ORDER }));
    expect(opt.status).toBe(200);
    const o = await opt.json();
    expect(o.data.best.id).toBe("sliced:rtoken:n4:t60");
    expect(o.slots["best.expectedBps"].unit).toBe("bps");

    const plan = await (
      await api.dispatch(post("/api/plan", { intent: ORDER, strategyId: o.data.best.id }))
    ).json();
    expect(plan.data.verdict).toBe("allow");
    const tickets = await (
      await api.dispatch(post("/api/tickets", { signedPlan: plan.data.signedPlan }))
    ).json();
    expect(tickets.data.ok).toBe(true);
    expect(tickets.data.tickets).toHaveLength(4);

    const forged = { ...plan.data.signedPlan, issuedAt: plan.data.signedPlan.issuedAt + 1 };
    const refused = await (await api.dispatch(post("/api/tickets", { signedPlan: forged }))).json();
    expect(refused.data).toMatchObject({ ok: false, reason: "not ticketable: invalid signature" });
  });

  it("serves market, tide, research, explain, track record and the public key", async () => {
    expect((await (await api.market(get("/api/market/NVDA"), "NVDA")).json()).data.symbol).toBe("NVDA");
    expect((await (await api.dispatch(get("/api/tide/nvda"))).json()).data.timeline.length).toBeGreaterThan(
      5,
    );
    expect((await (await api.dispatch(get("/api/research/NVDA"))).json()).data.flags).toHaveLength(2);
    expect((await (await api.dispatch(get("/api/explain/COST_CAP"))).json()).data.found).toBe(true);
    expect((await (await api.dispatch(get("/api/track-record?symbol=NVDA"))).json()).data.status).toBe(
      "unavailable",
    );
    const keys = await (await api.dispatch(get("/api/keys"))).json();
    expect(keys).toEqual({
      publicKey: (await testKeys()).publicKey,
      alg: "Ed25519",
      origin: "ephemeral",
      domain: "slipway-plan-v1",
    });
  });

  it("maps bad input, unknown routes and wrong methods to typed errors", async () => {
    const bad = await api.dispatch(post("/api/plan/options", { intent: { ...ORDER, side: "hold" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("BAD_INPUT");
    const deadline = await api.dispatch(
      post("/api/plan/options", { intent: { ...ORDER, deadline: "soonish" } }),
    );
    expect(deadline.status).toBe(400);
    const unknown = await api.dispatch(post("/api/plan", { intent: ORDER, strategyId: "nope" }));
    expect(unknown.status).toBe(404);
    expect(
      (await api.dispatch(new Request("http://slipway.test/api/plan", { method: "POST", body: "{" }))).status,
    ).toBe(400);
    expect((await api.dispatch(get("/api/plan"))).status).toBe(405);
    expect((await api.dispatch(get("/api/nothing"))).status).toBe(404);
    expect((await api.dispatch(post("/api/tickets", { signedPlan: { hash: "x" } }))).status).toBe(400);
  });

  it("caps request bodies by bytes read, not by the declared length", async () => {
    const big = "x".repeat(600 * 1024);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"intent":"${big}"}`));
        c.close();
      },
    });
    const req = new Request("http://slipway.test/api/plan/options", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await api.dispatch(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/larger than/);
  });

  it("rate-limits the model route per client and bounds conversation length", async () => {
    const chatApi = createApiHandlers(recordedDesk());
    const chat = (ip: string, messages: unknown[]) =>
      chatApi.dispatch(
        new Request("http://slipway.test/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ messages }),
        }),
      );
    const tooLong = Array.from({ length: 30 }, () => ({ role: "user", parts: [] }));
    expect((await chat("10.0.0.1", tooLong)).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await chat("10.0.0.2", tooLong)).status);
    const spoofed: number[] = [];
    for (let i = 0; i < 8; i++) spoofed.push((await chat(`1.1.1.${i}, 10.0.0.3`, tooLong)).status);
    expect(spoofed.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
