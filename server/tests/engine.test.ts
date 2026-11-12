import { describe, expect, it } from "vitest";
import { commitSelection, createMatch, resolveTurn } from "../src/engine/engine";
import { RULES } from "../src/engine/rules";
import type { MatchState, Side } from "../src/engine/types";
import { TEST_CATALOG, makeState, rng } from "./helpers";

function play(state: MatchState, human: string[], ai: string[]) {
  expect(commitSelection(state, "HUMAN", human, TEST_CATALOG)).toEqual({ ok: true });
  expect(commitSelection(state, "AI", ai, TEST_CATALOG)).toEqual({ ok: true });
  return resolveTurn(state, rng(), TEST_CATALOG);
}

const hp = (s: MatchState, side: Side) => s.players[side].hp;

describe("setup and turn rules", () => {
  const match = () => createMatch({ matchId: "m1", aiVersion: "t", humanDeckRng: rng("h"), aiDeckRng: rng("a") });

  it("both players start at 40 HP with 5 cards, then draw 1 on turn 1", () => {
    const s = match();
    for (const side of ["HUMAN", "AI"] as Side[]) {
      expect(s.players[side].hp).toBe(40);
      expect(s.players[side].hand).toHaveLength(RULES.startingHandSize + 1);
      expect(s.players[side].energy).toBe(5);
    }
  });

  it("each turn grants 5 energy (no carry-over) and one draw", () => {
    const s = match();
    play(s, [], []);
    expect(s.turn).toBe(2);
    expect(s.players.HUMAN.hand).toHaveLength(7);
    expect(s.players.HUMAN.energy).toBe(5);
  });

  it("hand never exceeds 7 — draw is skipped and reported", () => {
    const s = match();
    for (let i = 0; i < 4; i++) play(s, [], []);
    expect(s.players.HUMAN.hand).toHaveLength(7);
    expect(s.players.HUMAN.lastDraw).toBe("HAND_FULL");
  });

  it("empty deck skips the draw", () => {
    const s = makeState({ hand: [] , deck: [] });
    play(s, [], []);
    expect(s.players.HUMAN.lastDraw).toBe("DECK_EMPTY");
  });

  it("separate deck seeds produce independently shuffled decks of identical composition", () => {
    const s = match();
    expect(s.players.HUMAN.deck).not.toEqual(s.players.AI.deck);
    expect([...s.players.HUMAN.deck].sort()).toEqual([...s.players.AI.deck].sort());
  });
});

describe("selection validation", () => {
  const hand = ["quick_strike#1", "heavy_strike#1", "meteor_impact#1", "basic_shield#1"];

  it("rejects more than two cards", () => {
    const s = makeState({ hand });
    expect(commitSelection(s, "HUMAN", hand.slice(0, 3)).ok).toBe(false);
  });
  it("rejects spending more than 5 energy", () => {
    const s = makeState({ hand });
    expect(commitSelection(s, "HUMAN", ["meteor_impact#1", "quick_strike#1"]).ok).toBe(false);
  });
  it("rejects duplicates, unknown cards and cards not in hand", () => {
    const s = makeState({ hand });
    expect(commitSelection(s, "HUMAN", ["quick_strike#1", "quick_strike#1"]).ok).toBe(false);
    expect(commitSelection(s, "HUMAN", ["fortify#1"]).ok).toBe(false);
    expect(commitSelection(s, "HUMAN", ["nope"]).ok).toBe(false);
    expect(commitSelection(s, "HUMAN", "quick_strike#1").ok).toBe(false);
  });
  it("invalid submissions consume nothing", () => {
    const s = makeState({ hand });
    commitSelection(s, "HUMAN", ["meteor_impact#1", "quick_strike#1"]);
    expect(s.players.HUMAN.hand).toEqual(hand);
    expect(s.players.HUMAN.energy).toBe(5);
    expect(s.commits.HUMAN).toBeUndefined();
  });
  it("a locked selection cannot be changed", () => {
    const s = makeState({ hand });
    expect(commitSelection(s, "HUMAN", ["quick_strike#1"]).ok).toBe(true);
    expect(commitSelection(s, "HUMAN", ["heavy_strike#1"]).ok).toBe(false);
    expect(s.commits.HUMAN).toEqual(["quick_strike#1"]);
  });
  it("a player may pass", () => {
    const s = makeState({ hand });
    play(s, [], []);
    expect(hp(s, "HUMAN")).toBe(40);
    expect(hp(s, "AI")).toBe(40);
  });
  it("played cards and energy are consumed exactly once", () => {
    const s = makeState({ hand });
    play(s, ["quick_strike#1", "heavy_strike#1"], []);
    expect(s.players.HUMAN.hand).not.toContain("quick_strike#1");
    expect(s.players.HUMAN.discard).toEqual(["quick_strike#1", "heavy_strike#1"]);
  });
});

describe("damage and defense", () => {
  it("4 + 8 Attack vs 6 Block → 6 HP damage (shared pool)", () => {
    const s = makeState({ hand: ["heavy_strike#1", "strike_8#1"] }, { hand: ["block_6#1"] });
    const r = play(s, ["heavy_strike#1", "strike_8#1"], ["block_6#1"]);
    expect(hp(s, "AI")).toBe(34);
    expect(r.damage[0]).toMatchObject({ category: "ATTACK", raw: 12, absorbed: 6, hpDamage: 6 });
  });
  it("result is independent of card order", () => {
    const a = makeState({ hand: ["heavy_strike#1", "strike_8#1"] }, { hand: ["block_6#1"] });
    play(a, ["strike_8#1", "heavy_strike#1"], ["block_6#1"]);
    expect(hp(a, "AI")).toBe(34);
  });
  it("10 Attack vs 15 Block → 0 HP damage", () => {
    const s = makeState({ hand: ["strike_10#1"] }, { hand: ["block_15#1"] });
    play(s, ["strike_10#1"], ["block_15#1"]);
    expect(hp(s, "AI")).toBe(40);
  });
  it("10 Spell vs 6 Block → 10 HP damage", () => {
    const s = makeState({ hand: ["bolt_10#1"] }, { hand: ["block_6#1"] });
    play(s, ["bolt_10#1"], ["block_6#1"]);
    expect(hp(s, "AI")).toBe(30);
  });
  it("10 Attack + 5 Spell vs 6 Block → 9 HP damage", () => {
    const s = makeState({ hand: ["strike_10#1", "bolt_5#1"] }, { hand: ["block_6#1"] });
    play(s, ["strike_10#1", "bolt_5#1"], ["block_6#1"]);
    expect(hp(s, "AI")).toBe(31);
  });
  it("Poison applies even if the Attack is fully blocked, and its tick bypasses Block", () => {
    const s = makeState({ hand: ["venom_strike#1"] }, { hand: ["fortify#1"] });
    const r = play(s, ["venom_strike#1"], ["fortify#1"]);
    expect(r.damage.find((d) => d.category === "ATTACK")).toMatchObject({ raw: 1, absorbed: 1, hpDamage: 0 });
    expect(r.damage.find((d) => d.category === "STATUS")).toMatchObject({ hpDamage: 1 });
    expect(hp(s, "AI")).toBe(39);
    expect(s.players.AI.statuses.find((x) => x.kind === "POISON")?.remaining).toBe(RULES.poison.duration - 1);
  });
  it("Poison does not stack — reapplying refreshes duration", () => {
    const s = makeState({ hand: ["venom_strike#1", "venom_strike#2"], energy: 5 });
    play(s, ["venom_strike#1"], []);
    s.players.HUMAN.energy = 5;
    play(s, ["venom_strike#2"], []);
    const poisons = s.players.AI.statuses.filter((x) => x.kind === "POISON");
    expect(poisons).toHaveLength(1);
    expect(poisons[0].remaining).toBe(RULES.poison.duration - 1);
    expect(hp(s, "AI")).toBe(40 - 1 - 1 - 1 - 1); // 2 hits + 2 ticks
  });
  it("Poison expires after its duration", () => {
    const s = makeState({ hand: ["venom_strike#1"] });
    play(s, ["venom_strike#1"], []);
    for (let i = 0; i < 4; i++) play(s, [], []);
    expect(hp(s, "AI")).toBe(40 - 1 - RULES.poison.duration);
    expect(s.players.AI.statuses).toHaveLength(0);
  });
  it("unused Block expires at the end of the turn", () => {
    const s = makeState({ hand: ["quick_strike#1"] }, { hand: ["divine_protection#1"] });
    play(s, [], ["divine_protection#1"]);
    expect(s.players.AI.block).toBe(0);
    play(s, ["quick_strike#1"], []);
    expect(hp(s, "AI")).toBe(38);
  });
  it("Unblockable Attack damage bypasses Block", () => {
    const s = makeState({ hand: ["unstoppable#1", "heavy_strike#1"] }, { hand: ["divine_protection#1"] });
    const r = play(s, ["unstoppable#1", "heavy_strike#1"], ["divine_protection#1"]);
    expect(r.damage[0]).toMatchObject({ category: "ATTACK", unblockable: true, absorbed: 0, hpDamage: 4 });
    expect(hp(s, "AI")).toBe(36);
  });
  it("Lifesteal heals by actual HP damage, not raw or absorbed damage", () => {
    const s = makeState({ hand: ["lifesteal#1", "strike_10#1"], hp: 30 }, { hand: ["block_6#1"] });
    const r = play(s, ["lifesteal#1", "strike_10#1"], ["block_6#1"]);
    expect(hp(s, "AI")).toBe(36);
    expect(r.heals).toEqual([{ target: "HUMAN", source: "LIFESTEAL", amount: 4 }]);
    expect(hp(s, "HUMAN")).toBe(34);
  });
  it("Lifesteal lasts this turn and the next", () => {
    const s = makeState({ hand: ["lifesteal#1", "strike_10#1", "strike_10#2", "strike_10#3"], hp: 10 });
    play(s, ["lifesteal#1"], []);
    s.players.HUMAN.energy = 5;
    play(s, ["strike_10#1"], []);
    expect(hp(s, "HUMAN")).toBe(20);
    s.players.HUMAN.energy = 5;
    play(s, ["strike_10#2"], []);
    expect(hp(s, "HUMAN")).toBe(20);
  });
  it("Reflection returns actual HP damage taken from cards; not Block-able, not re-reflected", () => {
    const s = makeState(
      { hand: ["reflection#1", "basic_shield#1"] },
      { hand: ["reflection#1", "heavy_strike#1"] },
    );
    const r = play(s, ["reflection#1", "basic_shield#1"], ["reflection#1", "heavy_strike#1"]);
    // AI hits 4 into 3 Block → 1 HP damage to human; human reflects 1. AI reflection has nothing to reflect.
    expect(hp(s, "HUMAN")).toBe(39);
    expect(hp(s, "AI")).toBe(39);
    expect(r.damage.filter((d) => d.category === "REFLECT")).toHaveLength(1);
  });
  it("Reflection does not reflect Poison", () => {
    const s = makeState({ hand: ["reflection#1"], statuses: [{ kind: "POISON", remaining: 2, amount: 1 }] });
    play(s, ["reflection#1"], []);
    expect(hp(s, "AI")).toBe(40);
  });
  it("healing cannot raise HP above 40", () => {
    const s = makeState({ hand: ["regeneration#1"], hp: 39 });
    const r = play(s, ["regeneration#1"], []);
    expect(hp(s, "HUMAN")).toBe(40);
    expect(r.heals[0].amount).toBe(1);
  });
  it("Regeneration heals for its full duration", () => {
    const s = makeState({ hand: ["regeneration#1"], hp: 20 });
    play(s, ["regeneration#1"], []);
    play(s, [], []);
    play(s, [], []);
    play(s, [], []);
    expect(hp(s, "HUMAN")).toBe(26);
  });
  it("healing cannot revive a player at 0 HP", () => {
    const s = makeState({ hand: ["regeneration#1"], hp: 4 }, { hand: ["heavy_strike#1"] });
    play(s, ["regeneration#1"], ["heavy_strike#1"]);
    expect(hp(s, "HUMAN")).toBe(0);
    expect(s.outcome).toBe("AI");
  });
  it("Disruption discards random cards from the opponent's remaining hand, never committed ones", () => {
    const s = makeState({ hand: ["disruption#1"] }, { hand: ["heavy_strike#1", "fortify#1", "quick_strike#1"] });
    const r = play(s, ["disruption#1"], ["heavy_strike#1"]);
    expect(hp(s, "HUMAN")).toBe(36); // committed attack still resolves
    expect(r.discarded.AI).toHaveLength(2);
    expect(r.discarded.AI).not.toContain("heavy_strike#1");
    // only the turn draw remains
    expect(s.players.AI.hand).toHaveLength(1);
  });
  it("Disruption discards all available if fewer remain", () => {
    const s = makeState({ hand: ["disruption#1"] }, { hand: ["fortify#1"] });
    const r = play(s, ["disruption#1"], []);
    expect(r.discarded.AI).toEqual(["fortify#1"]);
  });
});

describe("simultaneous actions and outcomes", () => {
  it("one player's lethal damage does not cancel the opponent's committed effects", () => {
    const s = makeState({ hand: ["meteor_impact#1"], hp: 10 }, { hand: ["meteor_impact#1"], hp: 10 });
    play(s, ["meteor_impact#1"], ["meteor_impact#1"]);
    expect(hp(s, "HUMAN")).toBeLessThanOrEqual(0);
    expect(hp(s, "AI")).toBeLessThanOrEqual(0);
  });
  it("both at 0 HP → internal DRAW, settled as a human loss", () => {
    const s = makeState({ hand: ["meteor_impact#1"], hp: 10 }, { hand: ["meteor_impact#1"], hp: 10 });
    play(s, ["meteor_impact#1"], ["meteor_impact#1"]);
    expect(s.outcome).toBe("DRAW");
    expect(s.settlement).toBe("HUMAN_LOSS");
    expect(s.phase).toBe("FINISHED");
  });
  it("Poison at End phase can cause a draw after card damage", () => {
    const s = makeState(
      { hand: ["heavy_strike#1"], hp: 1, statuses: [{ kind: "POISON", remaining: 2, amount: 1 }] },
      { hand: [], hp: 4 },
    );
    play(s, ["heavy_strike#1"], []);
    expect(s.outcome).toBe("DRAW");
  });
  it("a single surviving player wins", () => {
    const s = makeState({ hand: ["meteor_impact#1"] }, { hp: 20 });
    play(s, ["meteor_impact#1"], []);
    expect(s.outcome).toBe("HUMAN");
    expect(s.settlement).toBe("HUMAN_WIN");
  });
  it("turn limit: higher HP wins", () => {
    const s = makeState({ hand: ["quick_strike#1"] }, {}, RULES.maxTurns);
    play(s, ["quick_strike#1"], []);
    expect(s.outcome).toBe("HUMAN");
    expect(s.endReason).toBe("TURN_LIMIT");
  });
  it("no further selections are accepted after the match ends", () => {
    const s = makeState({ hand: ["meteor_impact#1", "quick_strike#1"] }, { hp: 20 });
    play(s, ["meteor_impact#1"], []);
    expect(commitSelection(s, "HUMAN", ["quick_strike#1"]).ok).toBe(false);
  });
});
