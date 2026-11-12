import type { CardDefinition } from "../engine/types";
import type { DecisionContext, ObservedPlay } from "./memory";

/**
 * Pattern memory: how often THIS opponent makes each kind of play in each kind of
 * situation. Learned from revealed plays only (public information), optionally seeded
 * with a frozen prior from the same wallet's earlier matches.
 */

export const PLAY_TRAITS = ["pass", "attack", "defense", "spell", "heal", "burst", "allIn"] as const;
export type Trait = (typeof PLAY_TRAITS)[number];

/** Situations are bucketed so a handful of observations already generalise. */
export function situation(ctx: DecisionContext): string {
  const hp = ctx.hp > 28 ? "high" : ctx.hp > 14 ? "mid" : "low";
  const hurt = ctx.tookDamage >= 8 ? "hurt" : "calm";
  const lead = ctx.hp - ctx.oppHp >= 8 ? "ahead" : ctx.oppHp - ctx.hp >= 8 ? "behind" : "even";
  return `${hp}|${hurt}|${lead}`;
}

export function traitsOf(cards: CardDefinition[]): Set<Trait> {
  const t = new Set<Trait>();
  if (cards.length === 0) t.add("pass");
  let dmg = 0;
  let cost = 0;
  for (const c of cards) {
    cost += c.cost;
    if (c.type === "ATTACK") t.add("attack");
    if (c.type === "DEFENSE") t.add("defense");
    if (c.type === "SPELL") t.add("spell");
    for (const e of c.effects) {
      if (e.kind === "DAMAGE") dmg += e.amount;
      if (e.kind === "HEAL" || e.kind === "HEAL_OVER_TIME" || e.kind === "LIFESTEAL") t.add("heal");
    }
  }
  if (dmg >= 9) t.add("burst");
  if (cost >= 5) t.add("allIn");
  return t;
}

/** Counts per situation bucket (plus a global "*" bucket). Plain JSON so it can be persisted. */
export interface PatternStats {
  version: 1;
  matches: number;
  buckets: Record<string, { n: number; traits: Partial<Record<Trait, number>> }>;
}

export const emptyStats = (): PatternStats => ({ version: 1, matches: 0, buckets: {} });

export function recordPlay(stats: PatternStats, play: ObservedPlay): void {
  for (const key of ["*", situation(play.ctx)]) {
    const b = (stats.buckets[key] ??= { n: 0, traits: {} });
    b.n++;
    for (const t of traitsOf(play.cards)) b.traits[t] = (b.traits[t] ?? 0) + 1;
  }
}

/** Population baseline (what an average player does), used for smoothing. */
const BASE_RATE: Record<Trait, number> = { pass: 0.08, attack: 0.6, defense: 0.35, spell: 0.35, heal: 0.15, burst: 0.25, allIn: 0.4 };
const PRIOR_WEIGHT = 4; // pseudo-observations

export class PatternModel {
  readonly stats: PatternStats;

  constructor(prior?: PatternStats) {
    this.stats = prior ? structuredClone(prior) : emptyStats();
  }

  learn(play: ObservedPlay): void {
    recordPlay(this.stats, play);
  }

  /** Smoothed rate of a trait in a situation: bucket → global → baseline. */
  rate(trait: Trait, ctx: DecisionContext): number {
    const global = this.stats.buckets["*"];
    const gRate = global ? ((global.traits[trait] ?? 0) + BASE_RATE[trait] * PRIOR_WEIGHT) / (global.n + PRIOR_WEIGHT) : BASE_RATE[trait];
    const b = this.stats.buckets[situation(ctx)];
    if (!b) return gRate;
    return ((b.traits[trait] ?? 0) + gRate * PRIOR_WEIGHT) / (b.n + PRIOR_WEIGHT);
  }

  /** How many opponent decisions back this model (match + prior). */
  get evidence(): number {
    return this.stats.buckets["*"]?.n ?? 0;
  }

  /**
   * Log-likelihood adjustment for a candidate play: plays matching traits this player
   * favours (relative to the average player) get boosted, and vice versa.
   */
  bias(cards: CardDefinition[], ctx: DecisionContext): number {
    const t = traitsOf(cards);
    let b = 0;
    for (const trait of PLAY_TRAITS) {
      const r = Math.min(0.98, Math.max(0.02, this.rate(trait, ctx)));
      const base = BASE_RATE[trait];
      b += t.has(trait) ? Math.log(r / base) : Math.log((1 - r) / (1 - base));
    }
    return b;
  }
}
