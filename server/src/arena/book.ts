import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SERVER_ROOT } from "../chain/config";
import { LLM_MODELS, modelById, type LlmModel } from "../ai/llm/models";
import { BOT_ELO, ELO_START, eloUpdate } from "./elo";
import { PRICING, avgCostUsd, priceMicro, prizeMicro, smoothedWinRate, splitFee, type ModelRecord } from "./pricing";

/**
 * The arena's books: per-model results (the public benchmark), bounty pools, and price quotes.
 *
 * Money (USDC micro) maps onto the existing equal-stake 1v1 RitArena arena:
 *   the player stakes the price P; the house stakes P from the model's bounty.
 *   player wins → claims the pot (2P − 1%), and the house transfers prize − pot on top;
 *   house wins (draws too) → claims the pot; the player's half, minus agent cost and the
 *   platform cut, grows the bounty.
 * Bounties are a ledger inside the house wallet, not separate on-chain accounts (MVP).
 */

/** RitArena takes 1% of the 2P pot. */
const POT_FEE_BPS = 100;
export const potMicro = (price: number) => Math.floor((2 * price * (10_000 - POT_FEE_BPS)) / 10_000);
/** The house's direct transfer that brings a player win up to the locked prize. */
export const topUpMicro = (price: number, prize: number) => Math.max(0, prize - potMicro(price));

const QUOTE_TTL_MS = 5 * 60_000;
const COST_WINDOW = 20;
/** Fallback per-match cost before any real sample: ~15 turns × ~1.6k prompt + ~200 out tokens. */
export const estimateMatchUsd = (m: LlmModel) => (15 * (1_600 * m.inPerM + 200 * m.outPerM)) / 1e6;

interface ModelBook extends ModelRecord {
  bountyMicro: number;
  /** Worst-case liabilities of matches in progress. */
  reservedMicro: number;
  /** Total the house put in to keep this bounty at its floor. */
  subsidyMicro: number;
  platformMicro: number;
  /** Elo across human and seed-benchmark games. */
  elo?: number;
  /** Seed-benchmark games vs house bots (score counts draws ½). Not used for pricing. */
  benchGames?: number;
  benchScore?: number;
}

interface BookFile {
  models: Record<string, ModelBook>;
  /** Accepted, unsettled matches (by match id) so a restart settles them correctly. */
  open: Record<string, OpenMatch>;
  /** Player Elo by wallet. */
  players?: Record<string, number>;
  /** Benchmark seeds already folded into ratings (each game counts once). */
  benchApplied?: string[];
}

export interface Quote {
  id: string;
  model: string;
  wallet: string;
  priceMicro: number;
  prizeMicro: number;
  /** House transfer on a player win, on top of the arena pot. */
  topUpMicro: number;
  expiresAt: number;
}

interface OpenMatch {
  model: string;
  wallet?: string;
  priceMicro: number;
  prizeMicro: number;
  liabilityMicro: number;
}

export interface ModelCard {
  id: string;
  name: string;
  vendor: string;
  logo: string;
  elo: number;
  /** Seed-benchmark record vs house bots. */
  benchGames: number;
  benchWinRate: number | null;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Raw model win rate vs humans (draws ½), null before any game. */
  winRate: number | null;
  /** Smoothed rate used for pricing. */
  pricingWinRate: number;
  avgCostUsd: number;
  priceMicro: number;
  prizeMicro: number;
  bountyMicro: number;
}

const blank = (): ModelBook => ({ wins: 0, losses: 0, draws: 0, recentCostUsd: [], bountyMicro: 0, reservedMicro: 0, subsidyMicro: 0, platformMicro: 0 });

export class ArenaBook {
  private data: BookFile;
  private readonly quotes = new Map<string, Quote>();

  constructor(private readonly file: string | null = resolve(SERVER_ROOT, "data", "arena-book.json")) {
    this.data = { models: {}, open: {} };
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8")) as BookFile;
    for (const m of LLM_MODELS) this.data.models[m.id] ??= blank();
  }

  private book(model: string): ModelBook {
    if (!modelById(model)) throw new Error(`Unknown model ${model}`);
    return this.data.models[model];
  }

  /** Bounty after reservations and before the house floor top-up. */
  private freeBounty(b: ModelBook) {
    return Math.max(b.bountyMicro, PRICING.bountyFloorMicro) - b.reservedMicro;
  }

  card(model: string): ModelCard {
    const m = modelById(model)!;
    const b = this.book(model);
    const games = b.wins + b.losses + b.draws;
    const price = priceMicro(b, estimateMatchUsd(m));
    const benchGames = b.benchGames ?? 0;
    return {
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      logo: m.logo,
      elo: Math.round(b.elo ?? ELO_START),
      benchGames,
      benchWinRate: benchGames ? (b.benchScore ?? 0) / benchGames : null,
      games,
      wins: b.wins,
      losses: b.losses,
      draws: b.draws,
      winRate: games ? (b.wins + b.draws / 2) / games : null,
      pricingWinRate: smoothedWinRate(b),
      avgCostUsd: avgCostUsd(b, estimateMatchUsd(m)),
      priceMicro: price,
      prizeMicro: prizeMicro(price, this.freeBounty(b)),
      bountyMicro: Math.max(b.bountyMicro, PRICING.bountyFloorMicro),
    };
  }

  leaderboard(): ModelCard[] {
    return LLM_MODELS.map((m) => this.card(m.id)).sort((a, b) => b.elo - a.elo || b.pricingWinRate - a.pricingWinRate);
  }

  quote(model: string, wallet: string, now = Date.now()): Quote {
    const c = this.card(model);
    const q: Quote = {
      id: randomBytes(12).toString("base64url"),
      model,
      wallet,
      priceMicro: c.priceMicro,
      prizeMicro: c.prizeMicro,
      topUpMicro: topUpMicro(c.priceMicro, c.prizeMicro),
      expiresAt: now + QUOTE_TTL_MS,
    };
    this.quotes.set(q.id, q);
    return q;
  }

  getQuote(id: unknown, wallet: string, now = Date.now()): Quote | null {
    const q = typeof id === "string" ? this.quotes.get(id) : undefined;
    if (!q || q.wallet !== wallet || q.expiresAt < now) return null;
    return q;
  }

  /** Locks a quote for a match: reserves the worst-case payout so concurrent wins stay covered. */
  accept(quoteId: unknown, wallet: string, matchId: string, now = Date.now()): Quote | string {
    const q = this.getQuote(quoteId, wallet, now);
    if (!q) return "Price quote expired — pick the opponent again.";
    const b = this.book(q.model);
    const liability = q.priceMicro + q.topUpMicro; // house stake + top-up
    if (b.bountyMicro < PRICING.bountyFloorMicro) {
      b.subsidyMicro += PRICING.bountyFloorMicro - b.bountyMicro;
      b.bountyMicro = PRICING.bountyFloorMicro;
    }
    if (b.bountyMicro - b.reservedMicro < liability) return "This champion's bounty is fully committed to live matches — try again shortly.";
    this.quotes.delete(q.id);
    b.reservedMicro += liability;
    this.data.open[matchId] = { model: q.model, wallet, priceMicro: q.priceMicro, prizeMicro: q.prizeMicro, liabilityMicro: liability };
    this.save();
    return q;
  }

  /** The match never got going (cancelled / refunded): release the reservation, nothing else moves. */
  release(matchId: string): void {
    const o = this.data.open[matchId];
    if (!o) return;
    this.data.models[o.model].reservedMicro -= o.liabilityMicro;
    delete this.data.open[matchId];
    this.save();
  }

  /**
   * Books a finished match exactly once. `winner` is the settlement winner (draws settle to the
   * house); `outcome` keeps draws separate for the benchmark. `agentCostUsd` is the real API spend.
   */
  settle(matchId: string, winner: "PLAYER" | "HOUSE", outcome: "PLAYER" | "MODEL" | "DRAW", agentCostUsd: number): void {
    const o = this.data.open[matchId];
    if (!o) return;
    const b = this.data.models[o.model];
    b.reservedMicro -= o.liabilityMicro;
    if (outcome === "MODEL") b.wins++;
    else if (outcome === "PLAYER") b.losses++;
    else b.draws++;
    const score = outcome === "MODEL" ? 1 : outcome === "DRAW" ? 0.5 : 0;
    const players = (this.data.players ??= {});
    const playerElo = o.wallet ? (players[o.wallet] ?? ELO_START) : ELO_START;
    const [modelElo, newPlayer] = eloUpdate(b.elo ?? ELO_START, playerElo, score);
    b.elo = modelElo;
    if (o.wallet) players[o.wallet] = newPlayer;
    b.recentCostUsd = [...b.recentCostUsd, agentCostUsd].slice(-COST_WINDOW);
    if (winner === "HOUSE") {
      // The pot returns the house's stake plus the player's stake less the 1% pot fee.
      const split = splitFee(potMicro(o.priceMicro) - o.priceMicro, agentCostUsd);
      b.bountyMicro += split.toBounty;
      b.platformMicro += split.platform;
    } else {
      b.bountyMicro -= o.liabilityMicro + Math.ceil(agentCostUsd * 1e6);
    }
    delete this.data.open[matchId];
    this.save();
  }

  /**
   * Folds seed-benchmark games (LLM vs a house bot) into Elo and the bench record, once per game.
   * The bots are fixed-rating anchors. Returns how many new games were applied.
   */
  applyBenchmark(rows: { model: string; opponent: string; seed: string; outcome: string }[]): number {
    const applied = new Set(this.data.benchApplied ?? []);
    let n = 0;
    for (const r of rows) {
      const b = this.data.models[r.model];
      const anchor = BOT_ELO[r.opponent];
      if (!b || anchor === undefined || applied.has(r.seed) || !["LLM", "BOT", "DRAW"].includes(r.outcome)) continue;
      const score = r.outcome === "LLM" ? 1 : r.outcome === "DRAW" ? 0.5 : 0;
      b.elo = eloUpdate(b.elo ?? ELO_START, anchor, score)[0];
      b.benchGames = (b.benchGames ?? 0) + 1;
      b.benchScore = (b.benchScore ?? 0) + score;
      applied.add(r.seed);
      n++;
    }
    if (n) {
      this.data.benchApplied = [...applied];
      this.save();
    }
    return n;
  }

  playerElo(wallet: string): number {
    return Math.round(this.data.players?.[wallet] ?? ELO_START);
  }

  /** Seed-benchmark samples improve the cost estimate before the first human match. */
  addCostSample(model: string, usd: number): void {
    const b = this.book(model);
    b.recentCostUsd = [...b.recentCostUsd, usd].slice(-COST_WINDOW);
    this.save();
  }

  raw(model: string) {
    return structuredClone(this.book(model));
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
