import { describe, expect, it } from "vitest";
import { runGate } from "../src/gate.js";
import { buildPlan, planExecution } from "../src/planner.js";
import {
  assertTicketable,
  canonicalJson,
  exportKeyPair,
  generateSigningKeys,
  hashPlan,
  importKeyPair,
  sha256Hex,
  signPlan,
  verifySignedPlan,
} from "../src/sign.js";
import type { GateResult, Profile, SignedPlan } from "../src/types.js";
import { must } from "./helpers.js";
import { nvdaSnapshot } from "./market.js";

const desk: Profile = {
  name: "desk",
  urgency: "normal",
  costCapBps: 50,
  maxParticipation: 0.25,
  allowPerp: true,
  maxLeverage: 1,
  avoidSessions: [],
  avoidEvents: true,
};
const snap = nvdaSnapshot("overnight");
const result = planExecution({ symbol: "NVDA", side: "buy", notionalUsd: 25_000 }, desk, snap);
const plan = buildPlan(result, "immediate:perp");
const gate = runGate({ plan, snapshot: snap, profile: desk, now: snap.now });
const issuedAt = snap.now + 200;

const flipFirstByte = (b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[0] = (bytes[0] as number) ^ 0x01;
  return btoa(String.fromCharCode(...bytes));
};

describe("canonicalJson", () => {
  it("sorts keys recursively and is insertion-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "s" } })).toBe(
      '{"a":{"c":"s","d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("omits undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: null, c: 0 })).toBe('{"b":null,"c":0}');
  });

  it("refuses values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/plain/);
  });

  it("serialises a real plan", () => {
    expect(JSON.parse(canonicalJson(plan))).toEqual(JSON.parse(JSON.stringify(plan)));
  });
});

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("signPlan / verifySignedPlan", () => {
  it("signs the canonical hash of {plan, gate} and verifies with the trusted key", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    expect(signed.hash).toBe(await sha256Hex(canonicalJson({ plan, gate })));
    expect(signed.hash).toBe(await hashPlan(plan, gate));
    expect(signed.issuedAt).toBe(issuedAt);
    expect(atob(signed.pubkey)).toHaveLength(32);
    expect(await verifySignedPlan(signed, signed.pubkey)).toEqual({ ok: true });
  });

  it("is deterministic for the same key and inputs (Ed25519)", async () => {
    const keys = await generateSigningKeys();
    expect(await signPlan(plan, gate, keys, issuedAt)).toEqual(await signPlan(plan, gate, keys, issuedAt));
  });

  it("round-trips exported keys", async () => {
    const exported = await exportKeyPair(await generateSigningKeys());
    const keys = await importKeyPair(exported);
    const signed = await signPlan(plan, gate, keys, issuedAt);
    expect(signed.pubkey).toBe(exported.publicKey);
    expect(await verifySignedPlan(signed, exported.publicKey)).toEqual({ ok: true });
  });

  it("detects a tampered plan, signature or issuance time", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    const tamperedPlan: SignedPlan = {
      ...signed,
      plan: {
        ...signed.plan,
        strategy: { ...signed.plan.strategy, expectedBps: signed.plan.strategy.expectedBps - 1 },
      },
    };
    expect(await verifySignedPlan(tamperedPlan, signed.pubkey)).toEqual({
      ok: false,
      reason: expect.stringMatching(/hash/),
    });
    expect(await verifySignedPlan({ ...signed, sig: flipFirstByte(signed.sig) }, signed.pubkey)).toEqual({
      ok: false,
      reason: expect.stringMatching(/signature/),
    });
    expect(await verifySignedPlan({ ...signed, issuedAt: issuedAt + 30_000 }, signed.pubkey)).toEqual({
      ok: false,
      reason: expect.stringMatching(/signature/),
    });
  });
});

describe("assertTicketable", () => {
  it("accepts a fresh, allowed, correctly signed plan", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    await expect(assertTicketable(signed, signed.pubkey, issuedAt + 60_000)).resolves.toBeUndefined();
  });

  it("throws when one byte of the signature is flipped", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    await expect(
      assertTicketable({ ...signed, sig: flipFirstByte(signed.sig) }, signed.pubkey, issuedAt),
    ).rejects.toThrow(/signature/);
  });

  it("throws when one byte of the plan is changed", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    const s0 = must(signed.plan.strategy.slices[0]);
    const tampered: SignedPlan = {
      ...signed,
      plan: { ...signed.plan, strategy: { ...signed.plan.strategy, slices: [{ ...s0, qty: s0.qty * 10 }] } },
    };
    await expect(assertTicketable(tampered, signed.pubkey, issuedAt)).rejects.toThrow(/hash/);
  });

  it("throws for a key other than the trusted one", async () => {
    const signed = await signPlan(plan, gate, await generateSigningKeys(), issuedAt);
    const other = await exportKeyPair(await generateSigningKeys());
    await expect(assertTicketable(signed, other.publicKey, issuedAt)).rejects.toThrow(/key/);
  });

  it("throws unless the gate verdict is allow", async () => {
    const keys = await generateSigningKeys();
    const held: GateResult = {
      verdict: "hold",
      checks: gate.checks.map((c) => (c.code === "EVENT_WINDOW" ? { ...c, status: "hold" as const } : c)),
    };
    const signed = await signPlan(plan, held, keys, issuedAt);
    await expect(assertTicketable(signed, signed.pubkey, issuedAt)).rejects.toThrow(/hold/);
  });

  it("throws when a signed verdict contradicts its own checks", async () => {
    const keys = await generateSigningKeys();
    const inconsistent: GateResult = {
      verdict: "allow",
      checks: gate.checks.map((c) => (c.code === "COST_CAP" ? { ...c, status: "refuse" as const } : c)),
    };
    const signed = await signPlan(plan, inconsistent, keys, issuedAt);
    await expect(assertTicketable(signed, signed.pubkey, issuedAt)).rejects.toThrow(/verdict/);
  });

  it("throws when the signature is older than 60 s or from the future", async () => {
    const keys = await generateSigningKeys();
    const signed = await signPlan(plan, gate, keys, issuedAt);
    await expect(assertTicketable(signed, signed.pubkey, issuedAt + 60_001)).rejects.toThrow(/old/);
    await expect(assertTicketable(signed, signed.pubkey, issuedAt - 10_000)).rejects.toThrow(/future/);
  });
});
