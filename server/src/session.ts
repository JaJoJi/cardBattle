import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AI_VERSION, chooseCards } from "./ai/bot";
import { bothCommitted, commitSelection, createMatch, resolveTurn } from "./engine/engine";
import { projectFor } from "./engine/projection";
import { RULES } from "./engine/rules";
import { createMatchRngs, type MatchRngs } from "./engine/rng";
import { DECK_VERSION } from "./engine/cards";
import type { MatchState, PlayerView, TurnReport } from "./engine/types";

export type CommitResult = { ok: true } | { ok: false; reason: string };

export interface SessionHooks {
  /** Called after every resolved turn, with the full (private) report. Server-side only. */
  onTurnResolved?: (report: TurnReport, session: MatchSession) => void;
}

/** sha256(master || matchId) — published before play so the shuffle can be verified afterwards. */
export function seedCommitment(master: Buffer, matchId: string): string {
  return createHash("sha256").update(master).update(matchId).digest("hex");
}

/**
 * One human-vs-AI match. Holds the private state; exposes only projections.
 *
 * Commit order: the AI locks its selection at the start of every planning phase,
 * before the human can submit, so the AI's choice can never depend on the human's.
 */
/**
 * Everything needed to rebuild a match exactly: the engine, AI and RNG streams are
 * deterministic given (matchId, master), so replaying the human's commits in order
 * reproduces every AI choice, shuffle, discard and HP value.
 * Contains the secret seed — persist it only in private server storage.
 */
export interface SessionSnapshot {
  token: string;
  matchId: string;
  master: string; // hex
  started: boolean;
  humanCommits: string[][];
  rulesVersion: string;
  deckVersion: string;
  aiVersion: string;
}

export class MatchSession {
  readonly token: string;
  private readonly state: MatchState;
  private readonly rngs: MatchRngs;
  private readonly master: Buffer;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private replaying = false;
  /** Every accepted human selection (incl. timeout passes), in turn order. */
  private readonly humanCommits: string[][] = [];
  lastActivity = Date.now();

  constructor(
    private readonly onChange: (s: MatchSession) => void,
    private readonly timeoutMs: number = RULES.planningTimeoutMs,
    private readonly hooks: SessionHooks = {},
    opts: { start?: boolean; restore?: SessionSnapshot } = {},
  ) {
    const r = opts.restore;
    if (r && (r.rulesVersion !== RULES.version || r.deckVersion !== DECK_VERSION || r.aiVersion !== AI_VERSION)) {
      throw new Error(`Cannot restore match ${r.matchId}: it was played with ${r.rulesVersion}/${r.deckVersion}/${r.aiVersion}`);
    }
    this.token = r?.token ?? randomBytes(24).toString("base64url");
    const matchId = r?.matchId ?? randomUUID();
    this.master = r ? Buffer.from(r.master, "hex") : randomBytes(32);
    this.rngs = createMatchRngs(matchId, { rules: RULES.version, deck: DECK_VERSION }, this.master);
    this.state = createMatch({
      matchId,
      aiVersion: AI_VERSION,
      humanDeckRng: this.rngs.humanDeck,
      aiDeckRng: this.rngs.aiDeck,
    });
    if (r) {
      if (r.started) this.replay(r.humanCommits);
    } else if (opts.start !== false) this.start();
  }

  snapshot(): SessionSnapshot {
    return {
      token: this.token,
      matchId: this.state.matchId,
      master: this.master.toString("hex"),
      started: this.started,
      humanCommits: this.humanCommits.map((c) => [...c]),
      rulesVersion: this.state.rulesVersion,
      deckVersion: this.state.deckVersion,
      aiVersion: this.state.aiVersion,
    };
  }

  /** Full private report history (server-side only, e.g. to rebuild chain round logs). */
  reports(): TurnReport[] {
    return this.state.history;
  }

  /** Rebuilds state by replaying recorded commits; hooks and change events are suppressed. */
  private replay(commits: string[][]): void {
    this.replaying = true;
    try {
      this.start();
      for (const c of commits) {
        const r = commitSelection(this.state, "HUMAN", c);
        if (!r.ok) throw new Error(`Replay diverged at turn ${this.state.turn}: ${r.reason}`);
        this.advance();
      }
    } finally {
      this.replaying = false;
    }
  }

  get matchId() {
    return this.state.matchId;
  }
  get isStarted() {
    return this.started;
  }
  get finished() {
    return this.state.phase === "FINISHED";
  }
  get outcome() {
    return { outcome: this.state.outcome, settlement: this.state.settlement };
  }
  get hp() {
    return { HUMAN: this.state.players.HUMAN.hp, AI: this.state.players.AI.hp };
  }
  get versions() {
    return { rules: this.state.rulesVersion, deck: this.state.deckVersion, ai: this.state.aiVersion };
  }
  /** Commitment to the secret shuffle seed; safe to publish at any time. */
  get seedCommitment(): string {
    return seedCommitment(this.master, this.state.matchId);
  }
  /** The secret seed — only released once the match is over. */
  revealSeed(): string | null {
    return this.finished ? this.master.toString("hex") : null;
  }

  /** Begins planning (deferred for on-chain matches until the arena is live). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.beginPlanning();
  }

  humanView(): { view: PlayerView; deadline: number | null } {
    return { view: projectFor(this.state, "HUMAN"), deadline: this.deadline };
  }

  commitHuman(turn: unknown, cards: unknown): CommitResult {
    this.lastActivity = Date.now();
    if (!this.started) return { ok: false, reason: "Match has not started yet" };
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
    this.humanCommits.push([...this.state.commits.HUMAN!]);
    const report = resolveTurn(this.state, this.rngs.resolution);
    if (this.replaying) {
      if (this.state.phase !== "FINISHED") this.beginPlanning();
      return;
    }
    // Log only public facts — never hands, decks or pending selections.
    console.log(`[match ${this.state.matchId}] turn ${this.state.history.length} resolved; HP H=${this.state.players.HUMAN.hp} A=${this.state.players.AI.hp}`);
    if (this.state.phase === "FINISHED") {
      console.log(`[match ${this.state.matchId}] finished: ${this.state.outcome} → ${this.state.settlement}`);
    } else this.beginPlanning();
    this.hooks.onTurnResolved?.(report, this);
    this.onChange(this);
  }
}
