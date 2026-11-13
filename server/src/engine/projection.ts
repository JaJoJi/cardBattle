import { CARD_CATALOG, cardOf } from "./cards";
import { opponentOf } from "./engine";
import { RULES } from "./rules";
import type { Catalog, CardView, MatchState, PlayerView, Side, TurnReport, TurnReportView } from "./types";

/**
 * The ONLY way match state leaves the engine. Builds a fresh object containing
 * public state plus the viewer's own private data. Deck order, draw pointers, the
 * opponent's hand and the opponent's pending selection are never included.
 */
export function projectFor(state: MatchState, viewer: Side, catalog: Catalog = CARD_CATALOG): PlayerView {
  const view = (uid: string): CardView => ({ uid, def: cardOf(uid, catalog) });
  const me = state.players[viewer];
  const opp = state.players[opponentOf(viewer)];
  const last = state.history[state.history.length - 1];

  return {
    matchId: state.matchId,
    rulesVersion: state.rulesVersion,
    deckVersion: state.deckVersion,
    aiVersion: state.aiVersion,
    you: viewer,
    turn: state.turn,
    phase: state.phase,
    maxHp: RULES.maxHp,
    energyPerTurn: RULES.energyPerTurn,
    maxCardsPerTurn: RULES.maxCardsPerTurn,
    maxTurns: RULES.maxTurns,
    deckOutThreshold: RULES.deckOutThreshold,
    self: {
      hp: me.hp,
      energy: me.energy,
      hand: me.hand.map(view),
      deckRemaining: me.deck.length - me.drawIndex,
      discardCount: me.discard.length,
      statuses: me.statuses.map((s) => ({ ...s })),
      lastDraw: me.lastDraw,
      committed: state.commits[viewer] ? [...state.commits[viewer]!] : null,
    },
    opponent: {
      hp: opp.hp,
      handCount: opp.hand.length,
      deckRemaining: opp.deck.length - opp.drawIndex,
      discardCount: opp.discard.length,
      statuses: opp.statuses.map((s) => ({ ...s })),
      lastDraw: opp.lastDraw,
      committed: state.commits[opponentOf(viewer)] !== undefined,
    },
    lastTurn: last ? projectReport(last, viewer, view) : null,
    outcome: state.outcome,
    settlement: state.settlement,
    endReason: state.endReason,
    lossReasons: state.lossReasons ? { HUMAN: [...state.lossReasons.HUMAN], AI: [...state.lossReasons.AI] } : undefined,
  };
}

function projectReport(r: TurnReport, viewer: Side, view: (uid: string) => CardView): TurnReportView {
  return {
    turn: r.turn,
    played: { HUMAN: r.played.HUMAN.map(view), AI: r.played.AI.map(view) },
    blockGained: { ...r.blockGained },
    youLost: r.discarded[viewer].map(view),
    opponentLostCount: r.discarded[opponentOf(viewer)].length,
    youDrew: r.drawn[viewer].map(view),
    opponentDrewCount: r.drawn[opponentOf(viewer)].length,
    damage: r.damage.map((d) => ({ ...d, sourceCards: [...d.sourceCards] })),
    heals: r.heals.map((h) => ({ ...h })),
    hpBefore: { ...r.hpBefore },
    hpAfter: { ...r.hpAfter },
    // Statuses are public (both sides already see each other's statuses).
    statusesApplied: { HUMAN: r.statusesApplied.HUMAN.map((s) => ({ ...s })), AI: r.statusesApplied.AI.map((s) => ({ ...s })) },
    statusesAfter: { HUMAN: r.statusesAfter.HUMAN.map((s) => ({ ...s })), AI: r.statusesAfter.AI.map((s) => ({ ...s })) },
  };
}
