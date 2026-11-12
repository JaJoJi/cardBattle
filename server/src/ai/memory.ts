import { DECK_COMPOSITION } from "../engine/cards";
import type { CardDefinition, PlayerView, Status } from "../engine/types";

/**
 * Everything the AI remembers about a match. Built ONLY from the AI's own projections
 * (public state + its own hand + revealed turn reports), one call per planning phase.
 */

/** The public situation a player was in when they chose a play. */
export interface DecisionContext {
  hp: number; // the deciding player's HP
  oppHp: number;
  handCount: number;
  /** HP damage the deciding player took in the previous turn. */
  tookDamage: number;
  oppStatuses: string[];
}

export interface ObservedPlay {
  turn: number;
  ctx: DecisionContext;
  cards: CardDefinition[];
}

export class MatchMemory {
  /** Opponent cards revealed by being played, by card id. */
  readonly oppPlayed: Record<string, number> = {};
  /** The AI's own cards gone from its deck/hand cycle: played or discarded by the opponent. */
  readonly ownGone: Record<string, number> = {};
  /** Every revealed opponent decision with its context (feeds the pattern model). */
  readonly oppPlays: ObservedPlay[] = [];
  private lastTurnSeen = 0;
  private pendingCtx: DecisionContext | null = null;

  /** Feed the AI's view at the start of each planning phase. Idempotent per turn. */
  observe(view: PlayerView): void {
    const last = view.lastTurn;
    if (last && last.turn > this.lastTurnSeen) {
      this.lastTurnSeen = last.turn;
      const me = view.you;
      const opp = me === "AI" ? "HUMAN" : "AI";
      const oppCards = last.played[opp].map((c) => c.def);
      for (const d of oppCards) this.oppPlayed[d.id] = (this.oppPlayed[d.id] ?? 0) + 1;
      for (const c of last.played[me]) this.ownGone[c.def.id] = (this.ownGone[c.def.id] ?? 0) + 1;
      for (const c of last.youLost) this.ownGone[c.def.id] = (this.ownGone[c.def.id] ?? 0) + 1;
      if (this.pendingCtx) this.oppPlays.push({ turn: last.turn, ctx: this.pendingCtx, cards: oppCards });
    }
    // Context of the decision the opponent is about to make this turn.
    const tookDamage = last ? last.damage.filter((d) => d.target !== view.you).reduce((s, d) => s + d.hpDamage, 0) : 0;
    this.pendingCtx = {
      hp: view.opponent.hp,
      oppHp: view.self.hp,
      handCount: view.opponent.handCount,
      tookDamage,
      oppStatuses: view.self.statuses.map((s: Status) => s.kind),
    };
  }

  /** Multiset of cards the opponent might hold or still draw (deck list minus what they revealed). */
  oppUnknownPool(): Record<string, number> {
    const pool: Record<string, number> = {};
    for (const [id, n] of Object.entries(DECK_COMPOSITION)) {
      const left = n - (this.oppPlayed[id] ?? 0);
      if (left > 0) pool[id] = left;
    }
    return pool;
  }

  /** Multiset of the AI's own undrawn deck (deck list minus hand minus cards gone). */
  ownDeckPool(view: PlayerView): Record<string, number> {
    const pool: Record<string, number> = { ...DECK_COMPOSITION };
    for (const c of view.self.hand) pool[c.def.id] = (pool[c.def.id] ?? 0) - 1;
    for (const [id, n] of Object.entries(this.ownGone)) pool[id] = (pool[id] ?? 0) - n;
    for (const id of Object.keys(pool)) if (pool[id] <= 0) delete pool[id];
    return pool;
  }
}
