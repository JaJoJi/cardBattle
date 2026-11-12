import { RULES } from "../engine/rules";
import type { Rng } from "../engine/rng";
import type { CardView, PlayerView } from "../engine/types";

export const AI_VERSION = "heuristic-v2";

/**
 * Chooses 0–2 cards within the energy budget. Input is the AI's own projection
 * (public state + AI hand) — it has no access to the human hand or any deck order.
 * Deterministic for a fixed view and RNG stream; the RNG only breaks near-ties.
 */
export function chooseCards(view: PlayerView, rng: Rng): string[] {
  const hand = view.self.hand;
  const options: CardView[][] = [[]];
  for (let i = 0; i < hand.length; i++) {
    options.push([hand[i]]);
    for (let j = i + 1; j < hand.length; j++) options.push([hand[i], hand[j]]);
  }

  let best: CardView[] = [];
  let bestScore = -Infinity;
  for (const option of options) {
    if (option.length > view.maxCardsPerTurn) continue;
    if (option.reduce((s, c) => s + c.def.cost, 0) > view.self.energy) continue;
    const score = scoreOption(view, option) + rng.int(1000) / 4000; // ≤ 0.25 noise
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best.map((c) => c.uid);
}

function scoreOption(view: PlayerView, option: CardView[]): number {
  const { self, opponent } = view;
  // Rough threat estimate: the opponent can play up to 2 cards worth ~4 damage each,
  // or a big card. Lower own HP → value defence more.
  const expectedIncoming = Math.min(opponent.handCount, 2) * 4 + (self.hp <= 20 ? 6 : 0);
  const hasStatus = (kind: string, statuses = self.statuses) => statuses.some((s) => s.kind === kind);
  const all = option.flatMap(({ def }) => def.effects.map((e) => ({ def, e })));
  const unblockableAll = hasStatus("UNBLOCKABLE") || all.some(({ e }) => e.kind === "UNBLOCKABLE_ATTACKS");

  let attack = 0; // blockable Attack damage
  let attackUnblockable = 0;
  let spell = 0;
  let block = 0;
  let heal = 0;
  let draws = 0;
  let score = 0;
  for (const { def, e } of all) {
    switch (e.kind) {
      case "DAMAGE":
        if (def.type !== "ATTACK") spell += e.amount;
        else if (e.unblockable || unblockableAll) attackUnblockable += e.amount;
        else attack += e.amount;
        break;
      case "POISON":
        if (!hasStatus("POISON", opponent.statuses)) score += 2.5;
        break;
      case "GAIN_BLOCK":
        block += e.amount;
        break;
      case "HEAL":
        heal += e.amount;
        break;
      case "HEAL_OVER_TIME":
        heal += e.amountPerTurn * e.duration;
        break;
      case "DISCARD_RANDOM":
        score += Math.min(e.count, opponent.handCount) * 2;
        break;
      case "UNBLOCKABLE_ATTACKS":
        score += 0.5;
        break;
      case "REFLECT_DAMAGE":
        score += expectedIncoming * 0.4;
        break;
      case "LIFESTEAL":
        score += 1.5 + Math.min(attack + attackUnblockable + spell, view.maxHp - self.hp) * 0.4;
        break;
      case "DRAW_CARDS":
        draws += e.count;
        break;
    }
  }

  if (draws > 0) {
    // Drawing to the deck-out threshold loses at the End phase — never do it.
    const drawable = Math.max(0, Math.min(draws, RULES.maxHandSize - (self.hand.length - option.length)));
    if (self.deckRemaining - drawable <= view.deckOutThreshold) score -= 1000;
    else score += drawable * 1.2;
  }

  // Blockable Attack damage is discounted when the opponent could be blocking.
  score += attack * 0.75 + attackUnblockable + spell * 1.1;
  score += Math.min(block, expectedIncoming) * 0.85;
  score += Math.min(heal, view.maxHp - self.hp) * 0.8;

  // Lethal if unblocked: strongly prefer.
  if (attack + attackUnblockable + spell >= opponent.hp) score += 50;
  // Mild preference for spending energy efficiently.
  score -= option.reduce((s, c) => s + c.def.cost, 0) * 0.05;
  return score;
}
