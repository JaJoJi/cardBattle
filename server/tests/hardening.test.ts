import { afterEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHALLENGE_TTL_MS, ChallengeStore, RateLimiter } from "../src/chain/auth";
import { MatchStore } from "../src/chain/store";
import { OnChainMatch, chainTiming, type HouseLike } from "../src/chain/onchainMatch";
import { MatchSession } from "../src/session";

chainTiming.retryBaseMs = 1;

const sign = (kp: Keypair, message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));

describe("wallet challenge (proof of ownership)", () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();

  it("accepts a valid signature exactly once", () => {
    const store = new ChallengeStore();
    const c = store.issue(wallet, 5_000_000);
    expect(c.message).toContain(wallet);
    expect(c.message).toContain("5 test USDC");
    const sig = sign(kp, c.message);
    expect(store.redeem(c.nonce, wallet, 5_000_000, sig)).toEqual({ ok: true });
    expect(store.redeem(c.nonce, wallet, 5_000_000, sig).ok).toBe(false); // replay
  });

  it("rejects another wallet's signature, a changed stake, garbage and missing fields", () => {
    const store = new ChallengeStore();
    const other = Keypair.generate();
    const c1 = store.issue(wallet, 5_000_000);
    expect(store.redeem(c1.nonce, wallet, 5_000_000, sign(other, c1.message))).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid/) });
    const c2 = store.issue(wallet, 5_000_000);
    expect(store.redeem(c2.nonce, wallet, 100_000_000, sign(kp, c2.message))).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
    const c3 = store.issue(wallet, 5_000_000);
    expect(store.redeem(c3.nonce, other.publicKey.toBase58(), 5_000_000, sign(other, c3.message)).ok).toBe(false);
    const c4 = store.issue(wallet, 5_000_000);
    expect(store.redeem(c4.nonce, wallet, 5_000_000, "not-base58-!!").ok).toBe(false);
    expect(store.redeem(undefined, wallet, 5_000_000, undefined).ok).toBe(false);
  });

  it("expires after the TTL", () => {
    let now = 1_000_000;
    const store = new ChallengeStore(() => now);
    const c = store.issue(wallet, 1_000_000);
    now += CHALLENGE_TTL_MS + 1;
    expect(store.redeem(c.nonce, wallet, 1_000_000, sign(kp, c.message))).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("refuses to issue for an invalid address", () => {
    expect(() => new ChallengeStore().issue("nope", 1_000_000)).toThrow();
  });
});

describe("rate limiter", () => {
  it("allows N per window, then blocks until the window slides", () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect([rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, false]);
    expect(rl.allow("b")).toBe(true);
    now = 1001;
    expect(rl.allow("a")).toBe(true);
  });
});

describe("session snapshot + replay", () => {
  it("restoring from a snapshot reproduces the exact match (hands, HP, history)", () => {
    const a = new MatchSession(() => {}, 60_000);
    for (let i = 0; i < 4 && !a.finished; i++) {
      const v = a.humanView().view;
      const pick = v.self.hand.filter((c) => c.def.cost <= v.self.energy).slice(0, 1).map((c) => c.uid);
      expect(a.commitHuman(v.turn, pick).ok).toBe(true);
    }
    const b = new MatchSession(() => {}, 60_000, {}, { restore: a.snapshot() });
    expect(b.token).toBe(a.token);
    expect(b.humanView().view).toEqual(a.humanView().view);
    expect(b.reports()).toEqual(a.reports());
    expect(b.seedCommitment).toBe(a.seedCommitment);
    // Both continue identically.
    if (!a.finished) {
      const t = a.humanView().view.turn;
      a.commitHuman(t, []);
      b.commitHuman(t, []);
      expect(b.humanView().view).toEqual(a.humanView().view);
    }
    a.dispose();
    b.dispose();
  });

  it("refuses to restore a snapshot from different rules/deck/AI versions", () => {
    const a = new MatchSession(() => {}, 60_000);
    const snap = { ...a.snapshot(), deckVersion: "deck-v1" };
    expect(() => new MatchSession(() => {}, 60_000, {}, { restore: snap })).toThrow(/deck-v1/);
    a.dispose();
  });
});

describe("match store", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips snapshots atomically and removes them", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-store-"));
    const store = new MatchStore(dir);
    const house = { publicKey: Keypair.generate().publicKey } as unknown as HouseLike;
    const m = new OnChainMatch(house, Keypair.generate().publicKey, 1_000_000, () => {}, () => {});
    store.save(m.snapshot());
    expect(readdirSync(dir)).toEqual([`${m.session.token}.json`]); // no stray .tmp
    const [loaded] = store.loadAll();
    expect(loaded.snap.session.master).toBe(m.session.snapshot().master);
    if (process.platform !== "win32") expect(statSync(loaded.file).mode & 0o077).toBe(0);
    store.remove(m.session.token);
    expect(store.loadAll()).toEqual([]);
    expect(() => store.remove("../evil")).toThrow();
    m.dispose();
  });
});

/** Minimal chain double for restore tests (idempotent like the real ArenaHouse). */
class Chain implements HouseLike {
  publicKey = Keypair.generate().publicKey;
  calls: string[] = [];
  posted = 0;
  entered = new Set<string>();
  started = false;
  finished = false;
  claimed = false;
  async ensureProfile() {
    return null;
  }
  async createMatchArena() {
    this.calls.push("create");
    return { arenaId: 7, tx: "c" };
  }
  async hasEntered(_id: number, owner: PublicKey) {
    return this.entered.has(owner.toBase58());
  }
  async enter() {
    if (this.entered.has(this.publicKey.toBase58())) return null;
    this.entered.add(this.publicKey.toBase58());
    this.calls.push("enter");
    return "e";
  }
  async start() {
    if (this.started) return null;
    this.started = true;
    this.calls.push("start");
    return "s";
  }
  async currentRound() {
    return this.posted;
  }
  async commitRound(_id: number, round: number) {
    if (round <= this.posted) return null;
    if (round !== this.posted + 1) throw new Error(`InvalidRoundNumber: got ${round}, expected ${this.posted + 1}`);
    this.posted = round;
    this.calls.push(`round:${round}`);
    return `r${round}`;
  }
  async finalize() {
    if (this.finished) return null;
    this.finished = true;
    this.calls.push("finalize");
    return "f";
  }
  async claim() {
    if (this.claimed) return null;
    this.claimed = true;
    this.calls.push("claim");
    return "cl";
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
    return "x";
  }
}

const settleQueue = async (m: OnChainMatch, until: (m: OnChainMatch) => boolean) => {
  for (let i = 0; i < 200 && !until(m); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("restart recovery", () => {
  async function startedMatch(chain: Chain) {
    const player = Keypair.generate().publicKey;
    const m = new OnChainMatch(chain, player, 1_000_000, () => {}, () => {}, 60_000);
    await m.begin();
    chain.entered.add(player.toBase58());
    await m.checkEntry();
    return m;
  }

  it("mid-match: replays the game and posts only the rounds that never reached the chain", async () => {
    const chain = new Chain();
    const m = await startedMatch(chain);
    m.session.commitHuman(1, []);
    m.session.commitHuman(2, []);
    await settleQueue(m, () => chain.posted === 3);
    m.session.commitHuman(3, []); // resolved locally…
    const snap = m.snapshot();
    m.dispose(); // …but the server dies before round 4 is sent
    await new Promise((r) => setTimeout(r, 20));
    chain.posted = 3;
    chain.calls = [];

    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000);
    expect(r.session.humanView().view).toEqual(m.session.humanView().view);
    await r.resume();
    await settleQueue(r, () => chain.posted === 4);
    expect(chain.calls).toEqual(["round:4"]);
    // Play continues normally after the restart.
    expect(r.session.commitHuman(4, []).ok).toBe(true);
    await settleQueue(r, () => chain.posted === 5);
    expect(chain.posted).toBe(5);
    r.dispose();
  });

  it("finished but not finalized: finalizes once and the house claims", async () => {
    const chain = new Chain();
    const m = await startedMatch(chain);
    let guard = 0;
    while (!m.session.finished && guard++ < 100) m.session.commitHuman(m.session.humanView().view.turn, []);
    const snap = m.snapshot();
    snap.status.phase = "finalizing";
    m.dispose();
    await settleQueue(m, (x) => x.status.phase === "settled");
    chain.finished = false;
    chain.claimed = false;
    chain.calls = [];
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000);
    await r.resume();
    await settleQueue(r, (x) => x.status.phase === "settled");
    expect(chain.calls.filter((c) => c === "finalize")).toHaveLength(1);
    expect(chain.claimed).toBe(true);
    r.dispose();
  });

  it("waiting for entry: resumes watching and starts when the player's stake appears", async () => {
    const chain = new Chain();
    const player = Keypair.generate().publicKey;
    const m = new OnChainMatch(chain, player, 1_000_000, () => {}, () => {}, 60_000);
    await m.begin();
    const snap = m.snapshot();
    m.dispose();
    chain.entered.add(player.toBase58());
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000);
    await r.resume();
    expect(r.status.phase).toBe("playing");
    expect(r.session.isStarted).toBe(true);
    r.dispose();
  });

  it("interrupted while starting: re-runs the idempotent enter/start without double-staking", async () => {
    const chain = new Chain();
    const player = Keypair.generate().publicKey;
    const m = new OnChainMatch(chain, player, 1_000_000, () => {}, () => {}, 60_000);
    await m.begin();
    const snap = m.snapshot();
    snap.status.phase = "starting";
    m.dispose();
    chain.entered.add(player.toBase58());
    chain.entered.add(chain.publicKey.toBase58()); // the house's enter had already landed
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000);
    await r.resume();
    expect(chain.calls.filter((c) => c === "enter")).toHaveLength(0);
    expect(chain.calls).toContain("start");
    expect(r.status.phase).toBe("playing");
    r.dispose();
  });

  it("interrupted while creating: marks the match cancelled (nothing was staked)", async () => {
    const chain = new Chain();
    const m = new OnChainMatch(chain, Keypair.generate().publicKey, 1_000_000, () => {}, () => {}, 60_000);
    const snap = m.snapshot(); // phase "creating"
    m.dispose();
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000);
    await r.resume();
    expect(r.status.phase).toBe("cancelled");
    expect(r.status.error).toMatch(/No funds were staked/);
    r.dispose();
  });
});
