import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { RULES } from "../engine/rules";
import type { TurnReport } from "../engine/types";
import { MatchSession, seedCommitment, type SessionSnapshot } from "../session";
import { deriveVrfMaster, type VrfLike } from "./vrf";
import type { PatternStats } from "../ai/patterns";
import type { ArenaHouse, Leaf } from "./house";
import type { ChainPhase, ChainStatus, ChainTx } from "./types";
export type { ChainPhase, ChainStatus, ChainTx } from "./types";

export type HouseLike = Pick<
  ArenaHouse,
  "publicKey" | "ensureProfile" | "createMatchArena" | "hasEntered" | "enter" | "start" | "commitRound" | "finalize" | "claim" | "cancel" | "currentRound" | "refundOwn"
>;

export const ENTRY_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 5_000; // gentle on public RPC rate limits
const PROTOCOL_FEE_BPS = 100;

const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** Retry backoff for chain writes (tests shrink it). */
export const chainTiming = { retryBaseMs: 1_500 };

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = chainTiming.retryBaseMs): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

/** What gets written to disk so a staked match survives a server restart. */
export interface OnChainSnapshot {
  version: 1;
  savedAt: number;
  player: string;
  status: ChainStatus;
  session: SessionSnapshot;
  /** vrf-v2 only: the house's private entropy (hex). Secret until the match ends. */
  vrfEntropy?: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Drives one staked match through the RitArena lifecycle:
 *
 *   house creates 1v1 arena → player enters (stakes, signs in wallet) → house enters
 *   (stakes) and starts → round 1 = seed commitment → one round per turn (log root +
 *   HP scores) → finalize winner (draw ⇒ house) → winner claims.
 *
 * The player stakes first and the house last, so if the house cannot enter, nothing
 * of the house's is locked and the arena is cancelled so the player can refund.
 * Gameplay never waits on the chain: turn commits are queued and sent in order.
 */
export class OnChainMatch {
  readonly session: MatchSession;
  readonly status: ChainStatus;
  private queue: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private entering = false;
  /** vrf-v2: the house's private entropy, committed on-chain before the VRF output exists. */
  private readonly entropy: Buffer | null;

  constructor(
    private readonly house: HouseLike,
    readonly player: PublicKey,
    stakeMicro: number,
    private readonly onUpdate: (m: OnChainMatch) => void,
    onSessionChange: (s: MatchSession) => void,
    timeoutMs: number = RULES.planningTimeoutMs,
    restore?: OnChainSnapshot,
    private readonly vrf?: VrfLike,
    aiPrior?: PatternStats,
  ) {
    this.session = new MatchSession(
      onSessionChange,
      timeoutMs,
      { onTurnResolved: (r) => this.onTurnResolved(r) },
      restore ? { restore: restore.session } : { start: false, aiPrior },
    );
    if (restore) {
      this.status = structuredClone(restore.status);
      this.entropy = restore.vrfEntropy ? Buffer.from(restore.vrfEntropy, "hex") : null;
      return;
    }
    this.entropy = vrf ? randomBytes(32) : null;
    this.status = {
      cluster: "devnet",
      phase: "creating",
      arenaId: null,
      stakeMicro,
      payoutMicro: Math.floor((stakeMicro * 2 * (10_000 - PROTOCOL_FEE_BPS)) / 10_000),
      house: house.publicKey.toBase58(),
      player: player.toBase58(),
      seedScheme: vrf ? "vrf-v2" : "commit-reveal-v1",
      seedCommitment: vrf ? seedCommitment(this.entropy!, this.session.matchId) : this.session.seedCommitment,
      txs: [],
    };
  }

  get usesVrf(): boolean {
    return this.status.seedScheme === "vrf-v2";
  }

  get arenaId() {
    return this.status.arenaId;
  }

  get terminal(): boolean {
    return ["settled", "cancelled", "failed"].includes(this.status.phase);
  }

  snapshot(): OnChainSnapshot {
    return {
      version: 1,
      savedAt: Date.now(),
      player: this.player.toBase58(),
      status: structuredClone(this.status),
      session: this.session.snapshot(),
      vrfEntropy: this.entropy?.toString("hex"),
    };
  }

  /** Rebuilds a match from disk (the session is replayed deterministically). Call `resume()` next. */
  static restore(
    house: HouseLike,
    snap: OnChainSnapshot,
    onUpdate: (m: OnChainMatch) => void,
    onSessionChange: (s: MatchSession) => void,
    timeoutMs: number = RULES.planningTimeoutMs,
    vrf?: VrfLike,
  ): OnChainMatch {
    if (snap.status.seedScheme === "vrf-v2" && !vrf) throw new Error("This match uses MagicBlock VRF but no VRF program is configured");
    return new OnChainMatch(house, new PublicKey(snap.player), snap.status.stakeMicro, onUpdate, onSessionChange, timeoutMs, snap, vrf);
  }

  /**
   * Continues a restored match from wherever the server stopped. Every chain write is
   * idempotent, so re-running a step that already landed is a no-op.
   */
  async resume(): Promise<void> {
    const phase = this.status.phase;
    if (phase === "creating") {
      // The create tx may or may not have landed; no stake can be in it yet (nobody had the arena id).
      this.status.error = "The server restarted while creating the arena. No funds were staked — start a new match.";
      this.setPhase("cancelled");
    } else if (phase === "awaiting-entry" || phase === "starting") {
      this.status.phase = "awaiting-entry";
      this.entering = false;
      this.pollTimer = setInterval(() => void this.checkEntry(), POLL_MS);
      this.onUpdate(this);
      await this.checkEntry();
    } else if (phase === "playing" || phase === "finalizing") {
      const arenaId = this.status.arenaId!;
      let posted = 0;
      try {
        posted = await this.house.currentRound(arenaId);
      } catch {
        posted = 0; // commitRound re-checks each round anyway
      }
      if (posted < 1) this.enqueueRound(1, this.seedLeaves(), { player: RULES.startingHp, house: RULES.startingHp });
      const reports = this.session.reports();
      for (const r of reports) if (r.turn + 1 > posted) this.enqueueTurn(r);
      if (this.session.finished) this.enqueueFinalize();
      this.onUpdate(this);
    }
    // settled / cancelled / failed: nothing to do; kept so the player can still see it and claim/refund.
  }

  /** Creates the arena; afterwards the player signs `enter_arena` in their wallet. */
  async begin(): Promise<void> {
    try {
      await this.track(
        "Register house profile",
        async () => {
          const sig = await this.house.ensureProfile();
          return sig ? { sig } : undefined;
        },
        { skipIfUndefined: true },
      );
      const { arenaId } = await this.track("Create 1v1 arena", async () => {
        const r = await withRetry(() => this.house.createMatchArena(this.status.stakeMicro));
        return { sig: r.tx, value: r };
      });
      this.status.arenaId = arenaId;
      this.status.entryDeadline = Date.now() + ENTRY_TIMEOUT_MS;
      this.setPhase("awaiting-entry");
      this.pollTimer = setInterval(() => void this.checkEntry(), POLL_MS);
    } catch (e) {
      this.fail(`Could not create the arena: ${errMsg(e)}`);
    }
  }

  /** Called when the client reports it signed `enter_arena` (also polled). */
  async checkEntry(): Promise<void> {
    if (this.status.phase !== "awaiting-entry" || this.entering || this.status.arenaId === null) return;
    const arenaId = this.status.arenaId;
    if (Date.now() > (this.status.entryDeadline ?? Infinity)) {
      this.stopPolling();
      await this.cancel("Entry window expired");
      return;
    }
    let entered = false;
    try {
      entered = await this.house.hasEntered(arenaId, this.player);
    } catch {
      return; // transient RPC error — next poll retries
    }
    if (!entered) return;
    this.entering = true;
    this.stopPolling();
    this.setPhase("starting");
    try {
      await this.track("House enters (stakes)", async () => ({ sig: (await withRetry(() => this.house.enter(arenaId))) ?? undefined }));
    } catch (e) {
      // Player's stake is in escrow; cancel so they can refund it.
      await this.cancel(`House could not enter: ${errMsg(e)}`, true);
      return;
    }
    if (this.usesVrf && !(await this.obtainVrfSeed(arenaId))) return;
    try {
      await this.track("Start arena", async () => ({ sig: (await withRetry(() => this.house.start(arenaId))) ?? undefined }));
    } catch (e) {
      this.fail(`Arena could not start: ${errMsg(e)}. If the server stays down, the arena can be abandoned after 30 minutes and both stakes refunded.`);
      return;
    }
    this.enqueueRound(1, this.seedLeaves(), { player: this.session.hp.HUMAN, house: this.session.hp.AI });
    this.session.start(); // before the phase change, so the persisted snapshot is already "started"
    this.setPhase("playing");
  }

  /**
   * vrf-v2: posts the commitment + VRF request in one tx, waits for MagicBlock's oracle,
   * then re-deals from sha256(entropy || vrf || matchId). Runs while the arena is still in
   * Registration, so if VRF never arrives the arena is cancelled and both stakes refunded.
   */
  private async obtainVrfSeed(arenaId: number): Promise<boolean> {
    const vrf = this.vrf!;
    const commitment = Buffer.from(this.status.seedCommitment, "hex");
    this.status.vrf = { program: vrf.programId.toBase58(), account: vrf.pda(arenaId).toBase58() };
    try {
      await this.track("Commit house entropy + request MagicBlock VRF", async () => ({
        sig: (await withRetry(() => vrf.request(arenaId, commitment))) ?? undefined,
      }));
      const acc = await this.track("MagicBlock VRF delivers randomness", async () => {
        const a = await vrf.waitFulfilled(arenaId, 60_000);
        return { value: a };
      });
      if (!acc.commitment.equals(commitment)) throw new Error("On-chain commitment does not match the house entropy");
      this.status.vrf = {
        ...this.status.vrf,
        randomness: acc.randomness.toString("hex"),
        requestedSlot: acc.requestedSlot,
        fulfilledSlot: acc.fulfilledSlot,
      };
      this.session.reseed(deriveVrfMaster(this.entropy!, acc.randomness, this.session.matchId));
      this.onUpdate(this);
      return true;
    } catch (e) {
      // Both stakes are in escrow and the arena is still in Registration: cancel, refund the house,
      // and let the player refund theirs.
      await this.cancel(`MagicBlock VRF failed: ${errMsg(e)}. The arena was cancelled — refund your stake.`, true);
      try {
        await this.track("House refunds its entry", async () => ({ sig: (await withRetry(() => this.house.refundOwn(arenaId))) ?? undefined }));
      } catch {
        /* recorded; chain:recover retries */
      }
      return false;
    }
  }

  /** Player backs out before entering. */
  async cancelByPlayer(): Promise<void> {
    if (this.status.phase !== "awaiting-entry") return;
    this.stopPolling();
    await this.cancel("Cancelled by player");
  }

  dispose(): void {
    this.stopPolling();
    this.session.dispose();
  }

  // ------------------------------------------------------------------ internals

  private seedLeaves(): Leaf[] {
    return [
      {
        kind: "seed-commitment",
        matchId: this.session.matchId,
        scheme: this.status.seedScheme ?? "commit-reveal-v1",
        commitment: this.status.seedCommitment,
        vrfAccount: this.status.vrf?.account ?? "",
        vrfRandomness: this.status.vrf?.randomness ?? "",
        rules: this.session.versions.rules,
        deck: this.session.versions.deck,
        ai: this.session.versions.ai,
      },
    ];
  }

  private onTurnResolved(report: TurnReport): void {
    this.enqueueTurn(report);
    if (this.session.finished) this.enqueueFinalize();
  }

  /** Leaves hash the full report (incl. private discard/draw identities) — only the root goes on-chain. */
  private enqueueTurn(report: TurnReport): void {
    this.enqueueRound(
      report.turn + 1,
      [
        { kind: "turn", matchId: this.session.matchId, turn: report.turn, digest: digest(report) },
        { kind: "hp", side: "HUMAN", hp: report.hpAfter.HUMAN },
        { kind: "hp", side: "AI", hp: report.hpAfter.AI },
      ],
      { player: report.hpAfter.HUMAN, house: report.hpAfter.AI },
    );
  }

  private enqueueRound(round: number, leaves: Leaf[], hp: { player: number; house: number }): void {
    const arenaId = this.status.arenaId!;
    this.enqueue(round === 1 ? "Commit shuffle seed (round 1)" : `Commit turn ${round - 1} log`, () =>
      this.house.commitRound(arenaId, round, this.player, leaves, hp),
    );
  }

  private enqueueFinalize(): void {
    const { outcome, settlement } = this.session.outcome;
    const winner = settlement === "HUMAN_WIN" ? "PLAYER" : "HOUSE"; // draws settle to the house
    this.status.winner = winner;
    this.status.seedReveal = (this.usesVrf ? this.entropy?.toString("hex") : this.session.revealSeed()) ?? undefined;
    this.setPhase("finalizing");
    const arenaId = this.status.arenaId!;
    const leaves: Leaf[] = [
      { kind: "final", matchId: this.session.matchId, outcome: outcome ?? "", settlement: settlement ?? "", seed: this.status.seedReveal ?? "" },
    ];
    this.queue = this.queue.then(async () => {
      try {
        await this.track(`Finalize — ${winner === "PLAYER" ? "player" : "house"} wins`, async () => ({
          sig: (await withRetry(() => this.house.finalize(arenaId, this.player, winner, leaves))) ?? undefined,
        }));
      } catch (e) {
        this.fail(`Finalize failed: ${errMsg(e)}. The server will need to retry; if it can't, the arena can be abandoned after 30 minutes for refunds.`);
        return;
      }
      // The result is final once finalize lands; collecting the house's pot is a separate step.
      this.status.playerMustClaim = winner === "PLAYER";
      if (winner === "HOUSE") {
        try {
          await this.track("House claims pot", async () => ({ sig: (await withRetry(() => this.house.claim(arenaId), 4)) ?? undefined }));
        } catch (e) {
          this.status.error = `Result is final, but the house's claim failed (${errMsg(e)}). Recover with \`npm run chain:claim -- ${arenaId}\`.`;
        }
      }
      this.setPhase("settled");
    });
  }

  private enqueue(label: string, fn: () => Promise<string | null>): void {
    this.queue = this.queue.then(async () => {
      try {
        await this.track(label, async () => ({ sig: (await withRetry(fn)) ?? undefined }));
      } catch {
        // Recorded as a failed tx; gameplay continues and later rounds still post.
      }
    });
  }

  private async cancel(reason: string, playerCanRefund = false): Promise<void> {
    const arenaId = this.status.arenaId;
    if (arenaId !== null) {
      try {
        await this.track("Cancel arena", async () => ({ sig: await withRetry(() => this.house.cancel(arenaId)) }));
      } catch {
        /* recorded */
      }
    }
    this.status.error = reason;
    this.status.playerCanRefund = playerCanRefund;
    this.setPhase("cancelled");
  }

  private fail(message: string): void {
    this.stopPolling();
    this.status.error = message;
    this.setPhase("failed");
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private setPhase(phase: ChainPhase): void {
    this.status.phase = phase;
    this.onUpdate(this);
  }

  private pushTx(tx: ChainTx): ChainTx {
    this.status.txs.push(tx);
    this.onUpdate(this);
    return tx;
  }

  /** Runs one chain step, recording it as a pending → ok/failed tx entry. */
  private async track<T = undefined>(
    label: string,
    fn: () => Promise<{ sig?: string; value?: T } | undefined>,
    opts: { skipIfUndefined?: boolean } = {},
  ): Promise<T> {
    const tx: ChainTx = { label, status: "pending" };
    if (!opts.skipIfUndefined) this.pushTx(tx);
    try {
      const r = await fn();
      if (opts.skipIfUndefined && !r) return undefined as T;
      if (opts.skipIfUndefined) this.status.txs.push(tx);
      tx.status = "ok";
      tx.sig = r?.sig;
      this.onUpdate(this);
      return r?.value as T;
    } catch (e) {
      tx.status = "failed";
      tx.error = errMsg(e);
      if (opts.skipIfUndefined && !this.status.txs.includes(tx)) this.status.txs.push(tx);
      this.onUpdate(this);
      console.error(`[chain arena ${this.status.arenaId ?? "-"}] ${label} failed: ${tx.error}`);
      throw e;
    }
  }
}
