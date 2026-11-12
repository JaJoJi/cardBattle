// Gameplay constants. Values marked PROPOSED are not fixed by the spec and are
// documented in README.md ("Proposed defaults") so the product owner can change them.

export const RULES = {
  version: "rules-v1",
  startingHp: 40,
  maxHp: 40,
  startingHandSize: 5,
  maxHandSize: 7,
  energyPerTurn: 5,
  maxCardsPerTurn: 2,
  /** PROPOSED: Poison deals 1/tick for 3 End phases (incl. the turn applied); reapplying refreshes. */
  poison: { damagePerTick: 1, duration: 3 },
  /** A player whose draw pile has this many cards or fewer at the End phase loses. */
  deckOutThreshold: 1,
  /** Deck-building limits. */
  maxDeckSize: 60,
  maxCopiesPerCard: 2,
  /** PROPOSED: match ends after this turn; higher HP wins, equal HP is a DRAW. */
  maxTurns: 60,
  /** PROPOSED: human auto-passes when the planning timer expires. */
  planningTimeoutMs: 60_000,
} as const;
