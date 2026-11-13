import type { Rng } from "../engine/rng";
import type { PlayerView } from "../engine/types";
import { AI_VERSION as HEURISTIC_VERSION, chooseCards } from "./bot";
import type { ObservedPlay } from "./memory";
import type { PatternStats } from "./patterns";
import { SEARCH_AI_VERSION, SearchAi } from "./search";
import { LlmAi } from "./llm/llmAi";
import { LLM_MODELS, llmVersionOf, modelByVersion } from "./llm/models";

export interface AsyncDecision {
  cards: string[];
  /** Per-turn record (reason, cost, outcome) persisted with the match. */
  meta?: unknown;
}

/** An AI opponent for one match. Fed its own projection each planning phase. */
export interface AiPlayer {
  readonly version: string;
  /** Update memory without choosing (used when replaying recorded turns). */
  observe(view: PlayerView): void;
  decide(view: PlayerView, rng: Rng): string[];
  /** Present on players that think asynchronously (LLMs); sessions then use this instead of `decide`. */
  decideAsync?(view: PlayerView): Promise<AsyncDecision>;
  /** Revealed opponent decisions seen this match (for the per-player profile). */
  matchObservations(): ObservedPlay[];
}

class HeuristicAi implements AiPlayer {
  readonly version = HEURISTIC_VERSION;
  observe(): void {}
  decide(view: PlayerView, rng: Rng): string[] {
    return chooseCards(view, rng);
  }
  matchObservations(): ObservedPlay[] {
    return [];
  }
}

/** Every AI version a saved match may have been played with. */
export const AI_VERSIONS: readonly string[] = [SEARCH_AI_VERSION, HEURISTIC_VERSION, ...LLM_MODELS.map(llmVersionOf)];

let defaultVersion: string = SEARCH_AI_VERSION;
/** Tests use the fast heuristic by default; production plays the strongest AI. */
export function setDefaultAiVersion(v: string) {
  if (!AI_VERSIONS.includes(v)) throw new Error(`Unknown AI version ${v}`);
  defaultVersion = v;
}
export const defaultAiVersion = () => defaultVersion;

export function createAi(version: string = defaultVersion, prior?: PatternStats): AiPlayer {
  if (version === SEARCH_AI_VERSION) return new SearchAi(prior);
  if (version === HEURISTIC_VERSION) return new HeuristicAi();
  const llm = modelByVersion(version);
  if (llm) return new LlmAi(llm);
  throw new Error(`Unknown AI version ${version}`);
}
