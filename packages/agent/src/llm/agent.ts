// One conversational turn: streaming for the web route (AI SDK UI message stream), non-streaming for tests/eval.
// The model's text is rendered through the slot renderer; the authoritative numbers are the tool envelopes. A draft
// the renderer had to mask (typed figures, invented slot names) is sent back once with the reasons, and the
// rewrite replaces it; whatever remains masked is shown masked.
import type { Profile } from "@slipway/core";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type UIMessage,
} from "ai";
import { DEFAULT_PROFILE, ProfileSchema } from "../desk/schemas.js";
import { Desk } from "../desk/service.js";
import type { Rendered } from "../slots.js";
import { systemPrompt } from "./prompt.js";
import { chooseModel } from "./provider.js";
import { DeskSession, envelopesFrom, type ToolEnvelope, type ToolName } from "./session.js";
import { deskTools } from "./tools.js";

export interface AgentOptions {
  desk?: Desk;
  model?: LanguageModel;
  now?: () => number;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  temperature?: number;
  /** Send a masked draft back once for a rewrite (default true). */
  repair?: boolean;
}

let defaultDesk: Desk | null = null;
function deskOf(o: AgentOptions): Desk {
  if (o.desk) return o.desk;
  defaultDesk ??= new Desk();
  return defaultDesk;
}
const DEFAULT_STEPS = 6;

const sanitize = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/(Bearer\s+)[\w.-]+/gi, "$1***")
    .replace(/\b(sk|key)[-_][\w-]{8,}/gi, "***")
    .slice(0, 300);
};

const joinText = (steps: readonly { text: string }[]) =>
  steps
    .map((s) => s.text)
    .filter(Boolean)
    .join("\n\n");

/** The desk's feedback on a draft whose figures could not be shown; empty when nothing was masked. */
export function repairNote(r: Rendered): string {
  if (r.flags.length === 0) return "";
  const of = (...reasons: string[]) => [
    ...new Set(r.flags.filter((f) => reasons.includes(f.reason)).map((f) => f.raw)),
  ];
  const typed = of("numeral", "number-word");
  const unknown = of("unknown-slot", "bad-slot");
  const lines = ["[desk check] Your last reply could not be shown as written."];
  if (typed.length)
    lines.push(
      `Typed figures or number words were blanked: ${typed.join(", ")}. Use {{slot}} references for figures; for counts write "a single", "no", "a couple", "several"; for band ends say "low end" / "high end".`,
    );
  if (unknown.length)
    lines.push(
      `These slot names do not exist in any tool result of this conversation: ${unknown.join(", ")}. If you need those figures, call the tool now; otherwise cite only slot names you were given.`,
    );
  if (of("markup").length) lines.push("Markup was removed: plain text only.");
  lines.push("Rewrite the whole reply for the trader now, without mentioning this check.");
  return lines.join("\n");
}

/** Web route: AI SDK UI messages in, UI message stream out; a final `data-render` part carries the rendered text. */
export async function runTurn(
  input: { messages: UIMessage[]; profile?: Profile },
  opts: AgentOptions = {},
): Promise<Response> {
  const profile = ProfileSchema.parse(input.profile ?? DEFAULT_PROFILE);
  const session = new DeskSession(deskOf(opts), profile, envelopesFrom(input.messages));
  const tools = deskTools(session);
  const messages = await convertToModelMessages(input.messages, { tools, ignoreIncompleteToolCalls: true });
  const model = opts.model ?? chooseModel().model;
  const system = systemPrompt(profile, (opts.now ?? Date.now)());
  const call = (msgs: ModelMessage[]) =>
    streamText({
      model,
      system,
      messages: msgs,
      tools,
      stopWhen: isStepCount(opts.maxSteps ?? DEFAULT_STEPS),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const first = call(messages);
      for await (const chunk of first.toUIMessageStream({
        sendFinish: false,
        sendReasoning: false,
        onError: sanitize,
      }))
        writer.write(chunk);
      let rendered = session.render(joinText(await first.steps));
      const note = opts.repair === false ? "" : repairNote(rendered);
      if (note) {
        writer.write({ type: "data-repair", data: { flags: rendered.flags } } as never);
        const retry = call([
          ...messages,
          ...(await first.response).messages,
          { role: "user", content: note },
        ]);
        for await (const chunk of retry.toUIMessageStream({
          sendStart: false,
          sendFinish: false,
          sendReasoning: false,
          onError: sanitize,
        }))
          writer.write(chunk);
        rendered = session.render(joinText(await retry.steps));
      }
      writer.write({ type: "data-render", data: rendered } as never);
      writer.write({ type: "finish" } as never);
    },
    onError: sanitize,
  });
  return createUIMessageStreamResponse({ stream });
}

export interface Conversation {
  messages: ModelMessage[];
  envelopes: ToolEnvelope[];
}

export const emptyConversation = (): Conversation => ({ messages: [], envelopes: [] });

export interface TurnResult {
  text: string;
  rendered: Rendered;
  /** The masked first draft when a rewrite was requested, else null. */
  draft: Rendered | null;
  toolCalls: { tool: ToolName; input: Record<string, unknown>; tag: string | null; ok: boolean | null }[];
  envelopes: ToolEnvelope[];
  conversation: Conversation;
  usage: LanguageModelUsage;
  steps: number;
}

const addUsage = (a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage => ({
  ...a,
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
});

/** Tests/eval: one user turn against a conversation, without streaming. */
export async function runTurnText(
  conv: Conversation,
  userText: string,
  profile: Profile = DEFAULT_PROFILE,
  opts: AgentOptions = {},
): Promise<TurnResult> {
  const p = ProfileSchema.parse(profile);
  const session = new DeskSession(deskOf(opts), p, conv.envelopes);
  const before = session.artifacts.length;
  const tools = deskTools(session);
  const model = opts.model ?? chooseModel().model;
  const system = systemPrompt(p, (opts.now ?? Date.now)());
  const call = (msgs: ModelMessage[]) =>
    generateText({
      model,
      system,
      messages: msgs,
      tools,
      stopWhen: isStepCount(opts.maxSteps ?? DEFAULT_STEPS),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
  let messages: ModelMessage[] = [...conv.messages, { role: "user", content: userText }];
  let r = await call(messages);
  const runs = [r];
  let rendered = session.render(joinText(r.steps));
  let draft: Rendered | null = null;
  const note = opts.repair === false ? "" : repairNote(rendered);
  if (note) {
    draft = rendered;
    messages = [...messages, ...r.response.messages, { role: "user", content: note }];
    r = await call(messages);
    runs.push(r);
    rendered = session.render(joinText(r.steps));
  }
  const envelopes = session.artifacts.slice(before);
  const byCall = new Map(envelopes.map((e) => [e.callId, e]));
  const toolCalls = runs.flatMap((run) =>
    run.steps.flatMap((s) =>
      s.toolCalls.map((c) => {
        const env = byCall.get(c.toolCallId);
        return {
          tool: c.toolName as ToolName,
          input: (c.input ?? {}) as Record<string, unknown>,
          tag: env?.tag ?? null,
          ok: env?.ok ?? null,
        };
      }),
    ),
  );
  return {
    text: joinText(r.steps),
    rendered,
    draft,
    toolCalls,
    envelopes,
    conversation: {
      messages: [...messages, ...r.response.messages],
      envelopes: [...conv.envelopes, ...envelopes],
    },
    usage: runs.map((x) => x.totalUsage).reduce(addUsage),
    steps: runs.reduce((a, x) => a + x.steps.length, 0),
  };
}
