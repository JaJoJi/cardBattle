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

export interface OpponentInfo {
  /** "bot" in practice, otherwise the OpenRouter model id. */
  model: string;
  name: string;
  /** The LLM is still choosing this turn's cards. */
  thinking: boolean;
  /** Its per-turn reasons and costs — only once the match is over (they could hint at its hand). */
  thoughts?: { turn: number; cards: string[]; reason: string; outcome: string; costUsd: number; ms: number }[];
}

export interface QuoteView {
  id: string;
  model: string;
  priceMicro: number;
  prizeMicro: number;
  topUpMicro: number;
  expiresAt: number;
}

export type ClientMessage =
  | { type: "resume"; token: string }
  /** Ask for a one-time message to sign, proving ownership of `player` for this stake. */
  /** Quote a challenge against LLM champion `model`, plus a one-time message to sign for it. */
  | { type: "chain-challenge"; player: string; model: string }
  /**
   * mock = free practice match vs the house bot; chain = staked challenge of an LLM champion
   * for `player`, which needs the `quoteId` + `nonce` + `signature` (base58 ed25519 over the message).
   */
  | { type: "new-match"; mode?: PlayMode; model?: string; quoteId?: string; player?: string; nonce?: string; signature?: string }
  /** `turn` binds the submission to a turn so stale/replayed messages are rejected. */
  | { type: "commit"; turn: number; cards: string[] }
  /** Player signed enter_arena in their wallet — server re-checks the chain now. */
  | { type: "chain-entered" }
  | { type: "chain-cancel" };

export type ServerMessage =
  | { type: "welcome"; catalog: CardDefinition[]; config: ServerConfig }
  | { type: "session"; token: string; mode: PlayMode }
  | { type: "state"; view: PlayerView; deadline: number | null; opponent?: OpponentInfo }
  | { type: "chain"; status: ChainStatus }
  | { type: "chain-challenge"; nonce: string; message: string; quote: QuoteView }
  | { type: "no-session" }
  | { type: "error"; message: string };
