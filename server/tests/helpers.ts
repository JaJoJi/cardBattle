import { CARD_CATALOG } from "../src/engine/cards";
import { RULES } from "../src/engine/rules";
import { createSeededRng } from "../src/engine/rng";
import type { Catalog, MatchState, PlayerState, Status } from "../src/engine/types";

/** Real catalog plus test-only cards for exact spec examples. */
export const TEST_CATALOG: Catalog = {
  ...CARD_CATALOG,
  strike_8: { id: "strike_8", name: "Strike 8", type: "ATTACK", cost: 1, description: "", effect: { kind: "DAMAGE", amount: 8 } },
  strike_10: { id: "strike_10", name: "Strike 10", type: "ATTACK", cost: 1, description: "", effect: { kind: "DAMAGE", amount: 10 } },
  bolt_10: { id: "bolt_10", name: "Bolt 10", type: "SPELL", cost: 1, description: "", effect: { kind: "DAMAGE", amount: 10 } },
  bolt_5: { id: "bolt_5", name: "Bolt 5", type: "SPELL", cost: 1, description: "", effect: { kind: "DAMAGE", amount: 5 } },
  block_6: { id: "block_6", name: "Block 6", type: "DEFENSE", cost: 1, description: "", effect: { kind: "GAIN_BLOCK", amount: 6 } },
  block_15: { id: "block_15", name: "Block 15", type: "DEFENSE", cost: 1, description: "", effect: { kind: "GAIN_BLOCK", amount: 15 } },
};

interface PlayerSpec {
  hand?: string[];
  hp?: number;
  energy?: number;
  deck?: string[];
  statuses?: Status[];
}

function player(spec: PlayerSpec): PlayerState {
  return {
    hp: spec.hp ?? RULES.startingHp,
    energy: spec.energy ?? RULES.energyPerTurn,
    block: 0,
    hand: [...(spec.hand ?? [])],
    deck: [...(spec.deck ?? ["quick_strike#9"])],
    drawIndex: 0,
    discard: [],
    statuses: spec.statuses ?? [],
    lastDraw: "DRAWN",
  };
}

export function makeState(human: PlayerSpec = {}, ai: PlayerSpec = {}, turn = 1): MatchState {
  return {
    matchId: "test-match",
    rulesVersion: RULES.version,
    deckVersion: "test",
    aiVersion: "test",
    turn,
    phase: "PLANNING",
    players: { HUMAN: player(human), AI: player(ai) },
    commits: {},
    history: [],
  };
}

export const rng = (seed = "test") => createSeededRng(Buffer.from(seed));
