import type { CardDefinition, Status } from "../engine/types";

/**
 * Combo calculator: the best a hand can do NEXT turn within the energy budget,
 * counting synergies exactly like the engine (Unstoppable makes the pair's Attack
 * damage unblockable, Spell ignores Block, Lifesteal heals from it, Block stacks).
 */

export interface HandPotential {
  /** Max HP damage that ignores Block (Spell + unblockable Attack, incl. Unstoppable combos). */
  sureDamage: number;
  /** Max total damage if the opponent does not block. */
  rawDamage: number;
  /** Max Block one play can add. */
  maxBlock: number;
  /** Max healing one play can add (instant + one turn of regen + lifesteal on its own damage). */
  maxHeal: number;
}

export function pairsWithin<T extends { cost: number }>(cards: T[], energy: number, maxCards = 2): T[][] {
  const out: T[][] = [[]];
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].cost <= energy) out.push([cards[i]]);
    if (maxCards < 2) continue;
    for (let j = i + 1; j < cards.length; j++) if (cards[i].cost + cards[j].cost <= energy) out.push([cards[i], cards[j]]);
  }
  return out;
}

export function playValue(cards: CardDefinition[], statuses: Status[] = []) {
  const unstoppable = statuses.some((s) => s.kind === "UNBLOCKABLE") || cards.some((c) => c.effects.some((e) => e.kind === "UNBLOCKABLE_ATTACKS"));
  let blockable = 0;
  let sure = 0;
  let block = 0;
  let heal = 0;
  let lifesteal = statuses.some((s) => s.kind === "LIFESTEAL");
  for (const c of cards) {
    for (const e of c.effects) {
      if (e.kind === "DAMAGE") {
        if (c.type !== "ATTACK" || e.unblockable || unstoppable) sure += e.amount;
        else blockable += e.amount;
      } else if (e.kind === "GAIN_BLOCK") block += e.amount;
      else if (e.kind === "HEAL") heal += e.amount;
      else if (e.kind === "HEAL_OVER_TIME") heal += e.amountPerTurn;
      else if (e.kind === "LIFESTEAL") lifesteal = true;
    }
  }
  if (lifesteal) heal += sure + blockable;
  return { sure, raw: sure + blockable, block, heal };
}

export function handPotential(hand: CardDefinition[], energy: number, statuses: Status[] = []): HandPotential {
  const p: HandPotential = { sureDamage: 0, rawDamage: 0, maxBlock: 0, maxHeal: 0 };
  for (const play of pairsWithin(hand, energy)) {
    const v = playValue(play, statuses);
    p.sureDamage = Math.max(p.sureDamage, v.sure);
    p.rawDamage = Math.max(p.rawDamage, v.raw);
    p.maxBlock = Math.max(p.maxBlock, v.block);
    p.maxHeal = Math.max(p.maxHeal, v.heal);
  }
  return p;
}
