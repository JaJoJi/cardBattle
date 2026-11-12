import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { RULES } from "../engine/rules";
import type { TurnReport } from "../engine/types";
import { MatchSession } from "../session";
import type { ArenaHouse, Leaf } from "./house";
import type { ChainPhase, ChainStatus, ChainTx } from "./types";
export type { ChainPhase, ChainStatus, ChainTx } from "./types";

export type HouseLike = Pick<
  ArenaHouse,
  "publicKey" | "ensureProfile" | "createMatchArena" | "hasEntered" | "enter" | "start" | "commitRound" | "finalize" | "cancel"
>;

export const ENTRY_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 3_000;
const PROTOCOL_FEE_BPS = 100;

const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1_500): Promise<T> {
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

  constructor(
    private readonly house: HouseLike,
    readonly player: PublicKey,
    stakeMicro: number,
    private readonly onUpdate: (m: OnChainMatch) => void,
    onSessionChange: (s: MatchSession) => void,
    timeoutMs: number = RULES.planningTimeoutMs,
  ) {
    this.session = new MatchSession(onSessionChange, timeoutMs, { onTurnResolved: (r) => this.onTurnResolved(r) }, { start: false });
    this.status = {
      cluster: "devnet",
      phase: "creating",
      arenaId: null,
      stakeMicro,
      payoutMicro: Math.floor((stakeMicro * 2 * (10_000 - PROTOCOL_FEE_BPS)) / 10_000),
      house: house.publicKey.toBase58(),
      player: player.toBase58(),
      seedCommitment: this.session.seedCommitment,
      txs: [],
    };
  }

  get arenaId() {
    return this.status.arenaId;
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
      await this.track("House enters (stakes)", async () => ({ sig: await withRetry(() => this.house.enter(arenaId)) }));
    } catch (e) {
      // Player's stake is in escrow; cancel so they can refund it.
      await this.cancel(`House could not enter: ${errMsg(e)}`, true);
      return;
    }
    try {
      await this.track("Start arena", async () => ({ sig: await withRetry(() => this.house.start(arenaId)) }));
    } catch (e) {
      this.fail(`Arena could not start: ${errMsg(e)}. If the server stays down, the arena can be abandoned after 30 minutes and both stakes refunded.`);
      return;
    }
    this.enqueueRound(1, [
      {
        kind: "seed-commitment",
        matchId: this.session.matchId,
        commitment: this.session.seedCommitment,
        rules: this.session.versions.rules,
        deck: this.session.versions.deck,
        ai: this.session.versions.ai,
      },
    ]);
    this.setPhase("playing");
    this.session.start();
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

  private onTurnResolved(report: TurnReport): void {
    // Leaves hash the full report (incl. private discard/draw identities) — only the root goes on-chain.
    this.enqueueRound(report.turn + 1, [
      { kind: "turn", matchId: this.session.matchId, turn: report.turn, digest: digest(report) },
      { kind: "hp", side: "HUMAN", hp: report.hpAfter.HUMAN },
      { kind: "hp", side: "AI", hp: report.hpAfter.AI },
    ]);
    if (this.session.finished) this.enqueueFinalize();
  }

  private enqueueRound(round: number, leaves: Leaf[]): void {
    const arenaId = this.status.arenaId!;
    const hp = this.session.hp;
    this.enqueue(round === 1 ? "Commit shuffle seed (round 1)" : `Commit turn ${round - 1} log`, () =>
      this.house.commitRound(arenaId, round, this.player, leaves, { player: hp.HUMAN, house: hp.AI }),
    );
  }

  private enqueueFinalize(): void {
    const { outcome, settlement } = this.session.outcome;
    const winner = settlement === "HUMAN_WIN" ? "PLAYER" : "HOUSE"; // draws settle to the house
    this.status.winner = winner;
    this.status.seedReveal = this.session.revealSeed() ?? undefined;
    this.setPhase("finalizing");
    const arenaId = this.status.arenaId!;
    const leaves: Leaf[] = [
      { kind: "final", matchId: this.session.matchId, outcome: outcome ?? "", settlement: settlement ?? "", seed: this.status.seedReveal ?? "" },
    ];
    this.queue = this.queue.then(async () => {
      try {
        const r = await this.track(`Finalize — ${winner === "PLAYER" ? "player" : "house"} wins`, async () => {
          const res = await withRetry(() => this.house.finalize(arenaId, this.player, winner, leaves));
          return { sig: res.finalizeTx, value: res };
        });
        if (r.claimTx) this.pushTx({ label: "House claims pot", status: "ok", sig: r.claimTx });
        this.status.playerMustClaim = winner === "PLAYER";
        this.setPhase("settled");
      } catch (e) {
        this.fail(`Finalize failed: ${errMsg(e)}. The server will need to retry; if it can't, the arena can be abandoned after 30 minutes for refunds.`);
      }
    });
  }

  private enqueue(label: string, fn: () => Promise<string>): void {
    this.queue = this.queue.then(async () => {
      try {
        await this.track(label, async () => ({ sig: await withRetry(fn) }));
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
