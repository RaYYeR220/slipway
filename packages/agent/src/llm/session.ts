// Conversation state rebuilt from what the client sends back: every tool result is an envelope carrying its
// full data (for the UI), its tag-prefixed slots (for the renderer) and its sources. Signed plans are recovered
// from earlier build_plan envelopes, so the model only ever handles a plan id.
import type { Profile, SignedPlan, SourceRef } from "@slipway/core";
import type { Desk } from "../desk/service.js";
import { formatSlot, type Rendered, renderModelText, type Slot } from "../slots.js";

export const TOOL_PREFIX = {
  market_state: "mkt",
  research: "res",
  liquidity_tide: "tide",
  price_options: "opt",
  build_plan: "plan",
  issue_tickets: "tix",
  explain: "ex",
  track_record: "track",
  get_profile: "prof",
  propose_profile_update: "upd",
} as const;

export type ToolName = keyof typeof TOOL_PREFIX;

export interface ToolEnvelope<T = unknown> {
  tag: string;
  tool: ToolName;
  ok: boolean;
  data?: T;
  slots: Record<string, Slot>;
  sources: SourceRef[];
  error?: { code: string; message: string };
  callId?: string;
}

export const isEnvelope = (v: unknown): v is ToolEnvelope =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ToolEnvelope).tag === "string" &&
  typeof (v as ToolEnvelope).tool === "string" &&
  typeof (v as ToolEnvelope).slots === "object";

export class DeskSession {
  readonly artifacts: ToolEnvelope[] = [];
  readonly plans = new Map<string, SignedPlan>();
  private readonly counters = new Map<string, number>();

  constructor(
    readonly desk: Desk,
    public profile: Profile,
    history: readonly ToolEnvelope[] = [],
  ) {
    for (const e of history) this.record(e);
  }

  nextTag(tool: ToolName): string {
    const prefix = TOOL_PREFIX[tool];
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}${n}`;
  }

  record(e: ToolEnvelope): void {
    this.artifacts.push(e);
    const m = /^([a-z]+)(\d+)$/.exec(e.tag);
    if (m) this.counters.set(m[1] as string, Math.max(this.counters.get(m[1] as string) ?? 0, Number(m[2])));
    const plan = (e.data as { planId?: string; signedPlan?: SignedPlan } | undefined) ?? {};
    if (e.tool === "build_plan" && e.ok && plan.planId && plan.signedPlan)
      this.plans.set(plan.planId, plan.signedPlan);
  }

  slots(): Record<string, Slot> {
    return Object.assign({}, ...this.artifacts.map((a) => a.slots));
  }

  render(text: string): Rendered {
    return renderModelText(text, this.slots());
  }
}

/** Envelopes found in AI SDK UI messages (tool parts with an available output) or plain arrays of them. */
export function envelopesFrom(messages: readonly unknown[]): ToolEnvelope[] {
  const out: ToolEnvelope[] = [];
  for (const m of messages) {
    const parts = (m as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const output = (p as { output?: unknown; state?: string }).output;
      if (isEnvelope(output)) out.push(output);
    }
  }
  return out;
}

const NON_PASS = (slots: Record<string, Slot>, tag: string, code: string) =>
  slots[`${tag}.gate.${code}.status`]?.value !== "pass";

const MODEL_VIEW: Record<ToolName, (name: string, slots: Record<string, Slot>, tag: string) => boolean> = {
  price_options: (n, s, t) =>
    /^order\./.test(n) ||
    /^(best|baseline)\.(id|label|expectedBps|p10|p90|costUsd|starts|ends|slices|venues|sessions|violations)$/.test(
      n,
    ) ||
    /^best\.cost\./.test(n) ||
    /^(immediate|sliced|passive|wait|perp_then_rotate|perp_hold)\.(id|label|expectedBps|p10|p90|costUsd|starts|ends)$/.test(
      n,
    ) ||
    /^saving\./.test(n) ||
    n === "gate.verdict" ||
    (/^gate\.([A-Z_]+)\.(detail|fix)$/.test(n) && NON_PASS(s, t, n.split(".")[1] as string)) ||
    /^(candidates|feasible|skipped|lambda|urgency|costCap|atlas|basis|skipReason\d+|skipCount\d+|assumption\d+|error)$/.test(
      n,
    ),
  build_plan: (n, s, t) =>
    /^plan\.(planId|id|expires|arrivalMid|label|expectedBps|p10|p90|costUsd|starts|ends|slices|venues|sessions|violations)$/.test(
      n,
    ) ||
    /^plan\.cost\./.test(n) ||
    n === "gate.verdict" ||
    n === "gate.blocking" ||
    (/^gate\.([A-Z_]+)\.(detail|fix)$/.test(n) && NON_PASS(s, t, n.split(".")[1] as string)) ||
    /^order\.|^slice0\.|^sliceLast\.|^error$/.test(n),
  market_state: (n) => !/\.depth\.b(10|50)\.|\.bid$|\.ask$/.test(n) || /depth\.b25/.test(n),
  issue_tickets: () => true,
  liquidity_tide: (n) => !/\.(flowPerMin|samples)$/.test(n),
  research: () => true,
  explain: () => true,
  track_record: () => true,
  get_profile: () => true,
  propose_profile_update: () => true,
};

const MAX_VIEW_SLOTS = 90;

export interface ModelView {
  tag: string;
  tool: ToolName;
  ok: boolean;
  error?: string;
  planId?: string;
  unavailableSources?: string[];
  slots: Record<string, string>;
  more?: string;
}

/** What the model sees of a tool result: formatted slot values by name, the plan id it may pass back, no other figures. */
export function modelView(e: ToolEnvelope): ModelView {
  const view: ModelView = { tag: e.tag, tool: e.tool, ok: e.ok, slots: {} };
  if (e.error) view.error = e.error.message;
  const keep = MODEL_VIEW[e.tool];
  const prefix = `${e.tag}.`;
  let shown = 0;
  let hidden = 0;
  for (const [name, slot] of Object.entries(e.slots)) {
    const local = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!keep(local, e.slots, e.tag)) continue;
    if (shown >= MAX_VIEW_SLOTS) {
      hidden++;
      continue;
    }
    view.slots[name] = formatSlot(slot);
    shown++;
  }
  if (hidden) view.more = `${hidden} further slots omitted`;
  const d = e.data as Record<string, unknown> | undefined;
  if ((e.tool === "build_plan" || e.tool === "issue_tickets") && typeof d?.planId === "string")
    view.planId = d.planId;
  const down = [...new Set(e.sources.filter((s) => s.status === "unavailable").map((s) => s.id))];
  if (down.length) view.unavailableSources = down;
  return view;
}

export { formatSlot };
