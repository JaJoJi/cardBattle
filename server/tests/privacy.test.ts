import { describe, expect, it } from "vitest";
import { chooseCards } from "../src/ai/bot";
import { commitSelection, createMatch, resolveTurn } from "../src/engine/engine";
import { projectFor } from "../src/engine/projection";
import { createMatchRngs, createSeededRng, shuffle } from "../src/engine/rng";
import type { MatchState, PlayerView, Side } from "../src/engine/types";
import { makeState, rng } from "./helpers";

function newMatch(): MatchState {
  return createMatch({ matchId: "p1", aiVersion: "t", humanDeckRng: rng("h"), aiDeckRng: rng("a") });
}

/** Every opponent uid that must never appear in a viewer's payload. */
function forbiddenFor(state: MatchState, viewer: Side): string[] {
  const opp = state.players[viewer === "HUMAN" ? "AI" : "HUMAN"];
  const pending = state.commits[viewer === "HUMAN" ? "AI" : "HUMAN"] ?? [];
  const me = state.players[viewer];
  const ownUndrawn = me.deck.slice(me.drawIndex);
  // Both decks share uid names (e.g. "fortify#1"), so uids the viewer legitimately
  // holds are excluded — the check is that nothing *else* shows up.
  const visible = new Set([...me.hand, ...me.discard]);
  return [...opp.hand, ...opp.deck.slice(opp.drawIndex), ...pending, ...ownUndrawn].filter((u) => !visible.has(u));
}

function assertNoLeak(view: PlayerView, forbidden: string[]) {
  expect(forbidden.length).toBeGreaterThan(0);
  const json = JSON.stringify(view);
  for (const uid of forbidden) expect(json, `leaked ${uid}`).not.toContain(`"${uid}"`);
  expect(json).not.toMatch(/"deck"|"drawIndex"/);
}

describe("hidden information", () => {
  it("human view contains own hand but not the AI hand or any deck order", () => {
    const s = newMatch();
    const v = projectFor(s, "HUMAN");
    expect(v.self.hand.map((c) => c.uid)).toEqual(s.players.HUMAN.hand);
    expect(v.opponent).not.toHaveProperty("hand");
    assertNoLeak(v, forbiddenFor(s, "HUMAN"));
  });

  it("AI view contains own hand but not the human hand or any deck order", () => {
    const s = newMatch();
    const v = projectFor(s, "AI");
    expect(v.self.hand.map((c) => c.uid)).toEqual(s.players.AI.hand);
    assertNoLeak(v, forbiddenFor(s, "AI"));
  });

  it("opponent's locked selection is hidden until both commit (only a boolean is exposed)", () => {
    const s = newMatch();
    expect(commitSelection(s, "AI", [s.players.AI.hand.find((u) => !s.players.HUMAN.hand.includes(u))!]).ok).toBe(true);
    const v = projectFor(s, "HUMAN");
    expect(v.opponent.committed).toBe(true);
    assertNoLeak(v, forbiddenFor(s, "HUMAN"));
  });

  it("caster never learns which cards Disruption discarded", () => {
    const s = makeState({ hand: ["disruption#1"] }, { hand: ["fortify#1", "quick_strike#1", "meteor_impact#1"] });
    commitSelection(s, "HUMAN", ["disruption#1"]);
    commitSelection(s, "AI", []);
    const r = resolveTurn(s, rng());
    const human = projectFor(s, "HUMAN");
    expect(human.lastTurn!.opponentLostCount).toBe(2);
    for (const uid of r.discarded.AI) expect(JSON.stringify(human)).not.toContain(`"${uid}"`);
    const ai = projectFor(s, "AI");
    expect(ai.lastTurn!.youLost.map((c) => c.uid)).toEqual(r.discarded.AI);
  });

  it("only the caster sees which cards Arcane Insight drew", () => {
    const deck = Array.from({ length: 10 }, (_, i) => `heavy_strike#${i + 1}`);
    const s = makeState({ hand: ["arcane_insight#1"], deck }, {});
    commitSelection(s, "HUMAN", ["arcane_insight#1"]);
    commitSelection(s, "AI", []);
    const r = resolveTurn(s, rng());
    expect(projectFor(s, "HUMAN").lastTurn!.youDrew.map((c) => c.uid)).toEqual(r.drawn.HUMAN);
    const ai = projectFor(s, "AI");
    expect(ai.lastTurn!.opponentDrewCount).toBe(2);
    for (const uid of r.drawn.HUMAN) expect(JSON.stringify(ai)).not.toContain(`"${uid}"`);
  });

  it("played cards are revealed to both sides after resolution", () => {
    const s = makeState({ hand: ["quick_strike#1"] }, { hand: ["fortify#1"] });
    commitSelection(s, "HUMAN", ["quick_strike#1"]);
    commitSelection(s, "AI", ["fortify#1"]);
    resolveTurn(s, rng());
    expect(projectFor(s, "HUMAN").lastTurn!.played.AI.map((c) => c.uid)).toEqual(["fortify#1"]);
    expect(projectFor(s, "AI").lastTurn!.played.HUMAN.map((c) => c.uid)).toEqual(["quick_strike#1"]);
  });

  it("projections are copies — mutating a view cannot change match state", () => {
    const s = newMatch();
    const v = projectFor(s, "HUMAN");
    v.self.hand.pop();
    v.self.statuses.push({ kind: "POISON", remaining: 9 });
    expect(s.players.HUMAN.hand).toHaveLength(6);
    expect(s.players.HUMAN.statuses).toHaveLength(0);
  });

  it("AI decision only depends on its own projection (human hand changes don't affect it)", () => {
    const a = newMatch();
    const b = structuredClone(a);
    // Same hand size, completely different hidden contents.
    b.players.HUMAN.hand = a.players.HUMAN.hand.map(() => "meteor_impact#1");
    b.players.HUMAN.deck.reverse();
    const pickA = chooseCards(projectFor(a, "AI"), createSeededRng(Buffer.from("x")));
    const pickB = chooseCards(projectFor(b, "AI"), createSeededRng(Buffer.from("x")));
    expect(pickA).toEqual(pickB);
    expect(commitSelection(a, "AI", pickA).ok).toBe(true);
  });
});

describe("AI and deck-out", () => {
  it("never plays a draw spell that would deck itself out", () => {
    const s = makeState({}, { hand: ["arcane_insight#1"], deck: ["fortify#1", "fortify#2", "fortify#3"] });
    const pick = chooseCards(projectFor(s, "AI"), createSeededRng(Buffer.from("x")));
    expect(pick).not.toContain("arcane_insight#1");
  });
});

describe("randomness", () => {
  it("shuffle has no modulo bias / position bias (chi-square sanity)", () => {
    const r = createSeededRng(Buffer.from("bias"));
    const counts = Array.from({ length: 5 }, () => new Array(5).fill(0));
    const N = 20000;
    for (let i = 0; i < N; i++) shuffle([0, 1, 2, 3, 4], r).forEach((v, pos) => counts[v][pos]++);
    const expected = N / 5;
    let chi = 0;
    for (const row of counts) for (const c of row) chi += (c - expected) ** 2 / expected;
    expect(chi).toBeLessThan(50); // 16 dof; p≈1e-5 threshold
  });

  it("rng.int rejects invalid bounds and stays in range", () => {
    const r = createSeededRng(Buffer.from("x"));
    expect(() => r.int(0)).toThrow();
    for (let i = 0; i < 1000; i++) expect(r.int(7)).toBeLessThan(7);
  });

  it("randomness is bound to match id and versions", () => {
    const master = Buffer.alloc(32, 1);
    const deck = Array.from({ length: 20 }, (_, i) => i);
    const a = shuffle(deck, createMatchRngs("m1", { rules: "r1", deck: "d1" }, master).humanDeck);
    const b = shuffle(deck, createMatchRngs("m2", { rules: "r1", deck: "d1" }, master).humanDeck);
    const c = shuffle(deck, createMatchRngs("m1", { rules: "r2", deck: "d1" }, master).humanDeck);
    const a2 = shuffle(deck, createMatchRngs("m1", { rules: "r1", deck: "d1" }, master).humanDeck);
    expect(a).toEqual(a2);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("human and AI deck streams are independent", () => {
    const rngs = createMatchRngs("m1", { rules: "r1", deck: "d1" }, Buffer.alloc(32, 2));
    const deck = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(deck, rngs.humanDeck)).not.toEqual(shuffle(deck, rngs.aiDeck));
  });
});
