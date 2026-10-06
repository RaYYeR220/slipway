// Answer-key checks for one LUI turn. Pure: takes the turn result and returns named pass/fail checks.
import { nyParts } from "@slipway/core";
import type { TurnResult } from "../src/llm/agent.js";

export interface IntentExpect {
  tool: "price_options" | "build_plan";
  symbol?: string;
  side?: "buy" | "sell";
  notionalUsd?: number;
  qty?: number;
  venues?: string[];
  urgency?: string;
  holdHorizonHours?: number;
  deadlineDay?: string;
  deadlineHours?: [number, number];
}

export interface TurnExpect {
  calls?: { mustInclude?: string[]; mustNotInclude?: string[] };
  intent?: IntentExpect;
  clarify?: boolean;
  noNumerals?: boolean;
  citesSlot?: string;
  ticketsIffAllow?: boolean;
  lang?: "cyrillic" | "cjk";
  patch?: Record<string, unknown>;
  any?: TurnExpect[];
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const ORDER_TOOLS = ["price_options", "build_plan", "issue_tickets"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface Ctx {
  now: number;
  latestVerdict: string | null;
  priorVerdict: string | null;
}

function intentChecks(e: IntentExpect, r: TurnResult, now: number): Check[] {
  const env = [...r.envelopes].reverse().find((x) => x.tool === e.tool);
  if (!env) return [{ name: "intent", pass: false, detail: `no ${e.tool} call` }];
  const data = env.data as { intent?: Record<string, unknown> } | undefined;
  const call = [...r.toolCalls].reverse().find((c) => c.tool === e.tool);
  // The desk's resolved intent when the call succeeded; the raw arguments otherwise.
  const got = (data?.intent ?? call?.input ?? {}) as Record<string, unknown>;
  const out: Check[] = [];
  const eq = (name: string, ok: boolean, want: unknown) =>
    out.push({
      name: `intent.${name}`,
      pass: ok,
      detail: ok ? undefined : `want ${JSON.stringify(want)}, got ${JSON.stringify(got[name])}`,
    });
  if (e.symbol !== undefined) eq("symbol", String(got.symbol ?? "").toUpperCase() === e.symbol, e.symbol);
  if (e.side !== undefined) eq("side", got.side === e.side, e.side);
  if (e.notionalUsd !== undefined)
    eq("notionalUsd", Math.abs(Number(got.notionalUsd) / e.notionalUsd - 1) <= 0.01, e.notionalUsd);
  if (e.qty !== undefined) eq("qty", Number(got.qty) === e.qty, e.qty);
  if (e.venues !== undefined) {
    const v = Array.isArray(got.venues) ? [...(got.venues as string[])].sort() : null;
    eq("venues", JSON.stringify(v) === JSON.stringify([...e.venues].sort()), e.venues);
  }
  if (e.urgency !== undefined) eq("urgency", got.urgency === e.urgency, e.urgency);
  if (e.holdHorizonHours !== undefined)
    eq(
      "holdHorizonHours",
      Math.abs(Number(got.holdHorizonHours) / e.holdHorizonHours - 1) <= 0.15,
      e.holdHorizonHours,
    );
  if (e.deadlineDay !== undefined || e.deadlineHours !== undefined) {
    const ts = typeof got.deadline === "number" ? got.deadline : null;
    if (ts === null)
      out.push({
        name: "intent.deadline",
        pass: false,
        detail: `no resolved deadline (raw ${JSON.stringify(call?.input.deadline)})`,
      });
    else if (e.deadlineDay !== undefined) {
      const p = nyParts(ts);
      const day = DAYS.indexOf(e.deadlineDay);
      // "before thursday" may reasonably resolve to the end of Wednesday.
      const ok = p.weekday === day || (p.weekday === (day + 6) % 7 && p.hour >= 16);
      out.push({
        name: "intent.deadline",
        pass: ok,
        detail: ok ? undefined : `resolved to ${String(got.deadlineNy)}`,
      });
    } else if (e.deadlineHours) {
      const h = (ts - now) / 3_600_000;
      const ok = h >= e.deadlineHours[0] && h <= e.deadlineHours[1];
      out.push({
        name: "intent.deadline",
        pass: ok,
        detail: ok ? undefined : `resolved ${h.toFixed(1)} h ahead`,
      });
    }
  }
  return out;
}

export function scoreTurn(x: TurnExpect, r: TurnResult | null, ctx: Ctx): { checks: Check[]; score: number } {
  if (!r) return { checks: [{ name: "completed", pass: false }], score: 0 };
  const checks: Check[] = [];
  const called = new Set(r.toolCalls.map((c) => c.tool as string));
  if (x.calls?.mustInclude)
    for (const t of x.calls.mustInclude) checks.push({ name: `calls+${t}`, pass: called.has(t) });
  if (x.calls?.mustNotInclude)
    for (const t of x.calls.mustNotInclude) checks.push({ name: `calls-${t}`, pass: !called.has(t) });
  if (x.intent) checks.push(...intentChecks(x.intent, r, ctx.now));
  if (x.clarify) {
    const asked = /[?？]/.test(r.rendered.text);
    checks.push({ name: "clarify", pass: asked && !ORDER_TOOLS.some((t) => called.has(t)) });
  }
  if (x.noNumerals) {
    const masked = r.rendered.flags.length;
    checks.push({
      name: "noNumerals",
      pass: masked === 0,
      detail: masked ? JSON.stringify(r.rendered.flags.map((f) => f.raw)) : undefined,
    });
  }
  if (x.citesSlot) {
    const re = new RegExp(x.citesSlot);
    checks.push({
      name: "citesSlot",
      pass: r.rendered.parts.some((p) => p.kind === "slot" && re.test(p.name)),
    });
  }
  if (x.ticketsIffAllow) {
    const allow = ctx.latestVerdict === "allow";
    const ticketed = r.toolCalls.some((c) => c.tool === "issue_tickets" && c.ok === true);
    checks.push({
      name: "ticketsIffAllow",
      pass: allow === ticketed,
      detail: `verdict ${ctx.latestVerdict}, ticketed ${ticketed}`,
    });
  }
  if (x.lang) {
    const re = x.lang === "cyrillic" ? /\p{Script=Cyrillic}/u : /\p{Script=Han}/u;
    checks.push({ name: `lang.${x.lang}`, pass: re.test(r.rendered.text) });
  }
  if (x.patch) {
    const call = r.toolCalls.find((c) => c.tool === "propose_profile_update");
    const patch = (call?.input.patch ?? {}) as Record<string, unknown>;
    const ok = Object.entries(x.patch).every(([k, v]) => patch[k] === v);
    checks.push({ name: "patch", pass: ok, detail: ok ? undefined : JSON.stringify(patch) });
  }
  if (x.any) {
    const ok = x.any.some((alt) => scoreTurn(alt, r, ctx).score === 1);
    checks.push({ name: "any", pass: ok });
  }
  checks.push({ name: "replied", pass: r.rendered.text.trim().length > 0 });
  const score = checks.filter((c) => c.pass).length / checks.length;
  return { checks, score };
}
