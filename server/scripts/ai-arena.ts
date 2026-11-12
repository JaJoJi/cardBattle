// AI-vs-AI benchmark with fixed seeds. The house seat ("AI") plays the AI under test;
// the human seat plays a scripted opponent. Reports house win rate (draws count for the
// house, as in settlement), human win rate, average turns and ms per house decision.
// Usage: npx tsx scripts/ai-arena.ts [matches=200] [house=search-v3] [opponents=heuristic,turtle,aggro,random]
import { createAi } from "../src/ai";
import { STRONG, SearchAi } from "../src/ai/search";
// AI_CFG='{"worlds":48}' overrides search settings for tuning.
const cfgOverride = process.env.AI_CFG ? { ...STRONG, ...JSON.parse(process.env.AI_CFG) } : null;
import { chooseCards } from "../src/ai/bot";
import { pairsWithin, playValue } from "../src/ai/combos";
import { commitSelection, createMatch, resolveTurn } from "../src/engine/engine";
import { projectFor } from "../src/engine/projection";
import { createMatchRngs, createSeededRng, deriveSeed, type Rng } from "../src/engine/rng";
import type { CardView, PlayerView } from "../src/engine/types";

type Policy = (view: PlayerView, rng: Rng) => string[];

const legal = (v: PlayerView) => pairsWithin(v.self.hand.map((c) => ({ ...c, cost: c.def.cost })), v.self.energy, v.maxCardsPerTurn) as (CardView & { cost: number })[][];
const ids = (p: CardView[]) => p.map((c) => c.uid);

const OPPONENTS: Record<string, Policy> = {
  heuristic: (v, r) => chooseCards(v, r),
  // Defends whenever it took damage last turn, else attacks hard.
  turtle: (v) => {
    const hurt = (v.lastTurn?.damage ?? []).some((d) => d.target === v.you && d.hpDamage > 0);
    const plays = legal(v);
    const key = (p: CardView[]) => (hurt ? playValue(p.map((c) => c.def)).block * 10 : 0) + playValue(p.map((c) => c.def)).raw;
    return ids(plays.reduce((a, b) => (key(b) > key(a) ? b : a)));
  },
  // Always the play with the most raw damage.
  aggro: (v) => ids(legal(v).reduce((a, b) => (playValue(b.map((c) => c.def)).raw > playValue(a.map((c) => c.def)).raw ? b : a))),
  random: (v, r) => {
    const plays = legal(v);
    return ids(plays[r.int(plays.length)]);
  },
};

const N = Number(process.argv[2] ?? 200);
const houseVersion = process.argv[3] ?? "search-v3";
const opps = (process.argv[4] ?? "heuristic,turtle,aggro,random").split(",");

for (const oppName of opps) {
  const opp = OPPONENTS[oppName];
  let house = 0;
  let human = 0;
  let draws = 0;
  let turns = 0;
  let ms = 0;
  let decisions = 0;
  for (let i = 0; i < N; i++) {
    const master = deriveSeed(Buffer.from("arena"), `${i}`);
    const id = `arena-${i}`;
    const rngs = createMatchRngs(id, { rules: "r", deck: "d" }, master);
    const s = createMatch({ matchId: id, aiVersion: houseVersion, humanDeckRng: rngs.humanDeck, aiDeckRng: rngs.aiDeck });
    const ai = cfgOverride && houseVersion === "search-v3" ? new SearchAi(undefined, cfgOverride) : createAi(houseVersion);
    const humanRng = createSeededRng(deriveSeed(master, "human"));
    while (s.phase !== "FINISHED") {
      const t0 = performance.now();
      const aiPick = ai.decide(projectFor(s, "AI"), createSeededRng(deriveSeed(master, `ai-${s.turn}`)));
      ms += performance.now() - t0;
      decisions++;
      if (!commitSelection(s, "AI", aiPick).ok) commitSelection(s, "AI", []);
      if (!commitSelection(s, "HUMAN", opp(projectFor(s, "HUMAN"), humanRng)).ok) commitSelection(s, "HUMAN", []);
      resolveTurn(s, rngs.resolution);
    }
    turns += s.turn;
    if (s.outcome === "DRAW") draws++;
    if (s.settlement === "HUMAN_LOSS") house++;
    else human++;
  }
  console.log(
    `${houseVersion.padEnd(12)} vs ${oppName.padEnd(9)}  house ${((house / N) * 100).toFixed(1)}%  (draws ${((draws / N) * 100).toFixed(1)}%)  human ${((human / N) * 100).toFixed(1)}%  avg turns ${(turns / N).toFixed(1)}  ${(ms / decisions).toFixed(1)} ms/decision`,
  );
}
