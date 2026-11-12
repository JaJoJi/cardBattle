import type { Rng } from "../engine/rng";
import type { PlayerView } from "../engine/types";
import { AI_VERSION as HEURISTIC_VERSION, chooseCards } from "./bot";
import type { ObservedPlay } from "./memory";
import type { PatternStats } from "./patterns";
import { SEARCH_AI_VERSION, SearchAi } from "./search";

/** An AI opponent for one match. Fed its own projection each planning phase. */
export interface AiPlayer {
  readonly version: string;
  /** Update memory without choosing (used when replaying recorded turns). */
  observe(view: PlayerView): void;
  decide(view: PlayerView, rng: Rng): string[];
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
export const AI_VERSIONS = [SEARCH_AI_VERSION, HEURISTIC_VERSION] as const;

let defaultVersion: string = SEARCH_AI_VERSION;
/** Tests use the fast heuristic by default; production plays the strongest AI. */
export function setDefaultAiVersion(v: string) {
  if (!(AI_VERSIONS as readonly string[]).includes(v)) throw new Error(`Unknown AI version ${v}`);
  defaultVersion = v;
}
export const defaultAiVersion = () => defaultVersion;

export function createAi(version: string = defaultVersion, prior?: PatternStats): AiPlayer {
  if (version === SEARCH_AI_VERSION) return new SearchAi(prior);
  if (version === HEURISTIC_VERSION) return new HeuristicAi();
  throw new Error(`Unknown AI version ${version}`);
}
