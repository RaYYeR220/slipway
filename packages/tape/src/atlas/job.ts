// Hourly atlas job: digest closed tape hours, rebuild the atlas, add gap/basis σ from 60 days of 1 h candles.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BitgetRest, type IntegrityFlag, parseStates } from "@slipway/bitget";
import { type HolidayClosure, nyseHolidayClosures, sessionAt } from "@slipway/core";
import { hourLines } from "../read.js";
import { HOUR_MS, hourKey, hourStart, type TapeSource } from "../source.js";
import { type AtlasDoc, buildAtlas, type KeyCache, type KeyResult } from "./build.js";
import { basisSigma, gapSigmas, hourlyCandles } from "./candles.js";
import { DigestStore, digestHour } from "./digest.js";

export interface AtlasJobOptions {
  source: TapeSource;
  work: string; // local working directory (digests, candle cache)
  rest: BitgetRest;
  symbols: readonly string[];
  now: number;
  lookbackDays?: number;
  maxSessionHours?: number;
  candleDays?: number;
  log?: (msg: string) => void;
}

/** Published Reality closures plus the static NYSE list (past and future), so past tape is classified too. */
export async function allHolidays(
  rest: BitgetRest,
): Promise<{ closures: HolidayClosure[]; flags: string[] }> {
  const statics = nyseHolidayClosures();
  try {
    const cal = (await rest.holidayCalendar()).data;
    const published = cal.closures.map((c) => ({
      start: c.start,
      end: c.end,
      label: c.label ?? c.startLocal,
    }));
    const extra = statics.filter((s) => !published.some((p) => p.start < s.end && s.start < p.end));
    return { closures: [...published, ...extra].sort((a, b) => a.start - b.start), flags: [] };
  } catch (e) {
    return {
      closures: statics,
      flags: [
        `CALENDAR_FALLBACK: Reality calendar unavailable (${(e as Error).message}); static NYSE closures used`,
      ],
    };
  }
}

export async function digestClosedHours(
  source: TapeSource,
  digests: DigestStore,
  now: number,
  lookbackDays: number,
  log: (m: string) => void = () => {},
): Promise<string[]> {
  const done = new Set(await digests.hours());
  const since = hourKey(now - lookbackDays * 24 * HOUR_MS);
  const closed = (await source.hours("books")).filter(
    (h) => h >= since && hourStart(h) + HOUR_MS + 3 * 60_000 <= now && !done.has(h),
  );
  for (const h of closed) {
    const t0 = Date.now();
    const d = await digestHour(source, h);
    await digests.write(h, d);
    log(`digest ${h}: ${d.size} instruments in ${Date.now() - t0} ms`);
  }
  for (const h of done) if (h < since) await rm(join(digests.dir, h), { recursive: true, force: true });
  return closed;
}

export async function runAtlasJob(o: AtlasJobOptions): Promise<AtlasDoc> {
  const log = o.log ?? (() => {});
  const lookbackDays = o.lookbackDays ?? 14;
  const digests = new DigestStore(join(o.work, "digest"));
  await digestClosedHours(o.source, digests, o.now, lookbackDays, log);
  const { closures: holidays, flags: calFlags } = await allHolidays(o.rest);
  const cacheFile = join(o.work, "atlas-key-cache.json");
  let cache: KeyCache = new Map();
  try {
    cache = new Map(
      JSON.parse(await readFile(cacheFile, "utf8")) as [string, { sig: string; result: KeyResult }][],
    );
  } catch {}
  const built = await buildAtlas(
    digests,
    o.source,
    {
      symbols: o.symbols,
      holidays,
      now: o.now,
      lookbackDays,
      ...(o.maxSessionHours ? { maxSessionHours: o.maxSessionHours } : {}),
    },
    cache,
  );
  await writeFile(cacheFile, JSON.stringify([...cache]));
  const flags = [...calFlags, ...(await realityStateFlags(o.source)), ...built.flags];
  const gapSigmaBps: AtlasDoc["gapSigmaBps"] = {};
  const basisSigmaBpsPerSqrtHour: AtlasDoc["basisSigmaBpsPerSqrtHour"] = {};
  const candleDays = o.candleDays ?? 60;
  const cacheDir = join(o.work, "candles");
  for (const symbol of o.symbols) {
    try {
      const [r, p] = await Promise.all(
        (["rtoken", "perp"] as const).map((v) =>
          hourlyCandles(o.rest, v, symbol, { days: candleDays, cacheDir, now: o.now }),
        ),
      );
      const gaps: Record<string, number> = {};
      for (const [venue, candles] of [
        ["rtoken", r],
        ["perp", p],
      ] as const) {
        for (const [k, g] of Object.entries(gapSigmas(candles ?? [], holidays))) {
          if (Number.isFinite(g.sigmaBps)) gaps[`${venue}|${k}`] = g.sigmaBps;
          else
            flags.push(
              `GAP_SIGMA_THIN ${symbol} ${venue}|${k}: ${g.n} sample(s) in ${candleDays} d; omitted`,
            );
        }
      }
      gapSigmaBps[symbol] = gaps;
      const info = (await o.rest.stockInfo(symbol)).data;
      const b = basisSigma(p ?? [], r ?? [], info, holidays, sessionAt);
      if (Number.isFinite(b.sigmaBps)) basisSigmaBpsPerSqrtHour[symbol] = b.sigmaBps;
      else flags.push(`BASIS_SIGMA_THIN ${symbol}: ${b.n} tradable hourly pairs; omitted`);
    } catch (e) {
      flags.push(`CANDLES_UNAVAILABLE ${symbol}: ${(e as Error).message}; gap/basis σ omitted`);
    }
    try {
      const t = (await o.rest.spotTicker(symbol)).data;
      if (t.platformTurnover24h && t.platformTurnover24h > 0 && t.turnover24h / t.platformTurnover24h > 100)
        flags.push(
          `RTOKEN_VOLUME_MIRROR ${symbol}: rToken turnover24h $${Math.round(t.turnover24h).toLocaleString("en-US")} mirrors the US consolidated tape; Bitget-native platformTurnover24h is $${Math.round(t.platformTurnover24h).toLocaleString("en-US")}`,
        );
    } catch {}
  }
  flags.push(
    "METHOD depth bands and representative books: REST full-depth snapshots (60 s); spread, σ, resilience, trade flow: books15 (<=1/s, written on change) + public trades; each key uses the most recent recorded hours of its session",
    `METHOD gap σ: RMS (clipped) of log returns from mid-session to the planner's entry in the target session (regular = open + 15 min), 1 h closes, last ${candleDays} days, per venue`,
    "METHOD basis σ: RMS (clipped) of hourly changes in log(perp/rToken) over hours where the rToken is tradable at both ends",
  );
  return {
    generatedAt: o.now,
    window: built.window,
    atlas: built.atlas,
    gapSigmaBps,
    basisSigmaBpsPerSqrtHour,
    coverage: built.coverage,
    hourOfWeek: built.hourOfWeek,
    flags,
  };
}

/**
 * Integrity of Bitget's Reality session labels as recorded (e.g. daylightType "standard" / EST while New York is on
 * EDT): checked on the newest recorded states snapshots, one flag per finding with when it was last observed.
 */
export async function realityStateFlags(source: TapeSource): Promise<string[]> {
  const hours = (await source.hours("states")).slice(-2);
  const found = new Map<string, { detail: string; at: number; n: number }>();
  let checked = 0;
  for (const h of hours) {
    for await (const line of hourLines(source, "states", h)) {
      let r: { rx: number; data: unknown };
      try {
        r = JSON.parse(line) as { rx: number; data: unknown };
      } catch {
        continue;
      }
      let flags: IntegrityFlag[];
      try {
        flags = parseStates({ code: "00000", data: r.data }, r.rx).flags;
      } catch {
        continue;
      }
      checked++;
      for (const f of flags) {
        const cur = found.get(f.code);
        found.set(f.code, { detail: f.detail, at: Math.max(cur?.at ?? 0, r.rx), n: (cur?.n ?? 0) + 1 });
      }
    }
  }
  return [...found].map(
    ([code, f]) =>
      `${code} (bitget.reality.session-states, ${f.n}/${checked} recorded snapshots, last ${new Date(f.at).toISOString()}): ${f.detail}`,
  );
}
