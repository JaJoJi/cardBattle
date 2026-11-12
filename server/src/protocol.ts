// WebSocket message contract between the browser and the authoritative server.
import type { CardDefinition, PlayerView } from "./engine/types";

export type ClientMessage =
  | { type: "resume"; token: string }
  | { type: "new-match" }
  /** `turn` binds the submission to a turn so stale/replayed messages are rejected. */
  | { type: "commit"; turn: number; cards: string[] };

export type ServerMessage =
  | { type: "welcome"; catalog: CardDefinition[] }
  | { type: "session"; token: string }
  | { type: "state"; view: PlayerView; deadline: number | null }
  | { type: "no-session" }
  | { type: "error"; message: string };
