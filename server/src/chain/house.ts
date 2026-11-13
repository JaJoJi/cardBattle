import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { BATTLE_ROYALE_TEMPLATE, RitArena, computeMerkleRoot, hashLeaf, pdas } from "@ritarena/sdk";
import { CARD_CATALOG, DECK_COMPOSITION, DECK_VERSION } from "../engine/cards";
import { RULES } from "../engine/rules";

export const USDC = 1_000_000; // micro-units per USDC
export const HOUSE_PROFILE_NAME = "RitArena Card House";

export type Leaf = Record<string, string | number>;

/** sha256 of the exact rules + deck this server plays, stored on every arena. */
export function rulesHash(): Uint8Array {
  const doc = JSON.stringify({ rules: RULES, deckVersion: DECK_VERSION, deck: DECK_COMPOSITION, cards: CARD_CATALOG });
  return new Uint8Array(createHash("sha256").update(doc).digest());
}

export function merkleRootOf(leaves: Leaf[]): Uint8Array {
  return new Uint8Array(computeMerkleRoot(leaves.map((l) => hashLeaf(l))));
}

export function entryPda(arenaId: number, owner: PublicKey): PublicKey {
  return pdas.arenaEntry(pdas.arena(arenaId), pdas.agentProfile(owner));
}

/**
 * The house wallet is both the arena oracle (creates, starts, reports, finalizes)
 * and the AI's on-chain entrant (stakes against the player). Every write goes
 * through the published @ritarena/sdk against the deployed RitArena program.
 */
export class ArenaHouse {
  readonly sdk: RitArena;

  constructor(
    readonly connection: Connection,
    readonly keypair: Keypair,
    sdk?: RitArena,
  ) {
    this.sdk = sdk ?? RitArena.fromKeypair(connection, keypair);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async usdcMint(): Promise<PublicKey> {
    const protocol = await this.sdk.getProtocol();
    if (!protocol) throw new Error("RitArena protocol is not initialised on this cluster");
    return protocol.usdcMint;
  }

  async balances(owner: PublicKey = this.publicKey): Promise<{ sol: number; usdc: number }> {
    const [lamports, mint] = await Promise.all([this.connection.getBalance(owner), this.usdcMint()]);
    let usdc = 0;
    try {
      const ata = await getAssociatedTokenAddress(mint, owner);
      const bal = await this.connection.getTokenAccountBalance(ata);
      usdc = Number(bal.value.amount) / USDC;
    } catch {
      usdc = 0; // no token account yet
    }
    return { sol: lamports / LAMPORTS_PER_SOL, usdc };
  }

  async ensureProfile(): Promise<string | null> {
    if (await this.sdk.hasProfile(this.publicKey)) return null;
    return this.sdk.registerProfile(HOUSE_PROFILE_NAME);
  }

  /** 1v1, winner-takes-all arena with the stake as entry fee. The house becomes the oracle. */
  /**
   * Public RPC nodes can lag behind a confirmed write. Polls until `read` sees the change,
   * so later steps (and the player's wallet) never act on stale state.
   */
  async waitUntil(read: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await read()) return;
      } catch {
        /* transient RPC error — keep polling */
      }
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what} to be visible on the RPC`);
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }

  async createMatchArena(stakeMicro: number): Promise<{ arenaId: number; tx: string }> {
    const created = await this.createArenaTx(stakeMicro);
    await this.waitUntil(async () => (await this.sdk.getArena(created.arenaId)) !== null, `arena #${created.arenaId}`);
    return created;
  }

  private async createArenaTx(stakeMicro: number): Promise<{ arenaId: number; tx: string }> {
    return this.sdk.createArena({
      ...BATTLE_ROYALE_TEMPLATE,
      entryFee: stakeMicro,
      maxAgents: 2,
      minAgents: 2,
      prizeSplit: [100],
      creatorFeeBps: 0,
      eliminationPercent: 50,
      duration: 7200,
      // Also the abandon timeout (2x): if the server disappears mid-match for 30 min,
      // the arena can be abandoned and both stakes refunded.
      eliminationInterval: 900,
      actionSchema: "cardbattle-v1: 0-2 card uids per turn, simultaneous commit",
      rulesHash: rulesHash(),
    });
  }

  async currentRound(arenaId: number): Promise<number> {
    const arena = await this.sdk.getArena(arenaId);
    if (!arena) throw new Error(`Arena ${arenaId} not found`);
    return arena.currentRound;
  }

  async hasEntered(arenaId: number, owner: PublicKey): Promise<boolean> {
    return (await this.sdk.getAgentDetails(arenaId, owner)) !== null;
  }

  // Every write below is idempotent: it first checks whether its effect is already on-chain
  // and returns null instead of sending. A retry after a tx that landed but whose
  // confirmation timed out (common on devnet) therefore never double-sends.

  async enter(arenaId: number): Promise<string | null> {
    if (await this.hasEntered(arenaId, this.publicKey)) return null;
    return this.sdk.enterArena(arenaId);
  }

  async start(arenaId: number): Promise<string | null> {
    const arena = await this.sdk.getArena(arenaId);
    if (arena && !("registration" in arena.state)) return null;
    return this.sdk.startArena(arenaId);
  }

  /** Posts a Merkle root of this round's log + both sides' HP as scores. No eliminations. */
  async commitRound(arenaId: number, round: number, player: PublicKey, leaves: Leaf[], hp: { player: number; house: number }): Promise<string | null> {
    const arena = await this.sdk.getArena(arenaId);
    if (arena && arena.currentRound >= round) return null;
    const playerEntry = entryPda(arenaId, player);
    const houseEntry = entryPda(arenaId, this.publicKey);
    return this.sdk.submitElimination(arenaId, {
      merkleRoot: merkleRootOf(leaves),
      roundNumber: round,
      eliminated: [],
      scores: [
        { entry: playerEntry, score: hp.player },
        { entry: houseEntry, score: hp.house },
      ],
      entryAccounts: [playerEntry, houseEntry],
    });
  }

  /** Finalizes with a single rank-1 winner. Returns null if the arena is already finished. */
  async finalize(arenaId: number, player: PublicKey, winner: "PLAYER" | "HOUSE", leaves: Leaf[]): Promise<string | null> {
    const arena = await this.sdk.getArena(arenaId);
    if (arena && "finished" in arena.state) return null;
    const playerEntry = entryPda(arenaId, player);
    const houseEntry = entryPda(arenaId, this.publicKey);
    return this.sdk.finalizeArena(arenaId, {
      merkleRoot: merkleRootOf(leaves),
      winners: [{ entry: winner === "PLAYER" ? playerEntry : houseEntry, rank: 1 }],
      entryAccounts: [playerEntry, houseEntry],
    });
  }

  /**
   * Claims the house's prize. The SDK re-reads the arena before claiming, and right after
   * finalize the RPC may still report the old state — so wait until it reads Finished.
   * Returns null if already claimed.
   */
  async claim(arenaId: number, waitMs = 30_000): Promise<string | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const arena = await this.sdk.getArena(arenaId);
      if (arena && "finished" in arena.state) break;
      if (Date.now() > until) throw new Error(`Arena ${arenaId} still not Finished on the RPC after ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 1_500));
    }
    const entry = await this.sdk.getAgentDetails(arenaId, this.publicKey);
    if (!entry) throw new Error("House has no entry in this arena");
    if (entry.prizeRank === 0) throw new Error("House is not a winner of this arena");
    if (entry.prizeClaimed) return null;
    return this.sdk.claimPrize(arenaId);
  }

  /**
   * Cancels an arena still in Registration so any entrant can refund. The SDK has no
   * wrapper yet, so this calls the program's `cancel_arena` instruction directly.
   */
  async cancel(arenaId: number): Promise<string> {
    const program = (this.sdk as unknown as { program: { methods: { cancelArena(): { accounts(a: object): { rpc(): Promise<string> } } } } }).program;
    return program.methods.cancelArena().accounts({ creator: this.publicKey, arena: pdas.arena(arenaId) }).rpc();
  }

  /** Refunds the house's own entry from a cancelled/abandoned arena. Null if nothing to refund. */
  async refundOwn(arenaId: number): Promise<string | null> {
    const entry = await this.sdk.getAgentDetails(arenaId, this.publicKey);
    if (!entry || entry.refunded) return null;
    const arena = await this.sdk.getArena(arenaId);
    if (!arena) throw new Error(`Arena ${arenaId} not found`);
    const arenaPda = pdas.arena(arenaId);
    const program = (this.sdk as unknown as {
      program: { methods: { refundEntry(): { accountsPartial(a: object): { rpc(): Promise<string> } } } };
    }).program;
    return program.methods
      .refundEntry()
      .accountsPartial({
        agentOwner: this.publicKey,
        arena: arenaPda,
        arenaEntry: entryPda(arenaId, this.publicKey),
        arenaVault: pdas.arenaVault(arenaPda),
        agentUsdc: await getAssociatedTokenAddress(arena.usdcMint, this.publicKey),
        usdcMint: arena.usdcMint,
      })
      .rpc();
  }

  /**
   * Plain USDC transfer from the house (bounty top-up on a player win). NOT idempotent, so
   * callers send it once and never auto-retry: a "failed" confirmation may still have landed.
   */
  async transferUsdc(to: PublicKey, micro: number): Promise<string> {
    const mint = await this.usdcMint();
    const from = await getAssociatedTokenAddress(mint, this.publicKey);
    const dest = await getAssociatedTokenAddress(mint, to);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(this.publicKey, dest, to, mint),
      createTransferCheckedInstruction(from, mint, dest, this.publicKey, micro, 6),
    );
    return sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: "confirmed" });
  }

  async recentArenas(limit = 8) {
    const arenas = await this.sdk.listArenas({ creator: this.publicKey });
    return arenas
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit)
      .map((a) => ({
        arenaId: Number(a.id),
        state: Object.keys(a.state)[0],
        stake: Number(a.entryFee) / USDC,
        pot: Number(a.totalEntryFees) / USDC,
        rounds: a.currentRound,
      }));
  }
}
