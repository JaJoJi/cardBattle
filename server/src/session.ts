import { randomBytes, randomUUID } from "node:crypto";
import { AI_VERSION, chooseCards } from "./ai/bot";
import { bothCommitted, commitSelection, createMatch, resolveTurn } from "./engine/engine";
import { projectFor } from "./engine/projection";
import { RULES } from "./engine/rules";
import { createMatchRngs, type MatchRngs } from "./engine/rng";
import { DECK_VERSION } from "./engine/cards";
import type { MatchState, PlayerView } from "./engine/types";

export type CommitResult = { ok: true } | { ok: false; reason: string };

/**
 * One human-vs-AI match. Holds the private state; exposes only projections.
 *
 * Commit order: the AI locks its selection at the start of every planning phase,
 * before the human can submit, so the AI's choice can never depend on the human's.
 */
export class MatchSession {
  readonly token = randomBytes(24).toString("base64url");
  private readonly state: MatchState;
  private readonly rngs: MatchRngs;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  lastActivity = Date.now();

  constructor(
    private readonly onChange: (s: MatchSession) => void,
    private readonly timeoutMs: number = RULES.planningTimeoutMs,
  ) {
    const matchId = randomUUID();
    this.rngs = createMatchRngs(matchId, { rules: RULES.version, deck: DECK_VERSION }, randomBytes(32));
    this.state = createMatch({
      matchId,
      aiVersion: AI_VERSION,
      humanDeckRng: this.rngs.humanDeck,
      aiDeckRng: this.rngs.aiDeck,
    });
    this.beginPlanning();
  }

  get matchId() {
    return this.state.matchId;
  }
  get finished() {
    return this.state.phase === "FINISHED";
  }

  humanView(): { view: PlayerView; deadline: number | null } {
    return { view: projectFor(this.state, "HUMAN"), deadline: this.deadline };
  }

  commitHuman(turn: unknown, cards: unknown): CommitResult {
    this.lastActivity = Date.now();
    if (turn !== this.state.turn) return { ok: false, reason: "Stale submission for a different turn" };
    const result = commitSelection(this.state, "HUMAN", cards);
    if (!result.ok) return result;
    this.advance();
    return result;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private beginPlanning(): void {
    if (this.state.phase !== "PLANNING") return;
    // The AI only ever sees its own projection.
    const aiChoice = chooseCards(projectFor(this.state, "AI"), this.rngs.ai);
    const r = commitSelection(this.state, "AI", aiChoice);
    if (!r.ok) commitSelection(this.state, "AI", []); // defensive: never stall the match
    this.deadline = Date.now() + this.timeoutMs;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  private onTimeout(): void {
    if (this.state.phase !== "PLANNING" || this.state.commits.HUMAN) return;
    commitSelection(this.state, "HUMAN", []); // timeout = pass (PROPOSED policy)
    this.advance();
  }

  private advance(): void {
    if (!bothCommitted(this.state)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    resolveTurn(this.state, this.rngs.resolution);
    // Log only public facts — never hands, decks or pending selections.
    console.log(`[match ${this.state.matchId}] turn ${this.state.history.length} resolved; HP H=${this.state.players.HUMAN.hp} A=${this.state.players.AI.hp}`);
    if (this.state.phase === "FINISHED") {
      console.log(`[match ${this.state.matchId}] finished: ${this.state.outcome} → ${this.state.settlement}`);
    } else this.beginPlanning();
    this.onChange(this);
  }
}
