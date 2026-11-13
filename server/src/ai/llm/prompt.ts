import { CARD_CATALOG } from "../../engine/cards";
import { RULES } from "../../engine/rules";
import type { PlayerView, Side, TurnReportView } from "../../engine/types";

/**
 * Prompt for an LLM seat. Built ONLY from the seat's own PlayerView (the same hidden-information
 * projection the bot gets), so the model can never see the opponent's hand or any deck order.
 * No player-written text is ever included, which keeps prompt injection off the table.
 */

const catalog = Object.values(CARD_CATALOG)
  .map((c) => `- ${c.name} [${c.type}, cost ${c.cost}]: ${c.description}`)
  .join("\n");

/** Static, identical for every call (lets providers cache it). */
export const SYSTEM_PROMPT = `You are playing a 1v1 simultaneous-turn card battle. Goal: reduce the opponent to 0 HP (or have more HP when the match ends).

RULES
- Both players start at ${RULES.startingHp} HP (max ${RULES.maxHp}). Each turn both draw 1 card (skipped if hand is ${RULES.maxHandSize}) and get ${RULES.energyPerTurn} energy (unused energy is lost).
- Each turn you secretly choose 0, 1 or ${RULES.maxCardsPerTurn} cards from your hand with total cost <= your energy. Both choices are revealed and resolved at the same time — you never see the opponent's choice in advance.
- Block lasts only this turn and only reduces ATTACK damage: all incoming Attack damage this turn is summed, then Block is subtracted once. Spell damage, Poison and reflected damage ignore Block. "Unblockable" Attack damage skips Block.
- Resolution order: costs paid → Block/flags (Unstoppable, Reflection, Lifesteal, Regeneration) → Disruption discards from the remaining hand → card draws → Attack damage vs Block → Poison applied → Spell damage → Reflection, Lifesteal → heals → Poison ticks → Block/statuses expire.
- Poison: ${RULES.poison.damagePerTick} damage per turn for ${RULES.poison.duration} turns (reapplying refreshes, never stacks).
- You LOSE if your HP <= 0, or if your draw pile has ${RULES.deckOutThreshold} or fewer cards at the end of a turn (careful with card draw late in the game). Both defeated in the same turn = draw. After turn ${RULES.maxTurns}, higher HP wins.
- Both decks are the same 60 cards (each card below x2), shuffled separately. The opponent's hand is hidden; you know only its size.

CARDS
${catalog}

Reply with JSON only: {"cards": [card uids from YOUR hand, at most ${RULES.maxCardsPerTurn}], "reason": "one short sentence"}. An empty list passes the turn. Use the exact uids given (e.g. "fireball#2").`;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface TurnSummary {
  turn: number;
  you: string[];
  opponent: string[];
  damageToYou: number;
  damageToOpponent: number;
  hpAfter: { you: number; opponent: number };
  note?: string;
}

export function summarizeTurn(t: TurnReportView, you: Side): TurnSummary {
  const opp: Side = you === "AI" ? "HUMAN" : "AI";
  const notes: string[] = [];
  if (t.youLost.length) notes.push(`opponent's Disruption discarded your ${t.youLost.map((c) => c.def.name).join(", ")}`);
  if (t.opponentLostCount) notes.push(`opponent discarded ${t.opponentLostCount} unknown card(s)`);
  return {
    turn: t.turn,
    you: t.played[you].map((c) => c.def.name),
    opponent: t.played[opp].map((c) => c.def.name),
    damageToYou: sum(t.damage.filter((d) => d.target === you).map((d) => d.hpDamage)),
    damageToOpponent: sum(t.damage.filter((d) => d.target === opp).map((d) => d.hpDamage)),
    hpAfter: { you: t.hpAfter[you], opponent: t.hpAfter[opp] },
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

const statuses = (s: PlayerView["self"]["statuses"]) => s.map((x) => `${x.kind}(${x.remaining} turns${x.amount ? `, ${x.amount}/turn` : ""})`);

/** Per-turn message: current state + the last few public turns (oldest first). */
export function turnPrompt(view: PlayerView, history: TurnSummary[]): string {
  const state = {
    turn: view.turn,
    maxTurns: view.maxTurns,
    you: {
      hp: view.self.hp,
      energy: view.self.energy,
      deckRemaining: view.self.deckRemaining,
      statuses: statuses(view.self.statuses),
      hand: view.self.hand.map((c) => ({ uid: c.uid, name: c.def.name, type: c.def.type, cost: c.def.cost })),
    },
    opponent: {
      hp: view.opponent.hp,
      handSize: view.opponent.handCount,
      deckRemaining: view.opponent.deckRemaining,
      statuses: statuses(view.opponent.statuses),
    },
    previousTurns: history,
  };
  return `Current state:\n${JSON.stringify(state)}\n\nChoose your cards for turn ${view.turn}.`;
}

/** Structured-output schema; card ids are restricted to the uids in hand. */
export function turnSchema(view: PlayerView) {
  return {
    type: "object",
    properties: {
      cards: { type: "array", items: { type: "string", enum: view.self.hand.map((c) => c.uid) }, maxItems: view.maxCardsPerTurn },
      reason: { type: "string" },
    },
    required: ["cards", "reason"],
    additionalProperties: false,
  };
}

export type ParsedTurn = { ok: true; cards: string[]; reason: string } | { ok: false; error: string };

/** Parses and fully validates a reply against the view (the engine re-validates anyway). */
export function parseTurn(text: string, view: PlayerView): ParsedTurn {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/); // some models wrap JSON in prose or code fences
    if (!m) return { ok: false, error: "Reply was not JSON." };
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return { ok: false, error: "Reply was not valid JSON." };
    }
  }
  const o = obj as { cards?: unknown; reason?: unknown };
  if (!Array.isArray(o.cards) || !o.cards.every((c) => typeof c === "string")) return { ok: false, error: '"cards" must be a list of uids.' };
  const cards = o.cards as string[];
  const reason = typeof o.reason === "string" ? o.reason.slice(0, 280) : "";
  if (new Set(cards).size !== cards.length) return { ok: false, error: "The same card was listed twice." };
  if (cards.length > view.maxCardsPerTurn) return { ok: false, error: `At most ${view.maxCardsPerTurn} cards per turn.` };
  const hand = new Map(view.self.hand.map((c) => [c.uid, c]));
  const missing = cards.filter((c) => !hand.has(c));
  if (missing.length) return { ok: false, error: `Not in your hand: ${missing.join(", ")}.` };
  const cost = sum(cards.map((c) => hand.get(c)!.def.cost));
  if (cost > view.self.energy) return { ok: false, error: `Total cost ${cost} exceeds your energy ${view.self.energy}.` };
  return { ok: true, cards, reason };
}
