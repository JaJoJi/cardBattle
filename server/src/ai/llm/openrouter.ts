import { worstCaseCallUsd, type LlmModel } from "./models";
import type { SpendGuard } from "./budget";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

export class BudgetExceededError extends Error {}

/** Minimal OpenRouter chat client. The key stays server-side; nothing player-written is ever sent. */
export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    readonly guard: SpendGuard,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  async chat(model: LlmModel, messages: ChatMessage[], schema: object, timeoutMs: number): Promise<ChatResult> {
    // ~4 chars per token is a deliberate over-estimate for this JSON-heavy prompt.
    const estPrompt = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5);
    const worst = worstCaseCallUsd(model, estPrompt);
    const settle = this.guard.reserve(worst);
    if (!settle) throw new BudgetExceededError(`LLM budget exhausted ($${this.guard.spentUsd.toFixed(2)} of $${this.guard.capUsd} spent)`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    let billed = worst; // unknown outcome (e.g. aborted mid-generation) is charged at worst case
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-title": "Card Battle Arena",
        },
        body: JSON.stringify({
          model: model.id,
          messages,
          max_tokens: model.maxTokens,
          reasoning: { effort: "low", exclude: true, ...model.reasoning },
          response_format: { type: "json_schema", json_schema: { name: "turn", strict: true, schema } },
          usage: { include: true },
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok || !body) {
        billed = 0; // rejected requests are not charged
        throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? "no body"}`.slice(0, 300));
      }
      billed = body.usage?.cost ?? worst;
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        costUsd: billed,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        ms: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
      settle(billed, model.id);
    }
  }
}
