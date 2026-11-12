import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AI_VERSIONS, createAi, defaultAiVersion, type AiPlayer } from "./ai";
import type { ObservedPlay } from "./ai/memory";
import type { PatternStats } from "./ai/patterns";
import { bothCommitted, commitSelection, createMatch, resolveTurn } from "./engine/engine";
import { projectFor } from "./engine/projection";
import { RULES } from "./engine/rules";
import { createMatchRngs, createSeededRng, deriveSeed, type MatchRngs } from "./engine/rng";
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
  /** The AI's selection each turn; replayed verbatim so restores never re-run the search. */
  aiCommits?: string[][];
  /** Frozen pattern prior (this player's earlier matches) the AI started with. */
  aiPrior?: PatternStats;
  rulesVersion: string;
  deckVersion: string;
  aiVersion: string;
}

export class MatchSession {
  readonly token: string;
  private state: MatchState;
  private rngs: MatchRngs;
  private master: Buffer;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private replaying = false;
  /** Every accepted human selection (incl. timeout passes), in turn order. */
  private readonly humanCommits: string[][] = [];
  private readonly aiCommits: string[][] = [];
  private replayAi: string[][] | null = null;
  private readonly ai: AiPlayer;
  private readonly aiPrior?: PatternStats;
  lastActivity = Date.now();

  constructor(
    private readonly onChange: (s: MatchSession) => void,
    private readonly timeoutMs: number = RULES.planningTimeoutMs,
    private readonly hooks: SessionHooks = {},
    opts: { start?: boolean; restore?: SessionSnapshot; aiVersion?: string; aiPrior?: PatternStats } = {},
  ) {
    const r = opts.restore;
    if (r && (r.rulesVersion !== RULES.version || r.deckVersion !== DECK_VERSION || !(AI_VERSIONS as readonly string[]).includes(r.aiVersion))) {
      throw new Error(`Cannot restore match ${r.matchId}: it was played with ${r.rulesVersion}/${r.deckVersion}/${r.aiVersion}`);
    }
    // A match keeps the AI version (and frozen prior) it started with, even across upgrades.
    const aiVersion = r?.aiVersion ?? opts.aiVersion ?? defaultAiVersion();
    this.aiPrior = r ? r.aiPrior : opts.aiPrior;
    this.ai = createAi(aiVersion, this.aiPrior);
    this.token = r?.token ?? randomBytes(24).toString("base64url");
    const matchId = r?.matchId ?? randomUUID();
    this.master = r ? Buffer.from(r.master, "hex") : randomBytes(32);
    this.rngs = createMatchRngs(matchId, { rules: RULES.version, deck: DECK_VERSION }, this.master);
    this.state = createMatch({
      matchId,
      aiVersion,
      humanDeckRng: this.rngs.humanDeck,
      aiDeckRng: this.rngs.aiDeck,
    });
    if (r) {
      if (r.started) this.replay(r.humanCommits, r.aiCommits ?? null);
    } else if (opts.start !== false) this.start();
  }

  /**
   * Replaces the shuffle seed before play begins (on-chain VRF mode: the seed only exists
   * once MagicBlock's randomness is delivered). Re-deals both decks from the new seed.
   */
  reseed(master: Buffer): void {
    if (this.started) throw new Error("Cannot reseed a match that has started");
    this.master = Buffer.from(master);
    this.rngs = createMatchRngs(this.state.matchId, { rules: RULES.version, deck: DECK_VERSION }, this.master);
    this.state = createMatch({
      matchId: this.state.matchId,
      aiVersion: this.state.aiVersion,
      humanDeckRng: this.rngs.humanDeck,
      aiDeckRng: this.rngs.aiDeck,
    });
  }

  snapshot(): SessionSnapshot {
    return {
      token: this.token,
      matchId: this.state.matchId,
      master: this.master.toString("hex"),
      started: this.started,
      humanCommits: this.humanCommits.map((c) => [...c]),
      aiCommits: this.aiCommits.map((c) => [...c]),
      aiPrior: this.aiPrior,
      rulesVersion: this.state.rulesVersion,
      deckVersion: this.state.deckVersion,
      aiVersion: this.state.aiVersion,
    };
  }

  /** Full private report history (server-side only, e.g. to rebuild chain round logs). */
  reports(): TurnReport[] {
    return this.state.history;
  }

  /** Revealed human decisions the AI observed this match (feeds the per-player profile). */
  aiObservations(): ObservedPlay[] {
    return this.ai.matchObservations();
  }

  /** Rebuilds state by replaying recorded commits; hooks and change events are suppressed. */
  private replay(commits: string[][], aiCommits: string[][] | null): void {
    this.replaying = true;
    this.replayAi = aiCommits ? aiCommits.map((c) => [...c]) : null;
    try {
      this.start();
      for (const c of commits) {
        const r = commitSelection(this.state, "HUMAN", c);
        if (!r.ok) throw new Error(`Replay diverged at turn ${this.state.turn}: ${r.reason}`);
        this.advance();
      }
    } finally {
      this.replaying = false;
      this.replayAi = null;
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
    // The AI only ever sees its own projection. During a replay it re-observes the same
    // views (rebuilding its memory) but its recorded choice is used verbatim.
    const view = projectFor(this.state, "AI");
    const recorded = this.replayAi?.[this.aiCommits.length];
    let aiChoice: string[];
    if (recorded) {
      this.ai.observe(view);
      aiChoice = recorded;
    } else {
      // Per-turn AI randomness derived from the match seed: reproducible, independent of history.
      aiChoice = this.ai.decide(view, createSeededRng(deriveSeed(this.master, `RITARENA_AI_TURN_V1|${this.state.turn}`)));
    }
    const r = commitSelection(this.state, "AI", aiChoice);
    if (!r.ok) commitSelection(this.state, "AI", []); // defensive: never stall the match
    this.aiCommits.push([...(this.state.commits.AI ?? [])]);
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
    if (this.state.phase === "FINISHED") this.ai.observe(projectFor(this.state, "AI"));
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
