import { RULES } from "./rules";
import type { CardDefinition, Catalog } from "./types";

// Prototype card values — balance is untested. The original spec cards keep their
// spec values; everything else is PROPOSED (see README).
const POISON_TEXT = `Poison (${RULES.poison.damagePerTick}/turn for ${RULES.poison.duration} turns, refreshes, doesn't stack)`;

const CARDS: CardDefinition[] = [
  // ---------------------------------------------------------------- Attack (12)
  { id: "quick_strike", name: "Quick Strike", type: "ATTACK", cost: 1, description: "Deal 2 Attack damage.", effects: [{ kind: "DAMAGE", amount: 2 }] },
  { id: "heavy_strike", name: "Heavy Strike", type: "ATTACK", cost: 2, description: "Deal 4 Attack damage.", effects: [{ kind: "DAMAGE", amount: 4 }] },
  { id: "shield_bash", name: "Shield Bash", type: "ATTACK", cost: 2, description: "Deal 2 Attack damage. Gain 3 Block this turn.", effects: [{ kind: "DAMAGE", amount: 2 }, { kind: "GAIN_BLOCK", amount: 3 }] },
  { id: "piercing_arrow", name: "Piercing Arrow", type: "ATTACK", cost: 2, description: "Deal 3 Attack damage that cannot be blocked.", effects: [{ kind: "DAMAGE", amount: 3, unblockable: true }] },
  { id: "venom_strike", name: "Venom Strike", type: "ATTACK", cost: 3, description: `Deal 1 Attack damage and apply ${POISON_TEXT}. Poison applies even if blocked.`, effects: [{ kind: "DAMAGE", amount: 1 }, { kind: "POISON" }] },
  { id: "cleave", name: "Cleave", type: "ATTACK", cost: 3, description: "Deal 7 Attack damage.", effects: [{ kind: "DAMAGE", amount: 7 }] },
  { id: "rending_claw", name: "Rending Claw", type: "ATTACK", cost: 3, description: `Deal 4 Attack damage and apply ${POISON_TEXT}.`, effects: [{ kind: "DAMAGE", amount: 4 }, { kind: "POISON" }] },
  { id: "draining_bite", name: "Draining Bite", type: "ATTACK", cost: 3, description: "Deal 4 Attack damage. Heal 2 HP.", effects: [{ kind: "DAMAGE", amount: 4 }, { kind: "HEAL", amount: 2 }] },
  { id: "crushing_blow", name: "Crushing Blow", type: "ATTACK", cost: 4, description: "Deal 11 Attack damage.", effects: [{ kind: "DAMAGE", amount: 11 }] },
  { id: "phantom_lance", name: "Phantom Lance", type: "ATTACK", cost: 4, description: "Deal 7 Attack damage that cannot be blocked.", effects: [{ kind: "DAMAGE", amount: 7, unblockable: true }] },
  { id: "guillotine", name: "Guillotine", type: "ATTACK", cost: 5, description: "Deal 13 Attack damage that cannot be blocked.", effects: [{ kind: "DAMAGE", amount: 13, unblockable: true }] },
  { id: "meteor_impact", name: "Meteor Impact", type: "ATTACK", cost: 5, description: "Deal 20 Attack damage.", effects: [{ kind: "DAMAGE", amount: 20 }] },

  // ---------------------------------------------------------------- Defense (9)
  { id: "basic_shield", name: "Basic Shield", type: "DEFENSE", cost: 1, description: "Gain 3 Block this turn. Block only stops Attack damage.", effects: [{ kind: "GAIN_BLOCK", amount: 3 }] },
  { id: "bandage", name: "Bandage", type: "DEFENSE", cost: 1, description: "Gain 1 Block this turn. Heal 2 HP.", effects: [{ kind: "GAIN_BLOCK", amount: 1 }, { kind: "HEAL", amount: 2 }] },
  { id: "fortify", name: "Fortify", type: "DEFENSE", cost: 2, description: "Gain 6 Block this turn. Block only stops Attack damage.", effects: [{ kind: "GAIN_BLOCK", amount: 6 }] },
  { id: "tactical_retreat", name: "Tactical Retreat", type: "DEFENSE", cost: 2, description: "Gain 4 Block this turn. Draw 1 card.", effects: [{ kind: "GAIN_BLOCK", amount: 4 }, { kind: "DRAW_CARDS", count: 1 }] },
  { id: "arcane_barrier", name: "Arcane Barrier", type: "DEFENSE", cost: 3, description: "Gain 10 Block this turn. Block only stops Attack damage.", effects: [{ kind: "GAIN_BLOCK", amount: 10 }] },
  { id: "second_wind", name: "Second Wind", type: "DEFENSE", cost: 3, description: "Gain 5 Block this turn. Heal 4 HP.", effects: [{ kind: "GAIN_BLOCK", amount: 5 }, { kind: "HEAL", amount: 4 }] },
  { id: "iron_skin", name: "Iron Skin", type: "DEFENSE", cost: 4, description: "Gain 14 Block this turn. Block only stops Attack damage.", effects: [{ kind: "GAIN_BLOCK", amount: 14 }] },
  { id: "mirror_shield", name: "Mirror Shield", type: "DEFENSE", cost: 4, description: "Gain 6 Block this turn and reflect the HP damage you still take from cards.", effects: [{ kind: "GAIN_BLOCK", amount: 6 }, { kind: "REFLECT_DAMAGE", duration: 1 }] },
  { id: "divine_protection", name: "Divine Protection", type: "DEFENSE", cost: 5, description: "Gain 20 Block this turn. Block only stops Attack damage.", effects: [{ kind: "GAIN_BLOCK", amount: 20 }] },

  // ---------------------------------------------------------------- Spell (9)
  { id: "arcane_insight", name: "Arcane Insight", type: "SPELL", cost: 1, description: "Draw 2 cards (after Disruption resolves). Careful: 1 or fewer cards left in your deck at the End phase means defeat.", effects: [{ kind: "DRAW_CARDS", count: 2 }] },
  { id: "toxic_cloud", name: "Toxic Cloud", type: "SPELL", cost: 2, description: `Apply ${POISON_TEXT} to the opponent.`, effects: [{ kind: "POISON" }] },
  { id: "regeneration", name: "Regeneration", type: "SPELL", cost: 2, description: "Heal 2 HP at the End phase of this turn and the next 2 turns.", effects: [{ kind: "HEAL_OVER_TIME", amountPerTurn: 2, duration: 3 }] },
  { id: "unstoppable", name: "Unstoppable", type: "SPELL", cost: 2, description: "Your Attack damage this turn cannot be blocked.", effects: [{ kind: "UNBLOCKABLE_ATTACKS", duration: 1 }] },
  { id: "lifesteal", name: "Lifesteal", type: "SPELL", cost: 2, description: "This turn and next turn, heal for the HP damage your Attack and Spell cards deal.", effects: [{ kind: "LIFESTEAL", duration: 2 }] },
  { id: "arcane_bolt", name: "Arcane Bolt", type: "SPELL", cost: 3, description: "Deal 5 Spell damage. Ignores Block.", effects: [{ kind: "DAMAGE", amount: 5 }] },
  { id: "disruption", name: "Disruption", type: "SPELL", cost: 3, description: "Opponent discards 2 random cards from their remaining hand (before damage). You don't see which.", effects: [{ kind: "DISCARD_RANDOM", count: 2 }] },
  { id: "reflection", name: "Reflection", type: "SPELL", cost: 3, description: "This turn, HP damage you take from Attack and Spell cards is also dealt to the opponent. Reflected damage ignores Block and can't be reflected.", effects: [{ kind: "REFLECT_DAMAGE", duration: 1 }] },
  { id: "fireball", name: "Fireball", type: "SPELL", cost: 4, description: "Deal 9 Spell damage. Ignores Block.", effects: [{ kind: "DAMAGE", amount: 9 }] },
];

export const CARD_CATALOG: Catalog = Object.fromEntries(CARDS.map((c) => [c.id, c]));

export const DECK_VERSION = "deck-v3";

/** Canonical deck: every card ×2 = 60 cards, identical for both sides. */
export const DECK_COMPOSITION: Record<string, number> = Object.fromEntries(CARDS.map((c) => [c.id, 2]));

/** Deck-building rules: at most RULES.maxDeckSize cards, at most RULES.maxCopiesPerCard of any card. */
export function validateDeck(composition: Record<string, number>, catalog: Catalog = CARD_CATALOG): string[] {
  const errors: string[] = [];
  let total = 0;
  for (const [id, count] of Object.entries(composition)) {
    if (!catalog[id]) errors.push(`unknown card ${id}`);
    if (!Number.isInteger(count) || count < 1) errors.push(`${id}: invalid count ${count}`);
    if (count > RULES.maxCopiesPerCard) errors.push(`${id}: ${count} copies (max ${RULES.maxCopiesPerCard})`);
    total += count;
  }
  if (total > RULES.maxDeckSize) errors.push(`deck has ${total} cards (max ${RULES.maxDeckSize})`);
  return errors;
}

/**
 * Card instance uids are assigned from the canonical (pre-shuffle) order, so a uid
 * never reveals a card's position in the shuffled deck.
 */
export function canonicalDeck(composition: Record<string, number> = DECK_COMPOSITION): string[] {
  const errors = validateDeck(composition);
  if (errors.length) throw new Error(`Invalid deck: ${errors.join("; ")}`);
  const uids: string[] = [];
  for (const [defId, count] of Object.entries(composition)) {
    for (let n = 1; n <= count; n++) uids.push(`${defId}#${n}`);
  }
  return uids;
}

export function defIdOf(uid: string): string {
  return uid.split("#")[0];
}

export function cardOf(uid: string, catalog: Catalog = CARD_CATALOG): CardDefinition {
  const def = catalog[defIdOf(uid)];
  if (!def) throw new Error(`Unknown card ${uid}`);
  return def;
}
