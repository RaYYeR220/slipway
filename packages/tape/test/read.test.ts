import { describe, expect, it } from "vitest";
import { hourLines, hoursIn, nearestBooks, records, tapeEnd } from "../src/read.js";
import type { BookRecord } from "../src/records.js";
import { FsTapeSource, hourKey, tapeSource } from "../src/source.js";
import { fix } from "./helpers.js";

const src = new FsTapeSource(fix("tape"));
const HOUR = "2026-10-06T04";

async function all(stream: "books" | "trades" | "depth", source = src): Promise<BookRecord[]> {
  const out: BookRecord[] = [];
  for await (const l of hourLines(source, stream, HOUR)) out.push(JSON.parse(l));
  return out;
}

describe("tape reader", () => {
  it("lists hour files per stream", async () => {
    expect(await src.hours("books")).toEqual([HOUR]);
    expect(await src.hours("states")).toEqual([HOUR]);
    expect(await new FsTapeSource(fix("tape-open")).hours("trades")).toEqual([]);
    expect(
      await hoursIn(src, "books", Date.parse("2026-10-06T03:00Z"), Date.parse("2026-10-06T05:00Z")),
    ).toEqual([HOUR]);
    expect(hourKey(Date.parse("2026-10-06T04:59:59.999Z"))).toBe(HOUR);
  });

  it("streams every recorded line of a closed hour", async () => {
    const books = await all("books");
    expect(books.length).toBe(209);
    expect(new Set(books.map((b) => b.instId))).toEqual(new Set(["NVDAUSDT", "RNVDAUSDT"]));
  });

  it("reads an hour that is still being written up to its last complete line", async () => {
    const open = new FsTapeSource(fix("tape-open"));
    const stats = { lines: 0, bad: 0, truncated: false };
    const lines: string[] = [];
    for await (const l of hourLines(open, "books", HOUR, stats)) lines.push(l);
    const full = await all("books");
    expect(stats.truncated).toBe(true);
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.length).toBeLessThan(full.length);
    const parsed = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as BookRecord];
      } catch {
        return [];
      }
    });
    // every complete line is a prefix of the closed file, in order
    expect(parsed.length).toBeGreaterThanOrEqual(lines.length - 1);
    parsed.forEach((r, i) => {
      expect(r.ts).toBe(full[i]?.ts);
    });
  });

  it("filters records by time range and instrument", async () => {
    const from = Date.parse("2026-10-06T04:21:00Z");
    const to = Date.parse("2026-10-06T04:22:00Z");
    const got: BookRecord[] = [];
    for await (const r of records<BookRecord>(src, "books", { from, to, match: ['"instId":"NVDAUSDT"'] }))
      got.push(r);
    expect(got.length).toBeGreaterThan(30);
    expect(got.every((r) => r.instId === "NVDAUSDT" && r.ts >= from && r.ts <= to)).toBe(true);
  });

  it("finds the nearest recorded book within the window and nothing beyond it", async () => {
    const perp = (await all("books")).filter((b) => b.instId === "NVDAUSDT").sort((a, b) => a.ts - b.ts);
    const a = perp[10] as BookRecord;
    const b = perp[11] as BookRecord;
    const probe = a.ts + Math.floor((b.ts - a.ts) / 3); // closer to a
    const [m, exact, none] = await nearestBooks(
      src,
      [
        { venue: "perp", symbol: "NVDA", ts: probe },
        { venue: "perp", symbol: "NVDA", ts: b.ts },
        { venue: "perp", symbol: "NVDA", ts: Date.parse("2026-10-06T04:40:00Z") },
      ],
      2_000,
    );
    expect(m?.book.ts).toBe(a.ts);
    expect(m?.gapMs).toBe(probe - a.ts);
    expect(m?.book.venue).toBe("perp");
    expect(m?.book.asks[0]?.px).toBe(Number(a.asks[0]?.[0]));
    expect(exact?.gapMs).toBe(0);
    expect(none).toBeNull();
  });

  it("reports how far the tape reaches", async () => {
    const books = await all("books");
    expect(await tapeEnd(src)).toBe(Math.max(...books.map((b) => b.ts)));
  });

  it("builds union sources with the first source winning", async () => {
    const u = tapeSource(`${fix("tape-open")}|${fix("tape")}`);
    expect(await u.hours("books")).toEqual([HOUR]);
    expect(await u.hours("trades")).toEqual([HOUR]);
    let n = 0;
    for await (const _ of hourLines(u, "books", HOUR)) n++;
    expect(n).toBeLessThan(209); // the open (truncated) copy came first
  });
});

describe.runIf(process.env.SLIPWAY_LIVE === "1")("public bucket (live)", () => {
  it("lists and streams the public tape without credentials", async () => {
    const pub = tapeSource("gs://slipway-tape-c48c75/tape/raw");
    const hours = await pub.hours("states");
    expect(hours.length).toBeGreaterThan(0);
    let n = 0;
    for await (const _ of hourLines(pub, "states", hours[0] as string)) n++;
    expect(n).toBeGreaterThan(0);
  });
});
