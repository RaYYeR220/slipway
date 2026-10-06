// A desk wired to recorded Bitget payloads (REST + MCP sessions) and an atlas built from core's recorded tape.
import { BitgetDataMcp, BitgetRest, loadMarketSnapshot, SignalMcp, SourceCache } from "@slipway/bitget";
import { exportPublicKey, generateSigningKeys } from "@slipway/core";
import { fakeSleep, mcpReplay, restRecordedAt, restReplay } from "../../../bitget/test/helpers.js";
import { NVDA_BASIS_SIGMA, nvdaAtlas } from "../../../core/test/market.js";
import type { DeskKeys } from "../../src/desk/keys.js";
import { type AtlasDoc, staticAtlas, TRACK_RECORD_SOURCE } from "../../src/desk/remote.js";
import { Desk, type DeskOptions } from "../../src/desk/service.js";

export const NOW = restRecordedAt("spot-orderbook");

export const atlasDoc = (): AtlasDoc => ({
  generatedAt: NOW,
  atlas: nvdaAtlas(),
  gapSigmaBps: {},
  basisSigmaBpsPerSqrtHour: { NVDA: NVDA_BASIS_SIGMA },
});

let keys: Promise<DeskKeys> | null = null;
export const testKeys = (): Promise<DeskKeys> => {
  keys ??= (async () => {
    const k = await generateSigningKeys();
    return { keys: k, publicKey: await exportPublicKey(k.publicKey), origin: "ephemeral" as const };
  })();
  return keys;
};

export type RecordedOverrides = Partial<DeskOptions> & {
  atlas?: AtlasDoc | null;
  clockOffsetMs?: number;
  trackRecord?: unknown;
};

/** Desk options over recorded data; pass them to whichever Desk class the caller tests (src or built). */
export function recordedDeskOptions(over: RecordedOverrides = {}): DeskOptions {
  const { atlas, clockOffsetMs, trackRecord, ...rest } = over;
  const clock = () => NOW + (clockOffsetMs ?? 1_000);
  const cache = new SourceCache({ clock: () => NOW });
  const http = new BitgetRest({
    fetch: restReplay(),
    sleep: fakeSleep(),
    random: () => 0.5,
    clock: () => NOW,
  });
  const doc = atlas === undefined ? atlasDoc() : atlas;
  return {
    clock,
    snapshot: (s) => loadMarketSnapshot(s, { rest: http, cache, dataMcp: null, signal: null, now: NOW }),
    artifacts: {
      atlas: async () =>
        doc
          ? staticAtlas(doc, NOW)
          : {
              data: null,
              source: {
                id: "slipway.atlas",
                status: "unavailable",
                asOf: null,
                since: NOW,
                detail: "HTTP 404",
              },
              latencyMs: 0,
            },
      trackRecord: async () =>
        trackRecord === undefined
          ? {
              data: null,
              source: {
                id: TRACK_RECORD_SOURCE,
                status: "unavailable",
                asOf: null,
                since: NOW,
                detail: "HTTP 404",
              },
              latencyMs: 0,
            }
          : {
              data: trackRecord,
              source: { id: TRACK_RECORD_SOURCE, status: "live", asOf: NOW },
              latencyMs: 0,
            },
    },
    keys: testKeys,
    rest: http,
    dataMcp: new BitgetDataMcp({ fetch: mcpReplay("mcp/bitget-mcp.session.json"), cache, clock: () => NOW }),
    signal: new SignalMcp({ fetch: mcpReplay("mcp/signal-mcp.session.json"), cache, clock: () => NOW }),
    ...rest,
  };
}

export const recordedDesk = (over: RecordedOverrides = {}): Desk => new Desk(recordedDeskOptions(over));
