// Pure types shared with the web client (type-only). No Node or Solana imports here.

export type ChainPhase = "creating" | "awaiting-entry" | "starting" | "playing" | "finalizing" | "settled" | "cancelled" | "failed";

export interface ChainTx {
  label: string;
  status: "pending" | "ok" | "failed";
  sig?: string;
  error?: string;
}

/** Public, per-match on-chain status sent to the player. Contains no hidden game data. */
export interface ChainStatus {
  cluster: "devnet";
  phase: ChainPhase;
  arenaId: number | null;
  stakeMicro: number;
  /** What the winner receives: 2 × stake minus the 1% protocol fee (creator fee is 0). */
  payoutMicro: number;
  house: string;
  player: string;
  seedCommitment: string;
  seedReveal?: string;
  winner?: "PLAYER" | "HOUSE";
  /** The player won and must sign `claim_prize` from their wallet. */
  playerMustClaim?: boolean;
  /** The arena was cancelled after the player entered — they can sign `refund_entry`. */
  playerCanRefund?: boolean;
  entryDeadline?: number;
  txs: ChainTx[];
  error?: string;
}
