// Challenge pricing and bounty math. Pure functions over USDC micro-units — no I/O.
//
//   price  = (BASE + agentCost × COST_MULT) × skillFactor, rounded up to 0.10 USDC
//   skill  = clamp(1 + 2·(winRate − ½), 0.75, 3)      winRate smoothed toward ½ (10 pseudo-wins of 20)
//   prize  = max(2 × price, 70% of the model's free bounty)  — locked in the quote
//
// Every fee pays the agent's real cost and a platform cut, and the rest grows that model's
// bounty. Stronger models lose less often, so their bounties grow: a higher price buys a
// bigger prize. The house only ever seeds a bounty up to BOUNTY_FLOOR (tracked as subsidy).

export const USDC_MICRO = 1_000_000;

export const PRICING = {
  baseFeeMicro: 1 * USDC_MICRO,
  /** Agent cost is passed on ×3 (covers retries, variance and price changes). */
  costMult: 3,
  platformCutBps: 1_000, // 10% of every fee
  prizeShareBps: 7_000, // a win takes 70% of the free bounty (if that beats 2 × price)
  bountyFloorMicro: 5 * USDC_MICRO,
  priorGames: 20, // smoothing: 20 pseudo-games at a 50% win rate
  skillMin: 0.75,
  skillMax: 3,
  roundToMicro: 100_000, // 0.10 USDC
} as const;

export interface ModelRecord {
  /** Human matches only (benchmark seeds don't move prices). Draws count ½ for the model. */
  wins: number;
  losses: number;
  draws: number;
  /** Recent real OpenRouter cost per finished match, USD (rolling). */
  recentCostUsd: number[];
}

export function smoothedWinRate(r: Pick<ModelRecord, "wins" | "losses" | "draws">): number {
  const games = r.wins + r.losses + r.draws;
  return (r.wins + r.draws / 2 + PRICING.priorGames / 2) / (games + PRICING.priorGames);
}

export function skillFactor(winRate: number): number {
  return Math.min(PRICING.skillMax, Math.max(PRICING.skillMin, 1 + 2 * (winRate - 0.5)));
}

export function avgCostUsd(r: ModelRecord, fallbackUsd: number): number {
  return r.recentCostUsd.length ? r.recentCostUsd.reduce((a, b) => a + b, 0) / r.recentCostUsd.length : fallbackUsd;
}

const usdToMicro = (usd: number) => Math.ceil(usd * USDC_MICRO); // devnet USDC is pegged 1:1 to the USD the API bills

export function priceMicro(r: ModelRecord, fallbackCostUsd: number): number {
  const raw = (PRICING.baseFeeMicro + usdToMicro(avgCostUsd(r, fallbackCostUsd)) * PRICING.costMult) * skillFactor(smoothedWinRate(r));
  return Math.ceil(raw / PRICING.roundToMicro) * PRICING.roundToMicro;
}

export function prizeMicro(price: number, freeBountyMicro: number): number {
  return Math.max(2 * price, Math.floor((freeBountyMicro * PRICING.prizeShareBps) / 10_000));
}

/** Where one fee goes. `toBounty` can't go negative: a match that costs more than its fee is subsidised. */
export function splitFee(price: number, agentCostUsd: number) {
  const agent = Math.min(price, usdToMicro(agentCostUsd));
  const platform = Math.min(price - agent, Math.floor((price * PRICING.platformCutBps) / 10_000));
  return { agent, platform, toBounty: price - agent - platform };
}
