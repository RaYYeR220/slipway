import { describe, expect, it } from "vitest";
import { renderModelText, type Slot } from "../src/slots.js";

const slots: Record<string, Slot> = {
  "best.expectedBps": { value: 8.5234, unit: "bps", dp: 1, source: "planner" },
  "best.sdBps": { value: 13.61, unit: "bps", dp: 1, source: "planner" },
  "intent.notionalUsd": { value: 250000, unit: "usd", source: "user" },
  "best.slices": { value: 12, unit: "count", source: "planner" },
  "funding.rate": { value: 0.000089, unit: "pct", dp: 4, source: "bitget.mix.funding" },
  "wait.until": { value: "09:45 ET", unit: "text", source: "session" },
  "basis.bps": { value: -6.2, unit: "bps", dp: 1, signed: true, source: "bitget.spot.orderbook" },
};

describe("renderModelText", () => {
  it("substitutes slots with code-formatted values and records their sources", () => {
    const r = renderModelText("Expected {{best.expectedBps}} ± {{best.sdBps}} on {{intent.notionalUsd}}.", slots);
    expect(r.text).toBe("Expected 8.5 bp ± 13.6 bp on $250,000.");
    expect(r.ok).toBe(true);
    expect(r.parts.filter((p) => p.kind === "slot").map((p) => p.source)).toEqual(["planner", "planner", "user"]);
  });

  it("formats counts, percentages, signed values and text slots", () => {
    const r = renderModelText(
      "{{best.slices}} slices; funding {{funding.rate}}; basis {{basis.bps}}; wait until {{wait.until}}.",
      slots,
    );
    expect(r.text).toBe("12 slices; funding 0.0089%; basis −6.2 bp; wait until 09:45 ET.");
  });

  it("masks every digit the model wrote itself, in any script", () => {
    for (const s of ["7.9 bp", "７ bp", "٧ bp", "x9bp", "cost:79bps", "½", "Ⅳ", "①", "10²"]) {
      const r = renderModelText(`Expected ${s}.`, slots);
      expect(r.ok, s).toBe(false);
      expect(r.text, s).not.toMatch(/\p{N}/u);
    }
  });

  it("masks spelled-out numbers", () => {
    const r = renderModelText("About eight basis points, roughly a third cheaper, twelve slices.", slots);
    expect(r.ok).toBe(false);
    expect(r.flags.map((f) => f.raw.toLowerCase())).toEqual(["eight", "third", "twelve"]);
  });

  it("masks Russian and Chinese numerals but leaves ordinary words alone", () => {
    const ru = renderModelText("Примерно восемь б.п., в полтора раза дешевле; это стоит дешевле.", slots);
    expect(ru.flags.map((f) => f.raw)).toEqual(["восемь", "полтора"]);
    const zh = renderModelText("成本八点五个基点，分三笔执行；一些订单可以等待。", slots);
    expect(zh.flags.map((f) => f.raw)).toEqual(["八", "五", "三"]);
    expect(zh.text).toContain("一些订单");
  });

  it("strips markup that could draw a number without typing one", () => {
    const r = renderModelText('See ![cost](https://example.com/c.png) and <span style="x">cheap</span>.', slots);
    expect(r.ok).toBe(false);
    expect(r.flags.map((f) => f.reason)).toEqual(["markup", "markup", "markup"]);
    expect(r.text).not.toMatch(/https|<span/);
  });

  it("flags unknown slots instead of inventing a value", () => {
    const r = renderModelText("Saves {{best.savingsBps}} versus TWAP.", slots);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("Saves [unknown] versus TWAP.");
  });

  it("does not let a slot name smuggle text", () => {
    const r = renderModelText("{{best.expectedBps}} and {{ not a slot }} and {{a}b}}", slots);
    expect(r.text.startsWith("8.5 bp")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("leaves words without numbers untouched", () => {
    const r = renderModelText("Wait for the New York open; the rNVDA book is deeper then.", slots);
    expect(r).toMatchObject({ ok: true, text: "Wait for the New York open; the rNVDA book is deeper then." });
  });
});
