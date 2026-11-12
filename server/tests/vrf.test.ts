import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { OnChainMatch, chainTiming, type HouseLike } from "../src/chain/onchainMatch";
import { deriveVrfMaster, type MatchRandomnessAccount, type VrfLike } from "../src/chain/vrf";
import { canonicalDeck, DECK_VERSION } from "../src/engine/cards";
import { RULES } from "../src/engine/rules";
import { createMatchRngs, shuffle } from "../src/engine/rng";
import { seedCommitment } from "../src/session";

chainTiming.retryBaseMs = 1;

/** Fake MagicBlock oracle + cardbattle_vrf program. */
class FakeVrf implements VrfLike {
  programId = Keypair.generate().publicKey;
  accounts = new Map<number, MatchRandomnessAccount>();
  requests: { arenaId: number; commitment: Buffer }[] = [];
  deliver = true;
  randomness = createHash("sha256").update("oracle-output").digest();
  pda(arenaId: number) {
    return PublicKey.findProgramAddressSync([Buffer.from("match_rng"), Buffer.from([arenaId])], this.programId)[0];
  }
  async read(arenaId: number) {
    return this.accounts.get(arenaId) ?? null;
  }
  async request(arenaId: number, commitment: Buffer) {
    if (this.accounts.has(arenaId)) return null;
    this.requests.push({ arenaId, commitment });
    this.accounts.set(arenaId, {
      authority: PublicKey.default,
      arenaId,
      commitment,
      randomness: Buffer.alloc(32),
      fulfilled: false,
      requestedSlot: 1,
      fulfilledSlot: 0,
    });
    if (this.deliver) {
      const a = this.accounts.get(arenaId)!;
      a.randomness = this.randomness;
      a.fulfilled = true;
      a.fulfilledSlot = 2;
    }
    return "sig-vrf";
  }
  async waitFulfilled(arenaId: number) {
    const a = this.accounts.get(arenaId);
    if (!a?.fulfilled) throw new Error("MagicBlock VRF did not deliver randomness");
    return a;
  }
}

class Chain implements HouseLike {
  publicKey = Keypair.generate().publicKey;
  calls: string[] = [];
  posted = 0;
  entered = new Set<string>();
  started = false;
  finished = false;
  claimed = false;
  refunded = false;
  cancelled = false;
  async ensureProfile() {
    return null;
  }
  async createMatchArena() {
    return { arenaId: 9, tx: "c" };
  }
  async hasEntered(_id: number, owner: PublicKey) {
    return this.entered.has(owner.toBase58());
  }
  async enter() {
    this.entered.add(this.publicKey.toBase58());
    this.calls.push("enter");
    return "e";
  }
  async start(_arenaId?: number) {
    if (this.started) return null;
    this.started = true;
    this.calls.push("start");
    return "s";
  }
  async currentRound() {
    return this.posted;
  }
  leaves: Record<string, string | number>[][] = [];
  async commitRound(_id: number, round: number, _p: PublicKey, leaves: Record<string, string | number>[]) {
    if (round <= this.posted) return null;
    this.posted = round;
    this.leaves.push(leaves);
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
    return "cl";
  }
  async cancel() {
    this.cancelled = true;
    this.calls.push("cancel");
    return "x";
  }
  async refundOwn() {
    if (this.refunded) return null;
    this.refunded = true;
    this.calls.push("refundOwn");
    return "rf";
  }
}

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

async function vrfMatch(vrf = new FakeVrf(), chain = new Chain()) {
  const player = Keypair.generate().publicKey;
  const m = new OnChainMatch(chain, player, 1_000_000, () => {}, () => {}, 60_000, undefined, vrf);
  await m.begin();
  chain.entered.add(player.toBase58());
  return { m, vrf, chain, player };
}

describe("MagicBlock VRF seed (vrf-v2)", () => {
  it("commits entropy + requests VRF after both stakes and BEFORE starting; deals from the combined seed", async () => {
    const { m, vrf, chain } = await vrfMatch();
    const placeholderHand = m.session.humanView().view.self.hand.map((c) => c.uid);
    await m.checkEntry();
    expect(m.status.seedScheme).toBe("vrf-v2");
    expect(chain.calls.slice(0, 2)).toEqual(["enter", "start"]);
    expect(vrf.requests).toHaveLength(1);
    // The request carries exactly the advertised commitment.
    expect(vrf.requests[0].commitment.toString("hex")).toBe(m.status.seedCommitment);
    expect(m.status.vrf?.randomness).toBe(vrf.randomness.toString("hex"));
    expect(m.status.phase).toBe("playing");
    // The hand was re-dealt from the VRF-derived seed (not the placeholder).
    expect(m.session.humanView().view.self.hand.map((c) => c.uid)).not.toEqual(placeholderHand);
    await settle(() => chain.posted >= 1);
    expect(chain.leaves[0][0]).toMatchObject({ kind: "seed-commitment", scheme: "vrf-v2", vrfRandomness: vrf.randomness.toString("hex") });
    m.dispose();
  });

  it("the VRF request happens before start_arena (so failure can still cancel)", async () => {
    const vrf = new FakeVrf();
    const chain = new Chain();
    const order: string[] = [];
    const origReq = vrf.request.bind(vrf);
    vrf.request = async (a, c) => (order.push("vrf"), origReq(a, c));
    const origStart = chain.start.bind(chain);
    chain.start = async (a?: number) => (order.push("start"), origStart(a));
    const { m } = await vrfMatch(vrf, chain);
    await m.checkEntry();
    expect(order).toEqual(["vrf", "start"]);
    m.dispose();
  });

  it("after the match, the revealed entropy + on-chain VRF output reproduce the decks", async () => {
    const { m, vrf, chain } = await vrfMatch();
    await m.checkEntry();
    const openingHand = m.session.humanView().view.self.hand.map((c) => c.uid);
    let guard = 0;
    while (!m.session.finished && guard++ < 100) m.session.commitHuman(m.session.humanView().view.turn, []);
    await settle(() => m.status.phase === "settled");
    const entropy = Buffer.from(m.status.seedReveal!, "hex");
    // 1. Commitment check (what anyone can do with the on-chain account)
    expect(seedCommitment(entropy, m.session.matchId)).toBe(m.status.seedCommitment);
    // 2. Re-derive the seed and the human deck; the opening 6 cards must match what was dealt.
    const master = deriveVrfMaster(entropy, vrf.randomness, m.session.matchId);
    const deck = shuffle(canonicalDeck(), createMatchRngs(m.session.matchId, { rules: RULES.version, deck: DECK_VERSION }, master).humanDeck);
    expect(deck.slice(0, 6)).toEqual(openingHand);
    expect(chain.finished).toBe(true);
    m.dispose();
  });

  it("if MagicBlock never delivers, the arena (still in Registration) is cancelled and the house refunds itself", async () => {
    const vrf = new FakeVrf();
    vrf.deliver = false;
    const { m, chain } = await vrfMatch(vrf);
    await m.checkEntry();
    expect(chain.started).toBe(false);
    expect(chain.cancelled).toBe(true);
    expect(chain.refunded).toBe(true);
    expect(m.status.phase).toBe("cancelled");
    expect(m.status.playerCanRefund).toBe(true);
    expect(m.session.isStarted).toBe(false);
    m.dispose();
  });

  it("restart mid-VRF: same entropy, idempotent request, then the match starts", async () => {
    const vrf = new FakeVrf();
    vrf.deliver = false;
    const chain = new Chain();
    const { m } = await vrfMatch(vrf, chain);
    // Request lands but the server dies before delivery.
    await vrf.request(9, Buffer.from(m.status.seedCommitment, "hex"));
    const snap = m.snapshot();
    snap.status.phase = "starting";
    m.dispose();
    const a = vrf.accounts.get(9)!;
    a.randomness = vrf.randomness;
    a.fulfilled = true;
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000, vrf);
    await r.resume();
    expect(vrf.requests).toHaveLength(1);
    expect(r.status.phase).toBe("playing");
    expect(r.status.seedCommitment).toBe(m.status.seedCommitment);
    r.dispose();
  });

  it("restoring a VRF match without a VRF client is refused (never silently re-dealt)", async () => {
    const { m, chain } = await vrfMatch();
    await m.checkEntry();
    const snap = m.snapshot();
    m.dispose();
    expect(() => OnChainMatch.restore(chain, snap, () => {}, () => {})).toThrow(/VRF/);
  });

  it("restoring a started VRF match replays the same game", async () => {
    const { m, vrf, chain } = await vrfMatch();
    await m.checkEntry();
    m.session.commitHuman(1, []);
    m.session.commitHuman(2, []);
    const snap = m.snapshot();
    m.dispose();
    const r = OnChainMatch.restore(chain, snap, () => {}, () => {}, 60_000, vrf);
    expect(r.session.humanView().view).toEqual(m.session.humanView().view);
    r.dispose();
  });
});
