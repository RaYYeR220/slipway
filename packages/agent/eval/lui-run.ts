// LUI eval runner: plays the pre-registered conversations in lui-cases.json against the live desk and the
// configured model (Venice by default), scores every turn against the answer key and writes lui-results.json.
// Usage: pnpm --filter @slipway/agent exec tsx eval/lui-run.ts [caseId ...]   (budget guard: SLIPWAY_EVAL_MAX_USD, default 3)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nyParts, type Profile } from "@slipway/core";
import { Desk } from "../src/desk/service.js";
import { type Conversation, emptyConversation, runTurnText, type TurnResult } from "../src/llm/agent.js";
import { chooseModel } from "../src/llm/provider.js";
import type { ToolName } from "../src/llm/session.js";
import { scoreTurn, type TurnExpect } from "./score.js";

interface Case {
  id: string;
  kind: string;
  profile: string;
  turns: { user: string; expect: TurnExpect }[];
}

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const raw = readFileSync(here("./lui-cases.json"), "utf8");
const spec = JSON.parse(raw) as { name: string; profiles: Record<string, Profile>; cases: Case[] };
const only = new Set(process.argv.slice(2));
const cases = spec.cases.filter((c) => only.size === 0 || only.has(c.id));
const maxUsd = Number(process.env.SLIPWAY_EVAL_MAX_USD ?? 3);

// Venice reports the account balance on every response; the eval's spend is the drop across the run.
let firstBalance: number | null = null;
let lastBalance: number | null = null;
const metered: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const b = Number(res.headers.get("x-venice-balance-usd"));
  if (Number.isFinite(b) && b > 0) {
    firstBalance ??= b;
    lastBalance = b;
  }
  return res;
};
const spent = () => (firstBalance !== null && lastBalance !== null ? firstBalance - lastBalance : 0);

const choice = chooseModel(process.env, metered);
const desk = new Desk();
const started = Date.now();
const results: unknown[] = [];
let inputTokens = 0;
let outputTokens = 0;
let aborted: string | null = null;

for (const c of cases) {
  if (spent() > maxUsd) {
    aborted = `budget guard: spent ${spent().toFixed(3)} USD > ${maxUsd}`;
    break;
  }
  const profile = spec.profiles[c.profile] as Profile;
  let conv: Conversation = emptyConversation();
  let latestVerdict: string | null = null;
  const turns = [];
  for (const t of c.turns) {
    const t0 = Date.now();
    let r: TurnResult | null = null;
    let error: string | null = null;
    try {
      r = await runTurnText(conv, t.user, profile, { desk, model: choice.model });
      conv = r.conversation;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
    const priorVerdict = latestVerdict;
    for (const env of r?.envelopes ?? []) {
      if (env.tool === "build_plan" && env.ok) latestVerdict = (env.data as { verdict: string }).verdict;
    }
    const scored = scoreTurn(t.expect, r, { now: Date.now(), latestVerdict, priorVerdict });
    inputTokens += r?.usage.inputTokens ?? 0;
    outputTokens += r?.usage.outputTokens ?? 0;
    turns.push({
      user: t.user,
      ms: Date.now() - t0,
      error,
      toolCalls: (r?.toolCalls ?? []).map((x) => ({
        tool: x.tool as ToolName,
        input: x.input,
        tag: x.tag,
        ok: x.ok,
      })),
      resolved: (r?.envelopes ?? [])
        .filter((e) => e.tool === "price_options" || e.tool === "build_plan")
        .map((e) => ({
          tag: e.tag,
          ok: e.ok,
          intent: (e.data as { intent?: unknown } | undefined)?.intent ?? null,
          error: e.error?.message ?? null,
        })),
      verdict: latestVerdict,
      raw: r?.text ?? null,
      rendered: r?.rendered.text ?? null,
      flags: r?.rendered.flags ?? [],
      draftFlags: r?.draft?.flags ?? null,
      usage: r?.usage ?? null,
      checks: scored.checks,
      score: scored.score,
    });
    process.stdout.write(
      `${c.id} turn ${turns.length}: ${scored.score.toFixed(2)} ${scored.checks
        .filter((k) => !k.pass)
        .map((k) => k.name)
        .join(",")}\n`,
    );
  }
  const score = turns.reduce((a, t) => a + t.score, 0) / turns.length;
  results.push({
    id: c.id,
    kind: c.kind,
    profile: c.profile,
    score,
    strict: turns.every((t) => t.score === 1),
    turns,
  });
}

type R = {
  score: number;
  strict: boolean;
  kind: string;
  turns: {
    score: number;
    flags: unknown[];
    draftFlags: unknown[] | null;
    checks: { name: string; pass: boolean }[];
  }[];
};
const rs = results as R[];
const allTurns = rs.flatMap((r) => r.turns);
const byCheck: Record<string, { pass: number; total: number }> = {};
for (const t of allTurns)
  for (const k of t.checks) {
    const b = byCheck[k.name] ?? { pass: 0, total: 0 };
    byCheck[k.name] = b;
    b.total++;
    if (k.pass) b.pass++;
  }
const p = nyParts(started);
const out = {
  suite: spec.name,
  // Hash of the parsed cases (formatting-independent), so the registered key can be checked against any copy.
  casesSha256: createHash("sha256")
    .update(JSON.stringify(JSON.parse(raw)))
    .digest("hex"),
  ranAt: new Date(started).toISOString(),
  ranAtNy: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
  provider: choice.provider,
  model: choice.modelId,
  aborted,
  summary: {
    cases: rs.length,
    turns: allTurns.length,
    score: rs.reduce((a, r) => a + r.score, 0) / Math.max(1, rs.length),
    strictCases: rs.filter((r) => r.strict).length,
    strictTurns: allTurns.filter((t) => t.score === 1).length,
    turnsWithMaskedFigures: allTurns.filter((t) => t.flags.length > 0).length,
    turnsRewritten: allTurns.filter((t) => t.draftFlags !== null).length,
    byCheck,
    inputTokens,
    outputTokens,
    spentUsd: Number(spent().toFixed(4)),
    minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
  },
  results: rs,
};
writeFileSync(here("./lui-results.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out.summary, null, 2));
