import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifySignedPlan } from "@slipway/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../src/desk/schemas.js";
import { DeskError, planIdOf } from "../src/desk/service.js";
import { NOW, recordedDesk, testKeys } from "./support/desk.js";

const ORDER = { symbol: "NVDA", side: "buy" as const, notionalUsd: 40_000 };
const PATIENT_SPOT = {
  ...ORDER,
  deadline: "before thursday",
  venues: ["rtoken" as const],
  urgency: "patient" as const,
};

describe("marketState on recorded Bitget data (NVDA, Tue 01:02 NY overnight)", () => {
  it("reports both books, fees, funding, sessions and integrity flags with sourced slots", async () => {
    const r = await recordedDesk().marketState("rnvdausdt");
    const d = r.data;
    expect(d.symbol).toBe("NVDA");
    expect(d.session.session).toBe("overnight");
    expect(d.venues.rtoken?.book?.mid).toBeCloseTo(239.46, 2);
    expect(d.venues.rtoken?.book?.spreadBps).toBeCloseTo(0.835, 2);
    expect(d.venues.rtoken?.fees).toEqual({ maker: 0.001, taker: 0.001 });
    expect(d.venues.perp?.fees).toEqual({ maker: 0.0002, taker: 0.0006 });
    expect(d.funding?.intervalHours).toBe(8);
    expect(d.nextSessions.map((s) => s.session).slice(0, 4)).toEqual([
      "overnight",
      "pre_market",
      "regular",
      "after_hours",
    ]);
    expect(d.integrity.map((f) => f.code)).toContain("RTOKEN_TAPE_SILENT");
    expect(d.atlas).toMatchObject({ status: "cached", keys: 4 });
    expect(r.slots["rtoken.mid"]).toMatchObject({ unit: "price", source: "bitget.spot.orderbook" });
    expect(r.slots["perp.takerFee"]).toMatchObject({ unit: "bps", source: "bitget.mix.contract" });
    expect(r.slots["perp.takerFee"]?.value).toBeCloseTo(6, 9);
    expect(r.slots["rtoken.depth.b25.ask"]?.value).toBe(d.venues.rtoken?.book?.depthUsd.b25.ask);
    expect(r.sources.find((s) => s.id === "slipway.atlas")?.status).toBe("cached");
  });

  it("rejects non-tickers before touching the network", async () => {
    await expect(recordedDesk().marketState("NVDA; drop")).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("priceOptions", () => {
  it("prices every family, the TWAP baseline and a gate preview for a patient spot-only order", async () => {
    const r = await recordedDesk().priceOptions(PATIENT_SPOT, DEFAULT_PROFILE);
    const d = r.data;
    expect(d.intent).toMatchObject({
      symbol: "NVDA",
      urgency: "patient",
      venues: ["rtoken"],
      deadlineNy: "Thu 2026-10-08 00:00 NY",
    });
    expect(d.lambda).toBe(0.25);
    expect(d.best?.id).toBe("sliced:rtoken:n4:t60");
    expect(d.baseline?.id).toBe("twap60:rtoken:n8");
    expect(Object.keys(d.families).sort()).toEqual(["immediate", "passive", "sliced", "wait"]);
    expect(d.families.immediate?.expectedBps).toBeCloseTo(17.1, 1);
    for (const q of Object.values(d.families)) expect(q?.venues).toEqual(["rtoken"]);
    expect(d.gate).toMatchObject({ strategyId: d.best?.id, verdict: "allow" });
    expect(d.savingVsBaseline?.bps).toBeCloseTo(
      (d.baseline?.expectedBps ?? 0) - (d.best?.expectedBps ?? 0),
      9,
    );
    expect(d.frontier.length).toBe(d.candidates);
    expect(r.slots["best.expectedBps"]?.value).toBe(d.best?.expectedBps);
    expect(r.slots["order.deadline"]).toMatchObject({ value: "Thu 2026-10-08 00:00 NY", source: "user" });
    expect(r.slots["gate.verdict"]?.value).toBe("ALLOW");
  });

  it("without the atlas, prices only what needs no atlas and says so (no fabricated statistics)", async () => {
    const r = await recordedDesk({ atlas: null }).priceOptions(ORDER, DEFAULT_PROFILE);
    expect(r.data.atlas).toMatchObject({ status: "unavailable", keys: 0 });
    expect(r.data.frontier.every((c) => c.kind === "immediate")).toBe(true);
    expect(r.data.skipped.reasons[0]).toEqual({
      reason: "no volatility estimate for NVDA",
      count: expect.any(Number),
    });
    expect(r.slots.atlas?.value).toBe("unavailable");
  });

  it("applies per-order urgency and venue restrictions without changing the stored profile", async () => {
    const profile = { ...DEFAULT_PROFILE };
    const r = await recordedDesk().priceOptions({ ...ORDER, urgency: "urgent", venues: ["perp"] }, profile);
    expect(r.data.lambda).toBe(3);
    expect(r.data.best?.venues).toEqual(["perp"]);
    expect(profile.urgency).toBe("normal");
  });

  it("refuses unreadable orders with a reason the model can act on", async () => {
    const desk = recordedDesk();
    await expect(desk.priceOptions({ ...ORDER, qty: 10 })).rejects.toThrow(
      /exactly one of notionalUsd or qty/,
    );
    await expect(desk.priceOptions({ ...ORDER, deadline: "whenever" })).rejects.toThrow(
      /cannot read deadline/,
    );
    await expect(desk.priceOptions({ ...ORDER, deadline: "2026-10-01" })).rejects.toBeInstanceOf(DeskError);
  });
});

describe("buildPlan and issueTickets", () => {
  it("signs the chosen strategy with the desk key and issues SDK dry-run tickets for an ALLOW plan", async () => {
    const desk = recordedDesk();
    const plan = await desk.buildPlan(PATIENT_SPOT, DEFAULT_PROFILE, "best");
    const { signedPlan, planId, verdict } = plan.data;
    expect(verdict).toBe("allow");
    expect(planId).toBe(planIdOf(signedPlan));
    expect(plan.data.publicKey).toBe((await testKeys()).publicKey);
    expect(await verifySignedPlan(signedPlan, plan.data.publicKey)).toEqual({ ok: true });
    expect(plan.data.expiresAt).toBe(signedPlan.issuedAt + 60_000);
    expect(plan.data.slices).toHaveLength(4);
    expect(plan.data.alternatives.map((q) => q.id)).toContain("twap60:rtoken:n8");
    expect(plan.slots["plan.planId"]?.value).toBe(planId);
    expect(plan.slots["plan.id"]?.value).toBe(plan.data.strategy.id);

    const t = await desk.issueTickets(signedPlan);
    expect(t.data.ok).toBe(true);
    if (!t.data.ok) return;
    expect(t.data.tickets).toHaveLength(4);
    for (const k of t.data.tickets) {
      expect(k.request.path).toBe("/api/v3/trade/place-order");
      expect(k.request.body).toMatchObject({
        category: "SPOT",
        symbol: "RNVDAUSDT",
        side: "buy",
        orderType: "limit",
        timeInForce: "ioc",
      });
      expect(k.bgc).toMatch(/^bgc --read-only order --action place .* --dry-run$/);
      expect(k.clientOid.startsWith(`sw${signedPlan.hash.slice(0, 10)}`)).toBe(true);
      expect(k.violations).toEqual([]);
    }
    expect(t.slots["tickets.count"]?.value).toBe(4);
  });

  it("resolves best, baseline and best:<family>, and refuses unknown or deadline-breaking strategies", async () => {
    const desk = recordedDesk();
    expect((await desk.buildPlan(PATIENT_SPOT, DEFAULT_PROFILE, "baseline")).data.strategy.id).toBe(
      "twap60:rtoken:n8",
    );
    expect((await desk.buildPlan(PATIENT_SPOT, DEFAULT_PROFILE, "best:passive")).data.strategy.kind).toBe(
      "passive",
    );
    await expect(desk.buildPlan(PATIENT_SPOT, DEFAULT_PROFILE, "sliced:rtoken:n5:t7")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const tight = { ...ORDER, venues: ["rtoken" as const], deadline: "in 2m" };
    await expect(desk.buildPlan(tight, DEFAULT_PROFILE, "twap60:rtoken:n8")).rejects.toThrow(
      /after the deadline/,
    );
  });

  it("refuses tickets for a REFUSE verdict and returns the gate's fix (the refusal is the feature)", async () => {
    const desk = recordedDesk();
    const plan = await desk.buildPlan(ORDER, { ...DEFAULT_PROFILE, costCapBps: 5 }, "best");
    expect(plan.data.verdict).toBe("refuse");
    const cap = plan.data.checks.find((c) => c.code === "COST_CAP");
    expect(cap).toMatchObject({ status: "refuse", detail: expect.stringMatching(/> cap 5\.0 bps/) });
    expect(plan.slots["gate.COST_CAP.fix"]?.value).toBe(cap?.fix);
    const t = await desk.issueTickets(plan.data.signedPlan);
    expect(t.data).toMatchObject({
      ok: false,
      verdict: "refuse",
      reason: "not ticketable: gate verdict is refuse",
    });
    expect(!t.data.ok && t.data.fixes.map((c) => c.code)).toEqual(["COST_CAP"]);
    expect(t.slots["refusal0.fix"]?.value).toBe(cap?.fix);
  });

  it("refuses tampered, foreign-key and expired plans", async () => {
    const plan = (await recordedDesk().buildPlan(ORDER, DEFAULT_PROFILE, "best")).data.signedPlan;
    const desk = recordedDesk();
    const bigger = structuredClone(plan);
    (bigger.plan.strategy.slices[0] as { qty: number }).qty *= 10;
    expect((await desk.issueTickets(bigger)).data).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/hash mismatch/),
    });
    const refused = (await desk.buildPlan(ORDER, { ...DEFAULT_PROFILE, costCapBps: 5 }, "best")).data
      .signedPlan;
    const flipped = structuredClone(refused);
    flipped.gate.verdict = "allow";
    flipped.gate.checks = flipped.gate.checks.map((c) => ({ ...c, status: "pass" as const }));
    expect((await desk.issueTickets(flipped)).data).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/hash mismatch/),
    });
    const foreign = { ...plan, pubkey: "AAAA" };
    expect((await desk.issueTickets(foreign)).data).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/other than the trusted key/),
    });
    const late = recordedDesk({ clockOffsetMs: 1_000 + 61_000 });
    expect((await late.issueTickets(plan)).data).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ms old/),
    });
  });
});

describe("liquidityTide, research, trackRecord, explain", () => {
  it("lays out upcoming sessions per venue with atlas stats and the live book now", async () => {
    const r = await recordedDesk().liquidityTide("NVDA");
    const d = r.data;
    expect(d.live.session).toBe("overnight");
    expect(d.live.venues.rtoken?.depth25Usd).toBeGreaterThan(0);
    expect(d.timeline[0]?.session).toBe("overnight");
    expect(d.timeline[0]?.venues.perp.stats?.n).toBe(300);
    expect(d.timeline.find((t) => t.session === "regular")?.venues.rtoken.stats).toBeNull();
    expect(d.timeline.find((t) => t.session === "weekend")?.venues.rtoken.tradable).toBe(true);
    expect(r.slots["deepest.perp.session"]?.value).toBe("overnight");
    expect(r.slots["now.rtoken.depth25"]).toMatchObject({ unit: "usd", source: "bitget.spot.orderbook" });
  });

  it("gathers Bitget-skill evidence, recomputes technicals from Bitget's bars and flags bad upstream data", async () => {
    const r = await recordedDesk().research("NVDA");
    expect(r.data.perp24h?.changePct).toBe(1.775);
    expect(r.slots["perp24h.change"]).toMatchObject({ value: 0.01775, unit: "pct" });
    expect(r.data.technicals).toMatchObject({ source: "bitget.mix.candles", bars: 24 });
    expect(r.data.flags.map((f) => f.code)).toEqual(["SIGNAL_BOLLINGER_INVERTED", "SIGNAL_VENUE_MISMATCH"]);
    expect(r.data.bollinger?.recomputed.upper).toBeGreaterThan(
      r.data.bollinger?.recomputed.lower ?? Infinity,
    );
    expect(r.data.unavailable).toContain("bitget-mcp.equity_price_quote");
    expect(r.slots.unavailable?.value).toMatch(/bitget-mcp\.equity_price_quote/);
  });

  it("reports an unpublished track record as unavailable, and slots every figure of a published one", async () => {
    const none = await recordedDesk().trackRecord();
    expect(none.data).toMatchObject({ status: "unavailable", record: null });
    const record = {
      generatedAt: NOW,
      n: 120,
      bySymbol: { NVDA: { maeBps: 2.4, coverage: 0.81 }, TSLA: { maeBps: 3.1 } },
    };
    const r = await recordedDesk({ trackRecord: record }).trackRecord("nvda");
    expect(r.data.record).toEqual({ ...record, bySymbol: { NVDA: record.bySymbol.NVDA } });
    expect(r.slots["track.bySymbol.NVDA.maeBps"]).toMatchObject({ value: 2.4, unit: "bps" });
    expect(r.slots["track.bySymbol.NVDA.coverage"]).toMatchObject({ value: 0.81, unit: "pct" });
    expect(r.slots["track.n"]).toMatchObject({ value: 120, unit: "count" });
    expect(r.slots["track.generatedAt"]?.unit).toBe("text");
  });

  it("projects the tape's published track record (real artifact, trimmed) into curated slots", async () => {
    const real = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/track-record.json", import.meta.url)), "utf8"),
    );
    const r = await recordedDesk({ trackRecord: real }).trackRecord();
    expect(r.data.status).toBe("live");
    expect(r.slots["track.label"]?.value).toBe("REPRODUCIBLE");
    expect(r.slots["track.protocol"]?.value).toBe("slipway-eval v1");
    expect(r.slots["track.counts.eval.entries"]).toMatchObject({
      value: real.counts.eval.entries,
      unit: "count",
    });
    expect(r.slots["track.counts.eval.pending"]?.value).toBe(real.counts.eval.pending);
    expect(r.slots["track.h2h.vsImmediate.n"]).toMatchObject({ value: 0, unit: "count" });
    expect(r.slots["track.h2h.vsImmediate.winRate"]).toBeUndefined(); // null upstream stays absent
    expect(Object.keys(r.slots).some((k) => k.startsWith("track.accuracy"))).toBe(false);
  });

  it("explains topics with constants exposed as slots and lists topics when unknown", () => {
    const desk = recordedDesk();
    const u = desk.explain("urgency");
    expect(u.data.found).toBe(true);
    expect(u.slots["explain.lambdaPatient"]?.value).toBe(0.25);
    expect(desk.explain("cost cap").data.topic).toBe("COST_CAP");
    const x = desk.explain("astrology");
    expect(x.data.found).toBe(false);
    expect(x.data.topics).toContain("perp_then_rotate");
    for (const k of x.data.topics) expect(desk.explain(k).data.text).not.toMatch(/\p{N}/u);
  });
});
