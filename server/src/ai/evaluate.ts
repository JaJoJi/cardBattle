import { cardOf } from "../engine/cards";
import { deckRemaining, opponentOf } from "../engine/engine";
import { RULES } from "../engine/rules";
import type { MatchState, PlayerState, Side } from "../engine/types";
import { handPotential } from "./combos";

/**
 * Scores a (simulated) position for `me`. Terminal positions use the real settlement,
 * so for the house a draw is a win. Otherwise: HP race, pending status damage/healing,
 * and next-turn combo threats from both hands (lethal setups weigh heavily).
 */
export function evaluate(state: MatchState, me: Side): number {
  const opp = opponentOf(me);
  const P = state.players[me];
  const O = state.players[opp];

  if (state.phase === "FINISHED") {
    const iWin = me === "AI" ? state.settlement === "HUMAN_LOSS" : state.settlement === "HUMAN_WIN";
    return (iWin ? 1000 : -1000) + (P.hp - O.hp);
  }

  let v = P.hp - O.hp;
  // Being low is worse than the raw HP gap suggests.
  v -= Math.max(0, 14 - P.hp) * 1.2;
  v += Math.max(0, 14 - O.hp) * 0.8;
  v += statusValue(P) - statusValue(O);

  // Next-turn combo threats (the engine already dealt the next card at the Start phase).
  const myPot = handPotential(P.hand.map((u) => cardOf(u)), RULES.energyPerTurn, P.statuses);
  const opPot = handPotential(O.hand.map((u) => cardOf(u)), RULES.energyPerTurn, O.statuses);
  if (myPot.sureDamage >= O.hp) v += 35;
  else if (myPot.rawDamage >= O.hp) v += 12;
  if (opPot.sureDamage >= P.hp) v -= 45;
  else if (opPot.rawDamage >= P.hp + Math.min(myPot.maxBlock, opPot.rawDamage)) v -= 18;
  v += 0.25 * (myPot.rawDamage - opPot.rawDamage) + 0.15 * (myPot.maxBlock - opPot.maxBlock);

  // Card advantage and deck-out pressure.
  v += 1.2 * (P.hand.length - O.hand.length);
  if (deckRemaining(P) <= RULES.deckOutThreshold + 1) v -= 25;
  if (deckRemaining(O) <= RULES.deckOutThreshold + 1) v += 25;
  return v;
}

/** Future HP change from statuses on a player (positive = good for them). */
function statusValue(p: PlayerState): number {
  let v = 0;
  for (const s of p.statuses) {
    if (s.kind === "POISON") v -= (s.amount ?? 0) * s.remaining * 0.9;
    if (s.kind === "REGENERATION") v += (s.amount ?? 0) * s.remaining * 0.8;
    if (s.kind === "LIFESTEAL") v += 2;
  }
  return v;
}
