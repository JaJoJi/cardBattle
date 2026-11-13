import { describe, expect, it } from "vitest";
import { ArenaBook, potMicro, topUpMicro } from "../src/arena/book";
import { PRICING, USDC_MICRO, priceMicro, prizeMicro, skillFactor, smoothedWinRate, splitFee } from "../src/arena/pricing";

const M = "z-ai/glm-5.3-flash";
const W = "Wallet111";
const rec = (wins: number, losses: number, cost = 0.01) => ({ wins, losses, draws: 0, recentCostUsd: [cost] });

describe("pricing", () => {
  it("starts at the base fee and rises with the model's win rate", () => {
    const fresh = priceMicro(rec(0, 0), 0.01);
    expect(fresh).toBe(1.1 * USDC_MICRO); // (1 + 0.03) × 1.0, rounded up to 0.10
    expect(priceMicro(rec(30, 10), 0.01)).toBeGreaterThan(fresh);
    expect(priceMicro(rec(5, 35), 0.01)).toBeLessThan(fresh);
  });

  it("smooths small samples and clamps the skill factor", () => {
    expect(smoothedWinRate({ wins: 3, losses: 0, draws: 0 })).toBeCloseTo(13 / 23);
    expect(skillFactor(1)).toBe(2);
    expect(skillFactor(0)).toBe(PRICING.skillMin);
  });

  it("passes expensive agents' cost on to the price", () => {
    expect(priceMicro(rec(0, 0, 0.2), 0.2)).toBe(1.6 * USDC_MICRO);
  });

  it("prize is at least double the price, or 70% of a large bounty", () => {
    expect(prizeMicro(2 * USDC_MICRO, 5 * USDC_MICRO)).toBe(4 * USDC_MICRO);
    expect(prizeMicro(2 * USDC_MICRO, 50 * USDC_MICRO)).toBe(35 * USDC_MICRO);
  });

  it("splits a fee into agent cost, platform cut and bounty without going negative", () => {
    expect(splitFee(1_000_000, 0.05)).toEqual({ agent: 50_000, platform: 100_000, toBounty: 850_000 });
    expect(splitFee(100_000, 5)).toEqual({ agent: 100_000, platform: 0, toBounty: 0 });
  });
});

describe("ArenaBook", () => {
  it("house win grows the bounty by the player's stake less fees; prize then grows", () => {
    const book = new ArenaBook(null);
    const q = book.quote(M, W);
    expect(book.accept(q.id, W, "m1")).toMatchObject({ priceMicro: q.priceMicro });
    expect(book.accept(q.id, W, "m1b")).toMatch(/expired/); // single use
    book.settle("m1", "HOUSE", "MODEL", 0.002);
    const b = book.raw(M);
    expect(b.wins).toBe(1);
    expect(b.reservedMicro).toBe(0);
    const gain = potMicro(q.priceMicro) - q.priceMicro;
    expect(b.bountyMicro).toBe(PRICING.bountyFloorMicro + splitFee(gain, 0.002).toBounty);
  });

  it("player win pays stake + top-up + agent cost out of the bounty", () => {
    const book = new ArenaBook(null);
    const q = book.quote(M, W);
    book.accept(q.id, W, "m2");
    book.settle("m2", "PLAYER", "PLAYER", 0.002);
    const b = book.raw(M);
    expect(b.losses).toBe(1);
    expect(b.bountyMicro).toBe(PRICING.bountyFloorMicro - q.priceMicro - topUpMicro(q.priceMicro, q.prizeMicro) - 2_000);
    // Next quote: the house re-seeds to the floor, and that is tracked as subsidy.
    book.accept(book.quote(M, W).id, W, "m3");
    expect(book.raw(M).bountyMicro).toBe(PRICING.bountyFloorMicro);
    expect(book.raw(M).subsidyMicro).toBeGreaterThan(PRICING.bountyFloorMicro);
  });

  it("never commits more than the bounty to concurrent matches", () => {
    const book = new ArenaBook(null);
    const results = Array.from({ length: 10 }, (_, i) => book.accept(book.quote(M, W).id, W, `c${i}`));
    const ok = results.filter((r) => typeof r !== "string").length;
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(10);
    expect(book.raw(M).reservedMicro).toBeLessThanOrEqual(book.raw(M).bountyMicro);
    for (let i = 0; i < 10; i++) book.release(`c${i}`);
    expect(book.raw(M).reservedMicro).toBe(0);
  });

  it("Elo: beating the model raises the player and lowers the model; benchmark games count once", () => {
    const book = new ArenaBook(null);
    const q = book.quote(M, W);
    book.accept(q.id, W, "e1");
    book.settle("e1", "PLAYER", "PLAYER", 0);
    expect(book.card(M).elo).toBe(1484);
    expect(book.playerElo(W)).toBe(1516);
    const rows = [
      { model: M, opponent: "search-v3", seed: "s1", outcome: "LLM" },
      { model: M, opponent: "search-v3", seed: "s2", outcome: "BOT" },
      { model: M, opponent: "nobody", seed: "s3", outcome: "LLM" },
    ];
    expect(book.applyBenchmark(rows)).toBe(2);
    expect(book.applyBenchmark(rows)).toBe(0);
    expect(book.card(M)).toMatchObject({ benchGames: 2, benchWinRate: 0.5 });
    expect(book.card(M).games).toBe(1); // bench games never touch the human record or the price
  });

  it("rejects another wallet's or an expired quote; settles only once", () => {
    const book = new ArenaBook(null);
    const q = book.quote(M, W, 0);
    expect(book.accept(q.id, "Other", "x", 1)).toMatch(/expired/);
    expect(book.accept(q.id, W, "x", q.expiresAt + 1)).toMatch(/expired/);
    const q2 = book.quote(M, W);
    book.accept(q2.id, W, "y");
    book.settle("y", "HOUSE", "DRAW", 0);
    book.settle("y", "HOUSE", "DRAW", 0);
    expect(book.raw(M).draws).toBe(1);
  });
});
