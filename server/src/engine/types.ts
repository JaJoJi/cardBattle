// Pure type definitions shared by the server engine and (type-only) by the web client.
// Must not import any Node-specific modules.

export type Side = "HUMAN" | "AI";
export type CardType = "ATTACK" | "DEFENSE" | "SPELL";

export type CardEffect =
  /** ATTACK card: Attack damage (blockable unless `unblockable`). SPELL card: Spell damage (ignores Block). */
  | { kind: "DAMAGE"; amount: number; unblockable?: boolean }
  | { kind: "POISON" } // applies Poison (RULES.poison) to the opponent; never stacks
  | { kind: "GAIN_BLOCK"; amount: number }
  | { kind: "HEAL"; amount: number } // instant heal in the healing step
  | { kind: "HEAL_OVER_TIME"; amountPerTurn: number; duration: number }
  | { kind: "DISCARD_RANDOM"; count: number }
  | { kind: "DRAW_CARDS"; count: number }
  | { kind: "UNBLOCKABLE_ATTACKS"; duration: number }
  | { kind: "REFLECT_DAMAGE"; duration: number }
  | { kind: "LIFESTEAL"; duration: number };

export interface CardDefinition {
  id: string;
  name: string;
  type: CardType;
  cost: number;
  description: string;
  /** Resolved by the engine in its fixed phase order, never in list order. */
  effects: CardEffect[];
}

export type Catalog = Record<string, CardDefinition>;

export type StatusKind = "POISON" | "REGENERATION" | "UNBLOCKABLE" | "REFLECT" | "LIFESTEAL";

/**
 * `remaining` counts turns including the current one. Statuses are checked during
 * resolution and decremented in the End phase; at 0 they are removed.
 */
export interface Status {
  kind: StatusKind;
  remaining: number;
  amount?: number; // POISON: damage per tick, REGENERATION: heal per turn
}

export type DrawResult = "DRAWN" | "HAND_FULL" | "DECK_EMPTY";

/** Private, authoritative per-player state. Never sent to clients as-is. */
export interface PlayerState {
  hp: number;
  energy: number;
  block: number;
  hand: string[]; // card instance uids, e.g. "quick_strike#2"
  deck: string[]; // private shuffled permutation
  drawIndex: number; // private
  discard: string[];
  statuses: Status[];
  lastDraw: DrawResult | null;
}

export type DamageCategory = "ATTACK" | "SPELL" | "STATUS" | "REFLECT";

export interface DamageRecord {
  sourceCards: string[]; // instance uids (empty for status damage)
  sourcePlayer: Side;
  target: Side;
  category: DamageCategory;
  raw: number;
  unblockable: boolean;
  absorbed: number;
  hpDamage: number;
}

export interface HealRecord {
  target: Side;
  source: "LIFESTEAL" | "REGENERATION" | "CARD";
  amount: number; // actual HP restored (after cap)
}

/** Full, internal report of one resolved turn. Contains private discard identities. */
export interface TurnReport {
  turn: number;
  played: Record<Side, string[]>;
  blockGained: Record<Side, number>;
  discarded: Record<Side, string[]>; // cards discarded FROM that side's hand by opponent effects
  drawn: Record<Side, string[]>; // cards drawn by that side's own spells during resolution
  damage: DamageRecord[];
  heals: HealRecord[];
  hpAfter: Record<Side, number>;
}

export type Outcome = "HUMAN" | "AI" | "DRAW";
export type LossReason = "HP" | "DECK_OUT";
export type Settlement = "HUMAN_WIN" | "HUMAN_LOSS";

export interface MatchState {
  matchId: string;
  rulesVersion: string;
  deckVersion: string;
  aiVersion: string;
  turn: number;
  phase: "PLANNING" | "FINISHED";
  players: Record<Side, PlayerState>;
  commits: Partial<Record<Side, string[]>>;
  history: TurnReport[];
  outcome?: Outcome;
  settlement?: Settlement;
  endReason?: "DEFEAT" | "TURN_LIMIT";
  /** Why each side was defeated (empty = not defeated). Set when the match finishes by defeat. */
  lossReasons?: Record<Side, LossReason[]>;
}

// ---------- Projections (what a given identity is allowed to see) ----------

export interface CardView {
  uid: string;
  def: CardDefinition;
}

export interface TurnReportView {
  turn: number;
  played: Record<Side, CardView[]>;
  blockGained: Record<Side, number>;
  youLost: CardView[]; // your own cards discarded by the opponent (you already knew them)
  opponentLostCount: number; // identities of the opponent's discarded cards stay hidden
  youDrew: CardView[]; // cards your spells drew this turn
  opponentDrewCount: number; // only the count of the opponent's spell draws
  damage: DamageRecord[];
  heals: HealRecord[];
  hpAfter: Record<Side, number>;
}

export interface PlayerView {
  matchId: string;
  rulesVersion: string;
  deckVersion: string;
  aiVersion: string;
  you: Side;
  turn: number;
  phase: MatchState["phase"];
  maxHp: number;
  energyPerTurn: number;
  maxCardsPerTurn: number;
  maxTurns: number;
  deckOutThreshold: number;
  self: {
    hp: number;
    energy: number;
    hand: CardView[];
    deckRemaining: number;
    discardCount: number;
    statuses: Status[];
    lastDraw: DrawResult | null;
    committed: string[] | null;
  };
  opponent: {
    hp: number;
    handCount: number;
    deckRemaining: number;
    discardCount: number;
    statuses: Status[];
    lastDraw: DrawResult | null;
    committed: boolean; // only whether, never what
  };
  lastTurn: TurnReportView | null;
  outcome?: Outcome;
  settlement?: Settlement;
  endReason?: MatchState["endReason"];
  lossReasons?: MatchState["lossReasons"];
}
