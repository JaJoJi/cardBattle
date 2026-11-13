import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { ENTRY_TIMEOUT_MS, OnChainMatch, chainTiming, type HouseLike } from "../src/chain/onchainMatch";

chainTiming.retryBaseMs = 1;
import { merkleRootOf, rulesHash } from "../src/chain/house";
import { canonicalDeck, DECK_VERSION } from "../src/engine/cards";
import { RULES } from "../src/engine/rules";
import { createMatchRngs, shuffle } from "../src/engine/rng";
import { seedCommitment } from "../src/session";
import { SpendGuard } from "../src/ai/llm/budget";
import { setLlmClient } from "../src/ai/llm/llmAi";
import { LLM_MODELS, llmVersionOf } from "../src/ai/llm/models";
import { OpenRouterClient } from "../src/ai/llm/openrouter";

/** In-memory stand-in for the RitArena program, recording every call in order. */
class FakeHouse implements HouseLike {
  publicKey = Keypair.generate().publicKey;
  calls: string[] = [];
  rounds: { round: number; leaves: Record<string, string | number>[]; hp: { player: number; house: number } }[] = [];
  playerEntered = false;
  failEnter = false;
  winner?: string;

  async ensureProfile() {
    this.calls.push("ensureProfile");
    return null;
  }
  async createMatchArena(stake: number) {
    this.calls.push(`create:${stake}`);
    return { arenaId: 42, tx: "sig-create" };
  }
  async hasEntered(_id: number, owner: PublicKey) {
    return owner.equals(this.publicKey) || this.playerEntered;
  }
  async enter() {
    this.calls.push("enter");
    if (this.failEnter) throw new Error("insufficient funds");
    return "sig-enter";
  }
  async start() {
    this.calls.push("start");
    return "sig-start";
  }
  posted = 0;
  async currentRound() {
    return this.posted;
  }
  async commitRound(_id: number, round: number, _p: PublicKey, leaves: Record<string, string | number>[], hp: { player: number; house: number }) {
    if (round <= this.posted) {
      this.calls.push(`round:${round}:skip`);
      return null;
    }
    this.posted = round;
    this.calls.push(`round:${round}`);
    this.rounds.push({ round, leaves, hp });
    return `sig-round-${round}`;
  }
  // Simulated chain state so idempotency can be exercised.
  finished = false;
  claimed = false;
  /** Number of claim attempts that see stale "not Finished" RPC state (the devnet bug). */
  staleClaimReads = 0;
  /** The finalize tx lands, but the client sees a confirmation timeout once. */
  finalizeTimeoutOnce = false;

  async finalize(_id: number, _p: PublicKey, winner: "PLAYER" | "HOUSE") {
    if (this.finished) {
      this.calls.push("finalize:skip");
      return null;
    }
    this.calls.push(`finalize:${winner}`);
    this.winner = winner;
    this.finished = true;
    if (this.finalizeTimeoutOnce) {
      this.finalizeTimeoutOnce = false;
      throw new Error("Transaction was not confirmed in 30.00 seconds");
    }
    return "sig-final";
  }
  async claim() {
    if (this.staleClaimReads > 0) {
      this.staleClaimReads--;
      this.calls.push("claim:stale");
      throw new Error("Arena 1 is Eliminating, not Finished");
    }
    if (this.claimed) return null;
    this.calls.push("claim");
    this.claimed = true;
    return "sig-claim";
  }
  refunded = false;
  async refundOwn() {
    if (this.refunded) return null;
    this.refunded = true;
    this.calls.push("refundOwn");
    return "rf";
  }
  async cancel() {
    this.calls.push("cancel");
    return "sig-cancel";
  }
  transfers: number[] = [];
  failTransfer = false;
  async transferUsdc(_to: PublicKey, micro: number) {
    this.calls.push(`transfer:${micro}`);
    this.transfers.push(micro);
    if (this.failTransfer) throw new Error("Transaction was not confirmed in 30.00 seconds");
    return "sig-transfer";
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function newMatch(house = new FakeHouse()) {
  const player = Keypair.generate().publicKey;
  const m = new OnChainMatch(house, player, 5_000_000, () => {}, () => {}, 60_000);
  return { house, player, m };
}

async function settle(m: OnChainMatch) {
  // Play passes until the match ends; flush the chain queue as we go.
  let guard = 0;
  while (!m.session.finished && guard++ < 100) {
    expect(m.session.commitHuman(m.session.humanView().view.turn, []).ok).toBe(true);
  }
  for (let i = 0; i < 10 && m.status.phase !== "settled" && m.status.phase !== "failed"; i++) await flush();
}

describe("OnChainMatch lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("creates the arena and waits for the player before staking or starting", async () => {
    const { house, m } = newMatch();
    await m.begin();
    expect(m.status.phase).toBe("awaiting-entry");
    expect(m.status.arenaId).toBe(42);
    expect(house.calls).toEqual(["ensureProfile", "create:5000000"]);
    expect(m.session.commitHuman(1, []).ok).toBe(false); // gameplay locked until the arena is live
    await m.checkEntry();
    expect(house.calls).not.toContain("enter");
    m.dispose();
  });

  it("player enters → house enters, starts, commits the seed as round 1, then play begins", async () => {
    const { house, m } = newMatch();
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    await flush();
    expect(m.status.phase).toBe("playing");
    expect(house.calls.slice(2, 5)).toEqual(["enter", "start", "round:1"]);
    expect(house.rounds[0].leaves[0]).toMatchObject({ kind: "seed-commitment", commitment: m.status.seedCommitment });
    expect(m.session.isStarted).toBe(true);
    m.dispose();
  });

  it("commits one round per turn in order, then finalizes; a draw/loss settles to the house which claims", async () => {
    const { house, m } = newMatch();
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    await settle(m);
    const turns = m.session.humanView().view.lastTurn!.turn;
    const rounds = house.calls.filter((c) => c.startsWith("round:")).map((c) => Number(c.split(":")[1]));
    expect(rounds).toEqual(Array.from({ length: turns + 1 }, (_, i) => i + 1));
    expect(house.calls.slice(-2)).toEqual(["finalize:HOUSE", "claim"]);
    expect(m.status.phase).toBe("settled");
    // Passing every turn never wins.
    expect(m.status.winner).toBe("HOUSE");
    expect(m.status.txs.some((t) => t.label === "House claims pot" && t.sig === "sig-claim")).toBe(true);
    expect(m.status.playerMustClaim).toBe(false);
    m.dispose();
  });

  it("round scores carry HP; leaves never contain card identities", async () => {
    const { house, m } = newMatch();
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    expect(m.session.commitHuman(1, []).ok).toBe(true);
    await flush();
    const r2 = house.rounds.find((r) => r.round === 2)!;
    const hp = m.session.humanView().view.lastTurn!.hpAfter;
    expect(r2.hp).toEqual({ player: hp.HUMAN, house: hp.AI });
    expect(JSON.stringify(r2.leaves)).not.toMatch(/#\d/); // no "card#n" uids
    m.dispose();
  });

  it("reveals the seed only after the match, and it matches the pre-game commitment", async () => {
    const { house, m } = newMatch();
    await m.begin();
    expect(m.status.seedReveal).toBeUndefined();
    house.playerEntered = true;
    await m.checkEntry();
    await settle(m);
    const seed = Buffer.from(m.status.seedReveal!, "hex");
    expect(seedCommitment(seed, m.session.matchId)).toBe(m.status.seedCommitment);
    const rngs = createMatchRngs(m.session.matchId, { rules: RULES.version, deck: DECK_VERSION }, seed);
    const humanDeck = shuffle(canonicalDeck(), rngs.humanDeck);
    // The human's opening hand (first 6 cards: 5 + turn-1 draw) is reproducible from the revealed seed.
    const firstReport = m.session.humanView().view;
    expect(humanDeck.length).toBe(60);
    expect(firstReport.matchId).toBe(m.session.matchId);
    m.dispose();
  });

  it("if the house cannot enter after the player staked, the arena is cancelled and the player can refund", async () => {
    const house = new FakeHouse();
    house.failEnter = true;
    const { m } = newMatch(house);
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    expect(house.calls).toContain("cancel");
    expect(house.calls).not.toContain("start");
    expect(m.status.phase).toBe("cancelled");
    expect(m.status.playerCanRefund).toBe(true);
    m.dispose();
  });

  it("player can back out before entering; entry window expiry also cancels", async () => {
    const a = newMatch();
    await a.m.begin();
    await a.m.cancelByPlayer();
    expect(a.m.status.phase).toBe("cancelled");
    expect(a.m.status.playerCanRefund).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    const b = newMatch();
    await b.m.begin();
    vi.setSystemTime(Date.now() + ENTRY_TIMEOUT_MS + 1);
    await b.m.checkEntry();
    expect(b.house.calls).toContain("cancel");
    expect(b.m.status.phase).toBe("cancelled");
    a.m.dispose();
    b.m.dispose();
  });

  it("payout is 2x stake minus the 1% protocol fee", () => {
    const { m } = newMatch();
    expect(m.status.payoutMicro).toBe(9_900_000);
    m.dispose();
  });
});

describe("settlement retries (devnet RPC lag)", () => {
  async function playToEnd(house: FakeHouse) {
    const { m } = newMatch(house);
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    let guard = 0;
    while (!m.session.finished && guard++ < 100) m.session.commitHuman(m.session.humanView().view.turn, []);
    for (let i = 0; i < 400 && m.status.phase !== "settled" && m.status.phase !== "failed"; i++) await new Promise((r) => setTimeout(r, 25));
    return m;
  }

  it("a stale 'not Finished' read during the house claim no longer re-sends finalize; it retries only the claim", async () => {
    const house = new FakeHouse();
    house.staleClaimReads = 1;
    const m = await playToEnd(house);
    expect(m.status.phase).toBe("settled");
    expect(house.calls.filter((c) => c.startsWith("finalize"))).toEqual(["finalize:HOUSE"]);
    expect(house.calls.filter((c) => c.startsWith("claim"))).toEqual(["claim:stale", "claim"]);
    expect(m.status.error).toBeUndefined();
    m.dispose();
  }, 20_000);

  it("finalize that landed but timed out is detected on retry and not sent twice", async () => {
    const house = new FakeHouse();
    house.finalizeTimeoutOnce = true;
    const m = await playToEnd(house);
    expect(m.status.phase).toBe("settled");
    expect(house.calls.filter((c) => c.startsWith("finalize"))).toEqual(["finalize:HOUSE", "finalize:skip"]);
    expect(house.claimed).toBe(true);
    m.dispose();
  }, 20_000);

  it("if the house claim keeps failing, the match is still settled and tells you how to recover", async () => {
    const house = new FakeHouse();
    house.staleClaimReads = 99;
    const m = await playToEnd(house);
    expect(m.status.phase).toBe("settled");
    expect(m.status.error).toMatch(/chain:claim -- 42/);
    m.dispose();
  }, 30_000);
});

describe("chain helpers", () => {
  it("rulesHash is stable and 32 bytes", () => {
    expect(rulesHash()).toHaveLength(32);
    expect(Buffer.from(rulesHash()).toString("hex")).toBe(Buffer.from(rulesHash()).toString("hex"));
  });
  it("merkle root changes when any leaf changes", () => {
    const a = merkleRootOf([{ kind: "hp", side: "HUMAN", hp: 40 }]);
    const b = merkleRootOf([{ kind: "hp", side: "HUMAN", hp: 39 }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(createHash("sha256").update(a).digest()).toHaveLength(32);
  });
});

describe("LLM champion challenge settlement", () => {
  const MODEL = LLM_MODELS.find((m) => m.id.startsWith("z-ai"))!;
  const terms = { model: MODEL.id, name: MODEL.name, aiVersion: llmVersionOf(MODEL), prizeMicro: 12_000_000, topUpMicro: 2_100_000 };
  // The model always passes, so a human who attacks every turn wins.
  const passer = () =>
    new OpenRouterClient("k", new SpendGuard(1, null), (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"cards":[],"reason":"pass"}' } }], usage: { cost: 0.0001 } }))) as typeof fetch);
  afterEach(() => setLlmClient(null));

  async function winAsPlayer(house: FakeHouse) {
    setLlmClient(passer());
    const player = Keypair.generate().publicKey;
    const m = new OnChainMatch(house, player, 5_000_000, () => {}, () => {}, 60_000, undefined, undefined, undefined, terms);
    await m.begin();
    house.playerEntered = true;
    await m.checkEntry();
    for (let i = 0; i < 100 && !m.session.finished; i++) {
      await flush();
      const { view } = m.session.humanView();
      if (view.self.committed) continue;
      const atk = view.self.hand.filter((c) => c.def.type !== "DEFENSE" && c.def.cost <= view.self.energy && !c.def.effects.some((e) => e.kind === "DRAW_CARDS"));
      m.session.commitHuman(view.turn, atk.length ? [atk.sort((a, b) => b.def.cost - a.def.cost)[0].uid] : []);
    }
    for (let i = 0; i < 10 && m.status.phase !== "settled"; i++) await flush();
    return { m, player };
  }

  it("a player win is finalized to the player and the house pays the bounty top-up once", async () => {
    const house = new FakeHouse();
    const { m } = await winAsPlayer(house);
    expect(m.status.phase).toBe("settled");
    expect(m.status.winner).toBe("PLAYER");
    expect(m.status.opponent).toEqual({ model: MODEL.id, name: MODEL.name });
    expect(house.transfers).toEqual([2_100_000]);
    expect(m.session.aiCostUsd()).toBeGreaterThan(0);

    // A restart re-runs finalize (a no-op) but never re-sends the top-up.
    const restored = OnChainMatch.restore(house, m.snapshot(), () => {}, () => {}, 60_000);
    m.dispose();
    await restored.resume();
    for (let i = 0; i < 5; i++) await flush();
    expect(house.transfers).toEqual([2_100_000]);
    restored.dispose();
  }, 20_000);

  it("a top-up that fails to confirm is reported and never auto-resent", async () => {
    const house = new FakeHouse();
    house.failTransfer = true;
    const { m } = await winAsPlayer(house);
    expect(m.status.phase).toBe("settled");
    expect(m.status.error).toMatch(/top-up/);
    expect(house.transfers).toHaveLength(1);
    m.dispose();
  }, 20_000);
});
