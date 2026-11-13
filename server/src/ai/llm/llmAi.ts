import { config as loadEnv } from "dotenv";
import { ENV_PATH } from "../../chain/config";
import type { PlayerView } from "../../engine/types";
import type { AiPlayer, AsyncDecision } from "../index";
import type { ObservedPlay } from "../memory";
import { DEFAULT_BUDGET_USD, DEFAULT_DAILY_USD, SpendGuard } from "./budget";
import { llmVersionOf, type LlmModel } from "./models";
import { BudgetExceededError, OpenRouterClient, type ChatMessage } from "./openrouter";
import { SYSTEM_PROMPT, parseTurn, summarizeTurn, turnPrompt, turnSchema, type TurnSummary } from "./prompt";

/** Per-call limit; two attempts fit well inside the 60 s planning window. */
export const LLM_CALL_TIMEOUT_MS = 22_000;
const HISTORY_TURNS = 6;

export type DecisionOutcome = "ok" | "retried" | "illegal" | "timeout" | "budget" | "error" | "empty-hand";

export interface LlmTurnRecord {
  turn: number;
  cards: string[];
  reason: string;
  outcome: DecisionOutcome;
  costUsd: number;
  ms: number;
  calls: number;
}

let sharedClient: OpenRouterClient | null = null;

/** The process-wide client (reads OPENROUTER_API_KEY, falling back to API_KEY, from server/.env). */
export function llmClient(): OpenRouterClient | null {
  if (sharedClient) return sharedClient;
  loadEnv({ path: ENV_PATH, quiet: true });
  const key = process.env.OPENROUTER_API_KEY || process.env.API_KEY;
  if (!key) return null;
  const guard = new SpendGuard(
    Number(process.env.LLM_BUDGET_USD) || DEFAULT_BUDGET_USD,
    undefined,
    null,
    Number(process.env.LLM_DAILY_USD) || DEFAULT_DAILY_USD,
  );
  sharedClient = new OpenRouterClient(key, guard);
  return sharedClient;
}
/** Tests inject a fake-fetch client. */
export function setLlmClient(c: OpenRouterClient | null) {
  sharedClient = c;
}

/**
 * An LLM opponent. Sees only its own projection each turn. An illegal reply gets one retry
 * with the error explained; after that — or on timeout / API error / exhausted budget — the
 * seat passes. Bots never fill in, so the benchmark measures the model alone.
 */
export class LlmAi implements AiPlayer {
  readonly version: string;
  private readonly history: TurnSummary[] = [];
  private lastSeenTurn = 0;
  readonly turns: LlmTurnRecord[] = [];

  constructor(
    readonly model: LlmModel,
    private readonly client: OpenRouterClient | null = llmClient(),
  ) {
    this.version = llmVersionOf(model);
  }

  observe(view: PlayerView): void {
    const t = view.lastTurn;
    if (t && t.turn > this.lastSeenTurn) {
      this.lastSeenTurn = t.turn;
      this.history.push(summarizeTurn(t, view.you));
      if (this.history.length > HISTORY_TURNS) this.history.shift();
    }
  }

  /** Synchronous play is not possible for an LLM; sessions use `decideAsync`. */
  decide(): string[] {
    throw new Error("LlmAi only supports decideAsync");
  }

  async decideAsync(view: PlayerView): Promise<AsyncDecision> {
    this.observe(view);
    const rec = await this.choose(view);
    this.turns.push(rec);
    return { cards: rec.cards, meta: rec };
  }

  private async choose(view: PlayerView): Promise<LlmTurnRecord> {
    const rec: LlmTurnRecord = { turn: view.turn, cards: [], reason: "", outcome: "error", costUsd: 0, ms: 0, calls: 0 };
    if (view.self.hand.length === 0) return { ...rec, outcome: "empty-hand" };
    if (!this.client) return { ...rec, outcome: "error", reason: "No OpenRouter key configured" };
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: turnPrompt(view, this.history) },
    ];
    const schema = turnSchema(view);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rec.calls++;
        const r = await this.client.chat(this.model, messages, schema, LLM_CALL_TIMEOUT_MS);
        rec.costUsd += r.costUsd;
        rec.ms += r.ms;
        const parsed = parseTurn(r.text, view);
        if (parsed.ok) return { ...rec, cards: parsed.cards, reason: parsed.reason, outcome: attempt ? "retried" : "ok" };
        rec.outcome = "illegal";
        messages.push({ role: "assistant", content: r.text.slice(0, 2000) }, { role: "user", content: `Invalid move: ${parsed.error} Reply again with a legal JSON move.` });
      } catch (e) {
        if (e instanceof BudgetExceededError) return { ...rec, outcome: "budget", reason: e.message };
        const aborted = e instanceof Error && e.name === "AbortError";
        console.error(`[llm ${this.model.id}] ${aborted ? "timeout" : (e as Error).message}`);
        return { ...rec, outcome: aborted ? "timeout" : "error" };
      }
    }
    return rec; // two illegal replies → pass
  }

  matchObservations(): ObservedPlay[] {
    return [];
  }

  /** Aggregate for the benchmark / pricing (whole match). */
  matchStats() {
    const n = this.turns.length || 1;
    return {
      model: this.model.id,
      decisions: this.turns.length,
      costUsd: this.turns.reduce((s, t) => s + t.costUsd, 0),
      avgMs: Math.round(this.turns.reduce((s, t) => s + t.ms, 0) / n),
      illegal: this.turns.filter((t) => t.outcome === "illegal").length,
      failed: this.turns.filter((t) => ["timeout", "error", "budget"].includes(t.outcome)).length,
    };
  }
}
