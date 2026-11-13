/**
 * The five LLM champions players can challenge. Picked from the top of OpenRouter's weekly
 * usage ranking (2026-11-13), one per vendor so the benchmark compares labs, not variants.
 * Prices are USD per million tokens, copied from https://openrouter.ai/api/v1/models —
 * only used for pre-call budget estimates; real cost comes from each response's `usage.cost`.
 */
export interface LlmModel {
  /** OpenRouter model id. */
  id: string;
  name: string;
  vendor: string;
  /** Vendor logo served by the web client (web/public/logos). */
  logo: string;
  inPerM: number;
  outPerM: number;
  /** Hard cap on completion tokens (reasoning included) per decision. */
  maxTokens: number;
  /** OpenRouter `reasoning` setting; default low effort. Some models ignore effort and need it off. */
  reasoning?: Record<string, unknown>;
}

export const LLM_MODELS: LlmModel[] = [
  { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", vendor: "DeepSeek", logo: "/logos/deepseek.png", inPerM: 0.3, outPerM: 1.2, maxTokens: 1500 },
  { id: "tencent/hy4", name: "Hy4", vendor: "Tencent", logo: "/logos/tencent.png", inPerM: 0.417, outPerM: 1.25, maxTokens: 1500, reasoning: { enabled: false } },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", vendor: "Z.ai", logo: "/logos/zai.png", inPerM: 0.04, outPerM: 0.078, maxTokens: 1500 },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", vendor: "OpenAI", logo: "/logos/openai.png", inPerM: 0.1, outPerM: 0.5, maxTokens: 1500 },
  // 10–40× pricier than the others: smallest output cap so one decision stays under ~2¢.
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", vendor: "Anthropic", logo: "/logos/anthropic.png", inPerM: 4, outPerM: 20, maxTokens: 800 },
];

export const LLM_VERSION_PREFIX = "llm:";
export const llmVersionOf = (m: LlmModel) => `${LLM_VERSION_PREFIX}${m.id}`;

export function modelByVersion(version: string): LlmModel | undefined {
  if (!version.startsWith(LLM_VERSION_PREFIX)) return undefined;
  const id = version.slice(LLM_VERSION_PREFIX.length);
  return LLM_MODELS.find((m) => m.id === id);
}

export function modelById(id: string): LlmModel | undefined {
  return LLM_MODELS.find((m) => m.id === id);
}

/** Worst-case USD for one call: the given prompt size plus the full completion cap. */
export function worstCaseCallUsd(m: LlmModel, promptTokens: number): number {
  return (promptTokens * m.inPerM + m.maxTokens * m.outPerM) / 1e6;
}
