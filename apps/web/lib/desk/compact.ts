// What the browser sends back to /api/chat. The server rebuilds the conversation from tool envelopes in the UI
// messages, but caps a request at 24,000 characters while a single price_options envelope is ~35,000. So before
// sending, each envelope is cut to what the server can still use: the slots the model was shown (same filter as
// the agent's modelView), unavailable sources, and the plan id / signed plan that issue_tickets needs. If the
// conversation is still over budget, the oldest tool results are dropped (the model keeps its own text).
import type { UIMessage } from "ai";
import type { Slot, ToolEnvelope, ToolName } from "./types";

export const CHAT_BUDGET = 23_000;
const MAX_MESSAGES = 24;
const MAX_VIEW_SLOTS = 90;

type Keep = (name: string, slots: Record<string, Slot>, tag: string) => boolean;

const nonPass = (slots: Record<string, Slot>, tag: string, code: string) =>
  slots[`${tag}.gate.${code}.status`]?.value !== "pass";

const MODEL_VIEW: Record<ToolName, Keep> = {
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
    (/^gate\.([A-Z_]+)\.(detail|fix)$/.test(n) && nonPass(s, t, n.split(".")[1] as string)) ||
    /^(candidates|feasible|skipped|lambda|urgency|costCap|atlas|basis|skipReason\d+|skipCount\d+|assumption\d+|error|unavailable)$/.test(
      n,
    ),
  build_plan: (n, s, t) =>
    /^plan\.(planId|id|expires|arrivalMid|label|expectedBps|p10|p90|costUsd|starts|ends|slices|venues|sessions|violations)$/.test(
      n,
    ) ||
    /^plan\.cost\./.test(n) ||
    n === "gate.verdict" ||
    n === "gate.blocking" ||
    (/^gate\.([A-Z_]+)\.(detail|fix)$/.test(n) && nonPass(s, t, n.split(".")[1] as string)) ||
    /^order\.|^slice0\.|^sliceLast\.|^error$|^unavailable$/.test(n),
  market_state: (n) => !/\.depth\.b(10|50)\.|\.bid$|\.ask$/.test(n) || /depth\.b25/.test(n),
  issue_tickets: () => true,
  liquidity_tide: (n) => !/\.(flowPerMin|samples)$/.test(n),
  research: () => true,
  explain: () => true,
  track_record: () => true,
  get_profile: () => true,
  propose_profile_update: () => true,
};

export const isEnvelope = (v: unknown): v is ToolEnvelope =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ToolEnvelope).tag === "string" &&
  typeof (v as ToolEnvelope).tool === "string" &&
  typeof (v as ToolEnvelope).slots === "object";

function viewSlots(e: ToolEnvelope): Record<string, Slot> {
  const keep = MODEL_VIEW[e.tool] ?? (() => true);
  const prefix = `${e.tag}.`;
  const out: Record<string, Slot> = {};
  let shown = 0;
  for (const [name, slot] of Object.entries(e.slots)) {
    const local = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!keep(local, e.slots, e.tag)) continue;
    if (shown >= MAX_VIEW_SLOTS) break;
    out[name] = slot;
    shown++;
  }
  return out;
}

function slimEnvelope(e: ToolEnvelope, keepSignedPlan: boolean): ToolEnvelope {
  const slim: ToolEnvelope = {
    tag: e.tag,
    tool: e.tool,
    ok: e.ok,
    slots: viewSlots(e),
    sources: e.sources.filter((s) => s.status === "unavailable"),
  };
  if (e.error) slim.error = e.error;
  if (e.callId) slim.callId = e.callId;
  const d = e.data as { planId?: unknown; signedPlan?: unknown } | undefined;
  if ((e.tool === "build_plan" || e.tool === "issue_tickets") && typeof d?.planId === "string") {
    slim.data =
      keepSignedPlan && d.signedPlan ? { planId: d.planId, signedPlan: d.signedPlan } : { planId: d.planId };
  }
  return slim;
}

type Part = UIMessage["parts"][number];

const isToolPart = (p: Part): p is Part & { toolCallId: string; output?: unknown; state: string } =>
  typeof p.type === "string" && p.type.startsWith("tool-") && "toolCallId" in p;

export function compactMessages(messages: UIMessage[], budget = CHAT_BUDGET): UIMessage[] {
  // The latest build_plan keeps its signed plan: issue_tickets needs it.
  let lastPlanCall: string | null = null;
  for (const m of messages)
    for (const p of m.parts)
      if (isToolPart(p) && isEnvelope(p.output) && p.output.tool === "build_plan" && p.output.ok)
        lastPlanCall = p.toolCallId;

  let out: UIMessage[] = messages.slice(-MAX_MESSAGES).map((m) => ({
    ...m,
    parts: m.parts
      .filter((p) => !(typeof p.type === "string" && p.type.startsWith("data-")))
      .map((p) => {
        if (!isToolPart(p) || !isEnvelope(p.output)) return p;
        return { ...p, output: slimEnvelope(p.output, p.toolCallId === lastPlanCall) } as Part;
      }),
  }));

  const size = () => JSON.stringify(out).length;
  // Over budget: drop tool results oldest first, never the latest signed plan, never the last user message.
  while (size() > budget) {
    let dropped = false;
    for (let i = 0; i < out.length - 1 && !dropped; i++) {
      const m = out[i] as UIMessage;
      const idx = m.parts.findIndex((p) => isToolPart(p) && p.toolCallId !== lastPlanCall);
      if (idx >= 0) {
        out = out.map((x, j) => (j === i ? { ...x, parts: x.parts.filter((_, k) => k !== idx) } : x));
        dropped = true;
      }
    }
    if (dropped) continue;
    // Still too big: drop the oldest whole message (keep at least the last one).
    if (out.length <= 1) break;
    out = out.slice(1);
  }
  return out;
}
