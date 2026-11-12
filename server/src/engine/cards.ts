import type { CardDefinition, Catalog } from "./types";

// Prototype card values. Spell costs/durations are PROPOSED (see README).
const CARDS: CardDefinition[] = [
  // Attack
  { id: "quick_strike", name: "Quick Strike", type: "ATTACK", cost: 1, description: "Deal 2 Attack damage.", effect: { kind: "DAMAGE", amount: 2 } },
  { id: "heavy_strike", name: "Heavy Strike", type: "ATTACK", cost: 2, description: "Deal 4 Attack damage.", effect: { kind: "DAMAGE", amount: 4 } },
  { id: "meteor_impact", name: "Meteor Impact", type: "ATTACK", cost: 5, description: "Deal 20 Attack damage.", effect: { kind: "DAMAGE", amount: 20 } },
  { id: "venom_strike", name: "Venom Strike", type: "ATTACK", cost: 3, description: "Deal 1 Attack damage and apply Poison (1 per turn for 3 turns, refreshes, does not stack). Poison applies even if blocked.", effect: { kind: "DAMAGE_AND_POISON", amount: 1 } },
  // Defense
  { id: "basic_shield", name: "Basic Shield", type: "DEFENSE", cost: 1, description: "Gain 3 Block this turn. Block only stops Attack damage.", effect: { kind: "GAIN_BLOCK", amount: 3 } },
  { id: "fortify", name: "Fortify", type: "DEFENSE", cost: 2, description: "Gain 6 Block this turn. Block only stops Attack damage.", effect: { kind: "GAIN_BLOCK", amount: 6 } },
  { id: "arcane_barrier", name: "Arcane Barrier", type: "DEFENSE", cost: 3, description: "Gain 10 Block this turn. Block only stops Attack damage.", effect: { kind: "GAIN_BLOCK", amount: 10 } },
  { id: "divine_protection", name: "Divine Protection", type: "DEFENSE", cost: 5, description: "Gain 20 Block this turn. Block only stops Attack damage.", effect: { kind: "GAIN_BLOCK", amount: 20 } },
  // Spell
  { id: "arcane_bolt", name: "Arcane Bolt", type: "SPELL", cost: 3, description: "Deal 5 Spell damage. Ignores Block.", effect: { kind: "DAMAGE", amount: 5 } },
  { id: "regeneration", name: "Regeneration", type: "SPELL", cost: 2, description: "Heal 2 HP at the End phase of this turn and the next 2 turns.", effect: { kind: "HEAL_OVER_TIME", amountPerTurn: 2, duration: 3 } },
  { id: "disruption", name: "Disruption", type: "SPELL", cost: 3, description: "Opponent discards 2 random cards from their remaining hand (before damage). You don't see which.", effect: { kind: "DISCARD_RANDOM", count: 2 } },
  { id: "unstoppable", name: "Unstoppable", type: "SPELL", cost: 2, description: "Your Attack damage this turn cannot be blocked.", effect: { kind: "UNBLOCKABLE_ATTACKS", duration: 1 } },
  { id: "reflection", name: "Reflection", type: "SPELL", cost: 3, description: "This turn, HP damage you take from Attack and Spell cards is also dealt to the opponent. Reflected damage ignores Block and can't be reflected.", effect: { kind: "REFLECT_DAMAGE", duration: 1 } },
  { id: "lifesteal", name: "Lifesteal", type: "SPELL", cost: 2, description: "This turn and next turn, heal for the HP damage your Attack and Spell cards deal.", effect: { kind: "LIFESTEAL", duration: 2 } },
];

export const CARD_CATALOG: Catalog = Object.fromEntries(CARDS.map((c) => [c.id, c]));

export const DECK_VERSION = "deck-v1";

/** Canonical deck composition (20 cards), identical for both sides. PROPOSED. */
export const DECK_COMPOSITION: Record<string, number> = {
  quick_strike: 2,
  heavy_strike: 3,
  meteor_impact: 1,
  venom_strike: 2,
  basic_shield: 2,
  fortify: 2,
  arcane_barrier: 1,
  divine_protection: 1,
  arcane_bolt: 1,
  regeneration: 1,
  disruption: 1,
  unstoppable: 1,
  reflection: 1,
  lifesteal: 1,
};

/**
 * Card instance uids are assigned from the canonical (pre-shuffle) order, so a uid
 * never reveals a card's position in the shuffled deck.
 */
export function canonicalDeck(composition: Record<string, number> = DECK_COMPOSITION): string[] {
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
