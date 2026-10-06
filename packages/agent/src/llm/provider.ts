// Model provider switch: Venice (default) or Alibaba DashScope international, both OpenAI-compatible.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ProviderName = "venice" | "dashscope";

export const PROVIDERS: Record<ProviderName, { baseURL: string; model: string; keyEnv: string }> = {
  venice: { baseURL: "https://api.venice.ai/api/v1", model: "qwen-3-8-max", keyEnv: "VENICE_API_KEY" },
  dashscope: {
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    keyEnv: "DASHSCOPE_API_KEY",
  },
};

export interface ModelChoice {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
}

/** SLIPWAY_LLM_PROVIDER picks the provider, SLIPWAY_LLM_MODEL overrides its model id. */
export function chooseModel(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): ModelChoice {
  const provider = (env.SLIPWAY_LLM_PROVIDER ?? "venice") as ProviderName;
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown SLIPWAY_LLM_PROVIDER "${provider}" (venice | dashscope)`);
  const apiKey = env[p.keyEnv];
  if (!apiKey) throw new Error(`${p.keyEnv} is not set`);
  const modelId = env.SLIPWAY_LLM_MODEL ?? p.model;
  const factory = createOpenAICompatible({
    name: provider,
    baseURL: p.baseURL,
    apiKey,
    includeUsage: true,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(provider === "venice"
      ? {
          transformRequestBody: (b: Record<string, unknown>) => ({
            ...b,
            venice_parameters: { include_venice_system_prompt: false },
          }),
        }
      : {}),
  });
  return { provider, modelId, model: factory.chatModel(modelId) };
}
