// MOCK DATA — replaces on-chain vault reads until Solana settlement is connected.
// Shapes mirror what the RitArena program will expose (balances in USDC, fees in bps).

export interface StakeTier {
  id: string;
  name: string;
  stake: number; // USDC
  payoutMultiplier: number; // paid to the player on a win (stake included)
}

export interface SettlementRow {
  id: string;
  player: string; // truncated wallet
  stake: number;
  result: "WIN" | "LOSS" | "DRAW";
  payout: number;
  turns: number;
  minutesAgo: number;
}

export const MOCK_VAULT = {
  name: "RitArena House Vault",
  network: "devnet (mock)",
  balanceUsdc: 125_430.52,
  lockedInMatchesUsdc: 2_315.0,
  protocolFeeBps: 100,
  matchesPlayed: 4_821,
  playerWinRate: 0.431,
  volume24hUsdc: 18_920.0,
  maxPayoutShareBps: 500, // a single payout may use at most 5% of free liquidity
};

export const STAKE_TIERS: StakeTier[] = [
  { id: "bronze", name: "Bronze", stake: 1, payoutMultiplier: 1.9 },
  { id: "silver", name: "Silver", stake: 5, payoutMultiplier: 1.9 },
  { id: "gold", name: "Gold", stake: 25, payoutMultiplier: 1.9 },
  { id: "mythic", name: "Mythic", stake: 100, payoutMultiplier: 1.9 },
];

export const RECENT_SETTLEMENTS: SettlementRow[] = [
  { id: "s1", player: "7xKX…3fQa", stake: 5, result: "WIN", payout: 9.5, turns: 8, minutesAgo: 2 },
  { id: "s2", player: "Bq9d…L2mP", stake: 25, result: "LOSS", payout: 0, turns: 11, minutesAgo: 5 },
  { id: "s3", player: "4nVt…xQ8e", stake: 1, result: "DRAW", payout: 0, turns: 6, minutesAgo: 9 },
  { id: "s4", player: "Hc3R…9wZk", stake: 100, result: "WIN", payout: 190, turns: 14, minutesAgo: 17 },
  { id: "s5", player: "9pLm…Tt4a", stake: 5, result: "LOSS", payout: 0, turns: 7, minutesAgo: 26 },
  { id: "s6", player: "E2fW…kM1s", stake: 25, result: "WIN", payout: 47.5, turns: 9, minutesAgo: 41 },
];

export const freeLiquidity = () => MOCK_VAULT.balanceUsdc - MOCK_VAULT.lockedInMatchesUsdc;
export const maxSinglePayout = () => (freeLiquidity() * MOCK_VAULT.maxPayoutShareBps) / 10_000;

export const usdc = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
