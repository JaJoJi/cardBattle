import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { CARD_CATALOG } from "../src/engine/cards";
import { createMatch } from "../src/engine/engine";
import { projectFor } from "../src/engine/projection";
import { createSeededRng } from "../src/engine/rng";
import { evaluate } from "../src/ai/evaluate";
import { PatternModel } from "../src/ai/patterns";
import { ProfileStore } from "../src/ai/profiles";
import { SearchAi } from "../src/ai/search";
import { handPotential } from "../src/ai/combos";
import { MatchSession } from "../src/session";
import { makeState } from "./helpers";

const rng = (s = "t") => createSeededRng(Buffer.from(s));
const def = (id: string) => CARD_CATALOG[id];

describe("search-v3: fairness and determinism", () => {
  it("its choice does not depend on the human's hidden hand or deck order", () => {
    const a = createMatch({ matchId: "fair", aiVersion: "search-v3", humanDeckRng: rng("h"), aiDeckRng: rng("a") });
    const b = structuredClone(a);
    b.players.HUMAN.hand = a.players.HUMAN.hand.map(() => "meteor_impact#1");
    b.players.HUMAN.deck.reverse();
    const pa = new SearchAi().decide(projectFor(a, "AI"), rng("x"));
    const pb = new SearchAi().decide(projectFor(b, "AI"), rng("x"));
    expect(pa).toEqual(pb);
  });

  it("is deterministic for the same view and RNG", () => {
    const s = createMatch({ matchId: "det", aiVersion: "search-v3", humanDeckRng: rng("h2"), aiDeckRng: rng("a2") });
    expect(new SearchAi().decide(projectFor(s, "AI"), rng("y"))).toEqual(new SearchAi().decide(projectFor(s, "AI"), rng("y")));
  });
});

describe("search-v3: combos and tactics", () => {
  it("finds the guaranteed-lethal combo through Block (Unstoppable + Cleave) over a bigger blockable hit", () => {
    const s = makeState(
      { hand: ["fortify#1", "basic_shield#1", "arcane_barrier#1"], hp: 7 },
      { hand: ["unstoppable#1", "cleave#1", "heavy_strike#1", "quick_strike#1"], hp: 40 },
    );
    const pick = new SearchAi().decide(projectFor(s, "AI"), rng());
    expect([...pick].sort()).toEqual(["cleave#1", "unstoppable#1"]);
  });

  it("never draws itself into a deck-out loss", () => {
    const s = makeState({ hand: ["quick_strike#1"], hp: 40 }, { hand: ["arcane_insight#1", "basic_shield#1"], hp: 40, deck: ["fortify#9", "fortify#10", "fortify#11", "fortify#12"] });
    // AI deck: 4 left; next Start draw → 3; Insight draws 2 → 1 ⇒ defeat at End phase.
    const pick = new SearchAi().decide(projectFor(s, "AI"), rng());
    expect(pick).not.toContain("arcane_insight#1");
  });

  it("as the house, values a mutual knock-out (draw) as a win", () => {
    const s = makeState({ hp: 0 }, { hp: 0 });
    s.phase = "FINISHED";
    s.outcome = "DRAW";
    s.settlement = "HUMAN_LOSS";
    expect(evaluate(s, "AI")).toBeGreaterThan(900);
    expect(evaluate(s, "HUMAN")).toBeLessThan(-900);
  });

  it("combo calculator counts Unstoppable synergies and Lifesteal exactly", () => {
    const p = handPotential([def("unstoppable"), def("cleave"), def("lifesteal"), def("fireball")], 5);
    expect(p.sureDamage).toBe(9); // best is Fireball (9 Spell) — Unstoppable+Cleave gives 7
    expect(handPotential([def("unstoppable"), def("cleave")], 5).sureDamage).toBe(7);
    expect(handPotential([def("lifesteal"), def("cleave")], 5).maxHeal).toBe(7);
  });
});

describe("pattern memory", () => {
  const hurt = { hp: 20, oppHp: 30, handCount: 5, tookDamage: 12, oppStatuses: [] };
  const calm = { hp: 20, oppHp: 30, handCount: 5, tookDamage: 0, oppStatuses: [] };

  it("learns that this player defends when hurt and predicts it in that situation", () => {
    const m = new PatternModel();
    for (let t = 0; t < 8; t++) m.learn({ turn: t, ctx: hurt, cards: [def("fortify")] });
    for (let t = 0; t < 8; t++) m.learn({ turn: t, ctx: calm, cards: [def("cleave")] });
    expect(m.bias([def("fortify")], hurt)).toBeGreaterThan(m.bias([def("cleave")], hurt));
    expect(m.bias([def("cleave")], calm)).toBeGreaterThan(m.bias([def("fortify")], calm));
  });

  it("starts from a prior and keeps learning on top of it without mutating the prior", () => {
    const base = new PatternModel();
    for (let t = 0; t < 5; t++) base.learn({ turn: t, ctx: calm, cards: [] }); // a passer
    const prior = structuredClone(base.stats);
    const m = new PatternModel(prior);
    expect(m.rate("pass", calm)).toBeGreaterThan(0.3);
    m.learn({ turn: 9, ctx: calm, cards: [def("cleave")] });
    expect(prior.buckets["*"].n).toBe(5);
  });
});

describe("search-v3 inside a match session", () => {
  it("records the AI's moves and replays them on restore without re-running the search", () => {
    const a = new MatchSession(() => {}, 60_000, {}, { aiVersion: "search-v3" });
    for (let i = 0; i < 3 && !a.finished; i++) a.commitHuman(a.humanView().view.turn, []);
    const snap = a.snapshot();
    expect(snap.aiVersion).toBe("search-v3");
    expect(snap.aiCommits!.length).toBe(snap.humanCommits.length + (a.finished ? 0 : 1));
    const spy = vi.spyOn(SearchAi.prototype, "decide");
    const b = new MatchSession(() => {}, 60_000, {}, { restore: snap });
    expect(spy).not.toHaveBeenCalled();
    expect(b.humanView().view).toEqual(a.humanView().view);
    spy.mockRestore();
    a.dispose();
    b.dispose();
  });
});

describe("per-player profiles", () => {
  it("folds a match in once and serves it as the next match's prior", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-prof-"));
    try {
      const store = new ProfileStore(dir);
      const wallet = Keypair.generate().publicKey.toBase58();
      expect(store.prior(wallet)).toBeUndefined();
      const play = { turn: 1, ctx: { hp: 40, oppHp: 40, handCount: 6, tookDamage: 0, oppStatuses: [] }, cards: [def("cleave")] };
      store.record(wallet, "m1", [play, play]);
      store.record(wallet, "m1", [play, play]); // restart: same match again
      expect(store.prior(wallet)!.buckets["*"].n).toBe(2);
      expect(store.prior(wallet)!.matches).toBe(1);
      expect(() => store.record("../evil", "m2", [])).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
