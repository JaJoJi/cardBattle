// Elo ratings for the benchmark. Models and players start at 1500; the house bots are fixed
// anchors so seed-benchmark games give models a starting spread before any human plays.

export const ELO_START = 1500;
export const ELO_K = 32;
/** Fixed ratings for the bots used as seed-benchmark opponents (never updated). */
export const BOT_ELO: Record<string, number> = { "search-v3": 1500, "heuristic-v2": 1400 };

export const expectedScore = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));

/** New ratings after one game; `scoreA` is 1 (A won), 0.5 (draw) or 0 (A lost). */
export function eloUpdate(a: number, b: number, scoreA: number, k = ELO_K): [number, number] {
  const delta = k * (scoreA - expectedScore(a, b));
  return [a + delta, b - delta];
}
