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
  /** The LLM champion being challenged. */
  opponent?: { model: string; name: string };
  /** Locked prize on a player win: the pot plus `topUpMicro` sent by the house. */
  prizeMicro?: number;
  topUpMicro?: number;
  /**
   * commit-reveal-v1: commitment = sha256(seed || matchId), seed revealed at the end.
   * vrf-v2: commitment = sha256(entropy || matchId) posted with the MagicBlock VRF request;
   *         seed = sha256("RITARENA_SEED_V2" || entropy || vrf || matchId); entropy revealed at the end.
   */
  seedScheme?: "commit-reveal-v1" | "vrf-v2";
  seedCommitment: string;
  /** Revealed after the match: the seed (v1) or the house's private entropy (v2). */
  seedReveal?: string;
  vrf?: { program: string; account: string; randomness?: string; requestedSlot?: number; fulfilledSlot?: number };
  winner?: "PLAYER" | "HOUSE";
  /** The player won and must sign `claim_prize` from their wallet. */
  playerMustClaim?: boolean;
  /** The arena was cancelled after the player entered — they can sign `refund_entry`. */
  playerCanRefund?: boolean;
  entryDeadline?: number;
  txs: ChainTx[];
  error?: string;
}
