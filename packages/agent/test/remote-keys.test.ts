import { SourceCache } from "@slipway/bitget";
import {
  exportKeyPair,
  generateSigningKeys,
  type MarketSnapshot,
  signPlan,
  verifySignedPlan,
} from "@slipway/core";
import { describe, expect, it } from "vitest";
import { envKeys, keysFromSecret } from "../src/desk/keys.js";
import { DerivedArtifacts, parseAtlasDoc, withAtlas } from "../src/desk/remote.js";
import { atlasDoc, NOW } from "./support/desk.js";

const snapshot = (): MarketSnapshot => ({
  symbol: "NVDA",
  now: NOW,
  books: {},
  fees: { rtoken: { maker: 0.001, taker: 0.001 }, perp: { maker: 0.0002, taker: 0.0006 } },
  funding: null,
  sessions: { symbol: "NVDA", tradingPeriods: [], weekendTradable: false },
  holidays: [],
  atlas: {},
  events: [],
  sources: [],
});

describe("derived artifacts (atlas, track record)", () => {
  it("keeps well-formed atlas entries, drops malformed ones and counts them", () => {
    const doc = atlasDoc();
    const { doc: parsed, dropped } = parseAtlasDoc({
      ...doc,
      atlas: {
        ...doc.atlas,
        "NVDA|perp|regular": { symbol: "NVDA" },
        "X|perp|overnight": doc.atlas["NVDA|perp|overnight"],
      },
      gapSigmaBps: { NVDA: { "rtoken|overnight->regular": 140.7, bad: "x" } },
    });
    expect(Object.keys(parsed.atlas).sort()).toEqual(Object.keys(doc.atlas).sort());
    expect(dropped).toBe(2);
    expect(parsed.gapSigmaBps.NVDA).toEqual({ "rtoken|overnight->regular": 140.7 });
    expect(() => parseAtlasDoc({ generatedAt: 1 })).toThrow(/no `atlas` object/);
  });

  it("applies the symbol's slice, gap and basis sigmas, and records the atlas source", () => {
    const doc = { ...atlasDoc(), gapSigmaBps: { NVDA: { "perp|overnight->regular": 137.2 } } };
    const out = withAtlas(snapshot(), {
      data: doc,
      source: { id: "slipway.atlas", status: "live", asOf: NOW },
      latencyMs: 0,
    });
    expect(Object.keys(out.atlas)).toHaveLength(4);
    expect(out.gapSigmaBps).toEqual({ "perp|overnight->regular": 137.2 });
    expect(out.basisSigmaBpsPerSqrtHour).toBeCloseTo(4.78, 2);
    const none = withAtlas(snapshot(), {
      data: null,
      source: { id: "slipway.atlas", status: "unavailable", asOf: null },
      latencyMs: 0,
    });
    expect(none.atlas).toEqual({});
    expect(none.sources).toEqual([{ id: "slipway.atlas", status: "unavailable", asOf: null }]);
  });

  it("reports a missing artifact as unavailable with the HTTP status, never a default", async () => {
    const calls: string[] = [];
    const fetch404 = async (url: string) => {
      calls.push(url);
      return new Response("<Error>NoSuchKey</Error>", { status: 404 });
    };
    const a = new DerivedArtifacts(new SourceCache({ clock: () => NOW }), fetch404);
    const atlas = await a.atlas();
    expect(atlas.data).toBeNull();
    expect(atlas.source).toMatchObject({ id: "slipway.atlas", status: "unavailable", since: NOW });
    expect(atlas.source.detail).toMatch(/HTTP 404/);
    expect((await a.trackRecord()).source.status).toBe("unavailable");
    expect(calls[0]).toBe("https://storage.googleapis.com/slipway-tape-c48c75/derived/atlas.json");
  });

  it("serves a published atlas live with its generation time", async () => {
    const doc = atlasDoc();
    const a = new DerivedArtifacts(new SourceCache({ clock: () => NOW }), async () => Response.json(doc));
    const got = await a.atlas();
    expect(got.source).toMatchObject({ status: "live", asOf: NOW });
    expect(Object.keys(got.data?.atlas ?? {})).toHaveLength(4);
  });
});

describe("signing keys", () => {
  it("derives the public key from the configured private key (PKCS#8 or JSON) and signs verifiably", async () => {
    const exported = await exportKeyPair(await generateSigningKeys());
    const a = await keysFromSecret(exported.privateKey);
    const b = await keysFromSecret(JSON.stringify(exported));
    expect(a.publicKey).toBe(exported.publicKey);
    expect(b.publicKey).toBe(exported.publicKey);
    const plan = { intent: { symbol: "NVDA", side: "buy" }, n: 1 } as never;
    const gate = { verdict: "allow", checks: [] } as never;
    const signed = await signPlan(plan, gate, a.keys, NOW);
    expect(await verifySignedPlan(signed, exported.publicKey)).toEqual({ ok: true });
  });

  it("requires a configured key in production", async () => {
    await expect(envKeys({ NODE_ENV: "production" })).rejects.toThrow(/SLIPWAY_SIGNING_KEY is required/);
  });
});
