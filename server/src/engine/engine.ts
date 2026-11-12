import { CARD_CATALOG, DECK_VERSION, canonicalDeck, cardOf } from "./cards";
import { RULES } from "./rules";
import { shuffle, type Rng } from "./rng";
import type {
  Catalog,
  DamageRecord,
  HealRecord,
  MatchState,
  PlayerState,
  Side,
  Status,
  StatusKind,
  TurnReport,
} from "./types";

export const SIDES: readonly Side[] = ["HUMAN", "AI"];
export const opponentOf = (s: Side): Side => (s === "HUMAN" ? "AI" : "HUMAN");

// ---------------------------------------------------------------- setup

function newPlayer(deck: string[]): PlayerState {
  return {
    hp: RULES.startingHp,
    energy: 0,
    block: 0,
    hand: deck.slice(0, RULES.startingHandSize),
    deck,
    drawIndex: RULES.startingHandSize,
    discard: [],
    statuses: [],
    lastDraw: null,
  };
}

export function createMatch(opts: {
  matchId: string;
  aiVersion: string;
  humanDeckRng: Rng;
  aiDeckRng: Rng;
  deck?: string[];
}): MatchState {
  const base = opts.deck ?? canonicalDeck();
  const state: MatchState = {
    matchId: opts.matchId,
    rulesVersion: RULES.version,
    deckVersion: DECK_VERSION,
    aiVersion: opts.aiVersion,
    turn: 1,
    phase: "PLANNING",
    players: {
      HUMAN: newPlayer(shuffle(base, opts.humanDeckRng)),
      AI: newPlayer(shuffle(base, opts.aiDeckRng)),
    },
    commits: {},
    history: [],
  };
  startPhase(state);
  return state;
}

/** Start phase: draw one card (subject to hand limit / empty deck), set energy. */
export function startPhase(state: MatchState): void {
  for (const side of SIDES) {
    const p = state.players[side];
    if (p.hand.length >= RULES.maxHandSize) p.lastDraw = "HAND_FULL";
    else if (p.drawIndex >= p.deck.length) p.lastDraw = "DECK_EMPTY";
    else {
      p.hand.push(p.deck[p.drawIndex++]);
      p.lastDraw = "DRAWN";
    }
    p.energy = RULES.energyPerTurn;
  }
  state.commits = {};
  state.phase = "PLANNING";
}

// ---------------------------------------------------------------- validation

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Validates a selection against authoritative state. Reasons only mention the submitter's own data. */
export function validateSelection(
  state: MatchState,
  side: Side,
  selection: unknown,
  catalog: Catalog = CARD_CATALOG,
): ValidationResult {
  if (state.phase !== "PLANNING") return { ok: false, reason: "Match is not accepting selections" };
  if (state.commits[side]) return { ok: false, reason: "Selection already locked for this turn" };
  if (!Array.isArray(selection) || !selection.every((x) => typeof x === "string")) {
    return { ok: false, reason: "Selection must be a list of card ids" };
  }
  if (selection.length > RULES.maxCardsPerTurn) {
    return { ok: false, reason: `You can play at most ${RULES.maxCardsPerTurn} cards` };
  }
  if (new Set(selection).size !== selection.length) return { ok: false, reason: "A card cannot be selected twice" };
  const p = state.players[side];
  if (!selection.every((uid) => p.hand.includes(uid))) return { ok: false, reason: "Selected card is not in your hand" };
  const cost = selection.reduce((sum, uid) => sum + cardOf(uid, catalog).cost, 0);
  if (cost > p.energy) return { ok: false, reason: `Not enough energy (${cost} > ${p.energy})` };
  return { ok: true };
}

/** Validates and locks a selection. Invalid submissions change nothing. */
export function commitSelection(
  state: MatchState,
  side: Side,
  selection: unknown,
  catalog: Catalog = CARD_CATALOG,
): ValidationResult {
  const v = validateSelection(state, side, selection, catalog);
  if (v.ok) state.commits[side] = [...(selection as string[])];
  return v;
}

export const bothCommitted = (state: MatchState): boolean =>
  SIDES.every((s) => state.commits[s] !== undefined);

// ---------------------------------------------------------------- resolution helpers

function hasStatus(p: PlayerState, kind: StatusKind): Status | undefined {
  return p.statuses.find((s) => s.kind === kind && s.remaining > 0);
}

/** Adds a status or refreshes an existing one (statuses never stack). */
function applyStatus(p: PlayerState, status: Status): void {
  const existing = p.statuses.find((s) => s.kind === status.kind);
  if (existing) {
    existing.remaining = Math.max(existing.remaining, status.remaining);
    existing.amount = status.amount;
  } else p.statuses.push({ ...status });
}

function heal(state: MatchState, report: TurnReport, target: Side, source: HealRecord["source"], amount: number) {
  const p = state.players[target];
  if (amount <= 0 || p.hp <= 0) return; // healing cannot revive (PROPOSED rule)
  const actual = Math.min(amount, RULES.maxHp - p.hp);
  p.hp += actual;
  report.heals.push({ target, source, amount: actual });
}

// ---------------------------------------------------------------- resolution

/**
 * Reveal + Resolution + End phase. Both commits must be locked. Resolves both sides
 * from the same pre-resolution snapshot; card order within a selection never matters.
 */
export function resolveTurn(state: MatchState, rng: Rng, catalog: Catalog = CARD_CATALOG): TurnReport {
  if (!bothCommitted(state)) throw new Error("Both selections must be locked before resolution");
  const commits = { HUMAN: state.commits.HUMAN!, AI: state.commits.AI! };

  // 1. Re-validate against the same pre-resolution state.
  for (const side of SIDES) {
    const saved = state.commits[side];
    state.commits[side] = undefined;
    const v = validateSelection(state, side, commits[side], catalog);
    state.commits[side] = saved;
    if (!v.ok) throw new Error(`Locked selection became invalid: ${v.reason}`);
  }

  const report: TurnReport = {
    turn: state.turn,
    played: { HUMAN: [...commits.HUMAN], AI: [...commits.AI] },
    blockGained: { HUMAN: 0, AI: 0 },
    discarded: { HUMAN: [], AI: [] },
    damage: [],
    heals: [],
    hpAfter: { HUMAN: 0, AI: 0 },
  };
  const defs = (side: Side) => commits[side].map((uid) => ({ uid, def: cardOf(uid, catalog) }));

  // 2. Consume cards and energy atomically.
  for (const side of SIDES) {
    const p = state.players[side];
    for (const { uid, def } of defs(side)) {
      p.hand.splice(p.hand.indexOf(uid), 1);
      p.discard.push(uid);
      p.energy -= def.cost;
    }
  }

  // 3. Defensive setup and temporary flags.
  for (const side of SIDES) {
    const p = state.players[side];
    for (const { def } of defs(side)) {
      const e = def.effect;
      if (e.kind === "GAIN_BLOCK") {
        p.block += e.amount;
        report.blockGained[side] += e.amount;
      } else if (e.kind === "UNBLOCKABLE_ATTACKS") applyStatus(p, { kind: "UNBLOCKABLE", remaining: e.duration });
      else if (e.kind === "REFLECT_DAMAGE") applyStatus(p, { kind: "REFLECT", remaining: e.duration });
      else if (e.kind === "LIFESTEAL") applyStatus(p, { kind: "LIFESTEAL", remaining: e.duration });
      else if (e.kind === "HEAL_OVER_TIME") {
        applyStatus(p, { kind: "REGENERATION", remaining: e.duration, amount: e.amountPerTurn });
      }
    }
  }

  // 4. Pre-damage utility: random discard from the opponent's remaining hand.
  //    Already-committed cards were consumed in step 2, so they cannot be invalidated.
  for (const side of SIDES) {
    const target = opponentOf(side);
    const tp = state.players[target];
    for (const { def } of defs(side)) {
      if (def.effect.kind !== "DISCARD_RANDOM") continue;
      for (let i = 0; i < def.effect.count && tp.hand.length > 0; i++) {
        const [uid] = tp.hand.splice(rng.int(tp.hand.length), 1);
        tp.discard.push(uid);
        report.discarded[target].push(uid);
      }
    }
  }

  // 5–7. Shared Attack damage pool per target; Block applied once to the pool.
  const cardDamage: DamageRecord[] = [];
  for (const target of SIDES) {
    const attacker = opponentOf(target);
    const attacks = defs(attacker).filter(({ def }) => def.type === "ATTACK");
    const raw = attacks.reduce(
      (sum, { def }) =>
        sum + (def.effect.kind === "DAMAGE" || def.effect.kind === "DAMAGE_AND_POISON" ? def.effect.amount : 0),
      0,
    );
    if (attacks.length > 0) {
      const unblockable = !!hasStatus(state.players[attacker], "UNBLOCKABLE");
      const absorbed = unblockable ? 0 : Math.min(state.players[target].block, raw);
      cardDamage.push({
        sourceCards: attacks.map((a) => a.uid),
        sourcePlayer: attacker,
        target,
        category: "ATTACK",
        raw,
        unblockable,
        absorbed,
        hpDamage: raw - absorbed,
      });
    }
    // Poison applies when the effect resolves, even if the damage was fully blocked.
    if (attacks.some(({ def }) => def.effect.kind === "DAMAGE_AND_POISON")) {
      applyStatus(state.players[target], {
        kind: "POISON",
        remaining: RULES.poison.duration,
        amount: RULES.poison.damagePerTick,
      });
    }
  }

  // 8. Spell damage bypasses Block.
  for (const target of SIDES) {
    const attacker = opponentOf(target);
    for (const { uid, def } of defs(attacker)) {
      if (def.type !== "SPELL" || def.effect.kind !== "DAMAGE") continue;
      const raw = def.effect.amount;
      cardDamage.push({ sourceCards: [uid], sourcePlayer: attacker, target, category: "SPELL", raw, unblockable: true, absorbed: 0, hpDamage: raw });
    }
  }
  for (const d of cardDamage) state.players[d.target].hp -= d.hpDamage;
  report.damage.push(...cardDamage);

  // 9. Damage triggers, computed from actual HP damage of card damage (snapshot above).
  for (const side of SIDES) {
    if (!hasStatus(state.players[side], "REFLECT")) continue;
    const taken = cardDamage.filter((d) => d.target === side).reduce((s, d) => s + d.hpDamage, 0);
    if (taken > 0) {
      const target = opponentOf(side);
      state.players[target].hp -= taken;
      report.damage.push({ sourceCards: [], sourcePlayer: side, target, category: "REFLECT", raw: taken, unblockable: true, absorbed: 0, hpDamage: taken });
    }
  }
  for (const side of SIDES) {
    if (!hasStatus(state.players[side], "LIFESTEAL")) continue;
    const dealt = cardDamage.filter((d) => d.sourcePlayer === side).reduce((s, d) => s + d.hpDamage, 0);
    heal(state, report, side, "LIFESTEAL", dealt);
  }

  // 10. Healing over time.
  for (const side of SIDES) {
    const regen = hasStatus(state.players[side], "REGENERATION");
    if (regen) heal(state, report, side, "REGENERATION", regen.amount ?? 0);
  }

  // 11. End-of-turn status damage (Poison bypasses Block).
  for (const side of SIDES) {
    const poison = hasStatus(state.players[side], "POISON");
    if (!poison) continue;
    const amount = poison.amount ?? 0;
    state.players[side].hp -= amount;
    report.damage.push({ sourceCards: [], sourcePlayer: opponentOf(side), target: side, category: "STATUS", raw: amount, unblockable: true, absorbed: 0, hpDamage: amount });
  }

  // 12. Expire Block and temporary effects.
  for (const side of SIDES) {
    const p = state.players[side];
    p.block = 0;
    for (const s of p.statuses) s.remaining--;
    p.statuses = p.statuses.filter((s) => s.remaining > 0);
  }

  // 13. Outcome.
  for (const side of SIDES) report.hpAfter[side] = state.players[side].hp;
  state.history.push(report);
  decideOutcome(state);
  if (state.phase !== "FINISHED") {
    state.turn++;
    startPhase(state);
  }
  return report;
}

function decideOutcome(state: MatchState): void {
  const h = state.players.HUMAN.hp;
  const a = state.players.AI.hp;
  let outcome: MatchState["outcome"];
  if (h <= 0 && a <= 0) outcome = "DRAW";
  else if (a <= 0) outcome = "HUMAN";
  else if (h <= 0) outcome = "AI";
  else if (state.turn >= RULES.maxTurns) {
    outcome = h > a ? "HUMAN" : a > h ? "AI" : "DRAW";
    state.endReason = "TURN_LIMIT";
  } else return;
  state.endReason ??= "HP";
  state.outcome = outcome;
  // A draw is recorded as DRAW but settled in the house's favour (spec §11).
  state.settlement = outcome === "HUMAN" ? "HUMAN_WIN" : "HUMAN_LOSS";
  state.phase = "FINISHED";
  state.commits = {};
}
