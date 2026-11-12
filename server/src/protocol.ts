// WebSocket message contract between the browser and the authoritative server.
import type { ChainStatus } from "./chain/types";
import type { CardDefinition, PlayerView } from "./engine/types";

export type PlayMode = "mock" | "chain";

export interface ServerConfig {
  chainEnabled: boolean;
  chainDisabledReason?: string;
  cluster: "devnet";
  rpcUrl: string;
  house?: string; // base58 house/oracle wallet
  programId?: string;
  /** Set when staked matches seed from MagicBlock VRF. */
  vrfProgramId?: string;
}

export type ClientMessage =
  | { type: "resume"; token: string }
  /** Ask for a one-time message to sign, proving ownership of `player` for this stake. */
  | { type: "chain-challenge"; player: string; stakeMicro: number }
  /**
   * mock = free practice match; chain = staked RitArena devnet match for `player`,
   * which needs `nonce` + `signature` (base58 ed25519 over the challenge message).
   */
  | { type: "new-match"; mode?: PlayMode; stakeMicro?: number; player?: string; nonce?: string; signature?: string }
  /** `turn` binds the submission to a turn so stale/replayed messages are rejected. */
  | { type: "commit"; turn: number; cards: string[] }
  /** Player signed enter_arena in their wallet — server re-checks the chain now. */
  | { type: "chain-entered" }
  | { type: "chain-cancel" };

export type ServerMessage =
  | { type: "welcome"; catalog: CardDefinition[]; config: ServerConfig }
  | { type: "session"; token: string; mode: PlayMode }
  | { type: "state"; view: PlayerView; deadline: number | null }
  | { type: "chain"; status: ChainStatus }
  | { type: "chain-challenge"; nonce: string; message: string }
  | { type: "no-session" }
  | { type: "error"; message: string };
