import { cardOf } from "../engine/cards";
import { resolveTurn } from "../engine/engine";

import { shuffle, type Rng } from "../engine/rng";
import type { CardDefinition, CardView, MatchState, PlayerState, PlayerView, Side } from "../engine/types";
import { scoreOption } from "./bot";
import { pairsWithin } from "./combos";
import { evaluate } from "./evaluate";
import { MatchMemory, type DecisionContext } from "./memory";
import { PatternModel, type PatternStats } from "./patterns";

export const SEARCH_AI_VERSION = "search-v3";

export interface SearchConfig {
  /** Sampled opponent hands ("possible worlds") per decision. */
  worlds: number;
  /** Most likely opponent plays kept per world. */
  oppPlays: number;
  /** Softness of the opponent's heuristic choice (higher = less predictable opponent). */
  temperature: number;
  /** Penalty on the bad tail: value = mean − riskAversion × (mean − worst 20%). */
  riskAversion: number;
  /** Weight of the learned per-player pattern bias in move prediction (0 = off). */
  patternWeight: number;
}

export const STRONG: SearchConfig = { worlds: 24, oppPlays: 6, temperature: 2, riskAversion: 0.5, patternWeight: 1 };

interface Cand {
  uids: string[];
  defs: CardDefinition[];
}

/**
 * search-v3: for every legal play, simulate the turn with the REAL engine against
 * sampled opponent hands (card counting) and the opponent's predicted plays (heuristic
 * prior × this player's learned patterns), then score the resulting positions.
 * Pair synergies and next-turn combo threats fall out of the simulation + evaluator.
 *
 * Fairness: everything comes from the AI's own projection — public state, its own hand,
 * revealed history. The real opponent hand and deck orders are never touched.
 * Determinism: same views + same RNG ⇒ same choice.
 */
export class SearchAi {
  readonly version = SEARCH_AI_VERSION;
  readonly memory = new MatchMemory();
  readonly patterns: PatternModel;
  private learned = 0;

  constructor(
    prior?: PatternStats,
    private readonly cfg: SearchConfig = STRONG,
  ) {
    this.patterns = new PatternModel(prior);
  }

  observe(view: PlayerView): void {
    this.memory.observe(view);
    for (; this.learned < this.memory.oppPlays.length; this.learned++) this.patterns.learn(this.memory.oppPlays[this.learned]);
  }

  /** Patterns learned in this match only (for the per-player profile). */
  matchObservations() {
    return this.memory.oppPlays;
  }

  decide(view: PlayerView, rng: Rng): string[] {
    this.observe(view);
    const me = view.you;
    const mine = legalPlays(view.self.hand, view.self.energy, view.maxCardsPerTurn);
    if (mine.length === 1) return [];

    const totals = mine.map(() => [] as number[]);
    const ctx: DecisionContext = {
      hp: view.opponent.hp,
      oppHp: view.self.hp,
      handCount: view.opponent.handCount,
      tookDamage: view.lastTurn ? view.lastTurn.damage.filter((d) => d.target !== me).reduce((s, d) => s + d.hpDamage, 0) : 0,
      oppStatuses: view.self.statuses.map((s) => s.kind),
    };

    for (let w = 0; w < this.cfg.worlds; w++) {
      const world = this.sampleWorld(view, rng);
      const oppSide: Side = me === "AI" ? "HUMAN" : "AI";
      const predicted = this.predictOpponent(view, world.players[oppSide].hand, ctx);
      for (let i = 0; i < mine.length; i++) {
        let ev = 0;
        for (const { play, p } of predicted) {
          const s = structuredClone(world);
          s.commits = { [me]: mine[i].uids, [oppSide]: play.uids };
          resolveTurn(s, rng);
          ev += p * evaluate(s, me);
        }
        totals[i].push(ev);
      }
    }

    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < mine.length; i++) {
      const xs = [...totals[i]].sort((a, b) => a - b);
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const tail = xs.slice(0, Math.max(1, Math.floor(xs.length * 0.2)));
      const worst = tail.reduce((s, x) => s + x, 0) / tail.length;
      // tiny deterministic jitter breaks exact ties without changing real preferences
      const score = mean - this.cfg.riskAversion * (mean - worst) + rng.int(1000) / 1e6;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return mine[best].uids;
  }

  /** Opponent's likely plays from a sampled hand: softmax(heuristic / T + learned pattern bias). */
  private predictOpponent(view: PlayerView, oppHand: string[], ctx: DecisionContext): { play: Cand; p: number }[] {
    const cards: CardView[] = oppHand.map((uid) => ({ uid, def: cardOf(uid) }));
    const oppView = mirrorView(view, cards);
    const plays = legalPlays(cards, view.energyPerTurn, view.maxCardsPerTurn);
    const logits = plays.map((pl) => scoreOption(oppView, pl.uids.map((uid, k) => ({ uid, def: pl.defs[k] }))) / this.cfg.temperature + this.cfg.patternWeight * this.patterns.bias(pl.defs, ctx));
    const max = Math.max(...logits);
    const weights = logits.map((l) => Math.exp(l - max));
    const ranked = plays.map((play, k) => ({ play, w: weights[k] })).sort((a, b) => b.w - a.w).slice(0, this.cfg.oppPlays);
    const sum = ranked.reduce((s, r) => s + r.w, 0);
    return ranked.map((r) => ({ play: r.play, p: r.w / sum }));
  }

  /**
   * One possible world consistent with everything the AI knows: its real hand, a sampled
   * opponent hand from the unrevealed pool, and shuffled remaining decks for both.
   */
  private sampleWorld(view: PlayerView, rng: Rng): MatchState {
    const me = view.you;
    const oppSide: Side = me === "AI" ? "HUMAN" : "AI";
    const oppPool = shuffle(expand(this.memory.oppUnknownPool(), "o"), rng);
    const oppHand = oppPool.slice(0, view.opponent.handCount);
    const oppDeck = oppPool.slice(view.opponent.handCount, view.opponent.handCount + view.opponent.deckRemaining);
    const myDeck = shuffle(expand(this.memory.ownDeckPool(view), "m"), rng).slice(0, view.self.deckRemaining);

    const player = (hp: number, energy: number, hand: string[], deck: string[], statuses: PlayerState["statuses"]): PlayerState => ({
      hp,
      energy,
      block: 0,
      hand,
      deck,
      drawIndex: 0,
      discard: [],
      statuses: statuses.map((s) => ({ ...s })),
      lastDraw: "DRAWN",
    });
    const players = {
      [me]: player(view.self.hp, view.self.energy, view.self.hand.map((c) => c.uid), myDeck, view.self.statuses),
      [oppSide]: player(view.opponent.hp, view.energyPerTurn, oppHand, oppDeck, view.opponent.statuses),
    } as MatchState["players"];
    return {
      matchId: view.matchId,
      rulesVersion: view.rulesVersion,
      deckVersion: view.deckVersion,
      aiVersion: view.aiVersion,
      turn: view.turn,
      phase: "PLANNING",
      players,
      commits: {},
      history: [],
    };
  }
}

function expand(pool: Record<string, number>, tag: string): string[] {
  const out: string[] = [];
  for (const [id, n] of Object.entries(pool)) for (let k = 0; k < n; k++) out.push(`${id}#${tag}${k}`);
  return out;
}

function legalPlays(hand: CardView[], energy: number, maxCards: number): Cand[] {
  return pairsWithin(
    hand.map((c) => ({ ...c, cost: c.def.cost })),
    energy,
    maxCards,
  ).map((p) => ({ uids: p.map((c) => c.uid), defs: p.map((c) => c.def) }));
}

/** The same table seen from the opponent's chair (with a sampled hand). */
function mirrorView(view: PlayerView, oppHand: CardView[]): PlayerView {
  return {
    ...view,
    you: view.you === "AI" ? "HUMAN" : "AI",
    self: {
      hp: view.opponent.hp,
      energy: view.energyPerTurn,
      hand: oppHand,
      deckRemaining: view.opponent.deckRemaining,
      discardCount: view.opponent.discardCount,
      statuses: view.opponent.statuses,
      lastDraw: view.opponent.lastDraw,
      committed: null,
    },
    opponent: {
      hp: view.self.hp,
      handCount: view.self.hand.length,
      deckRemaining: view.self.deckRemaining,
      discardCount: view.self.discardCount,
      statuses: view.self.statuses,
      lastDraw: view.self.lastDraw,
      committed: true,
    },
  };
}


