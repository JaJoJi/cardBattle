// LLM-vs-bot seed benchmark (spends real OpenRouter credit — every call is capped).
// The AI seat plays the LLM; the human seat plays a bot. Results are appended to
// data/llm-benchmark.json and seed the leaderboard/pricing before humans play.
//
// Usage: npx tsx scripts/llm-arena.ts [--models all|<id,...>] [--matches 1] [--opponent search-v3|heuristic-v2]
//                                     [--max-usd 0.5] [--max-turns 60]
// --max-turns stops a match early (smoke tests); such matches are not recorded as results.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAi } from "../src/ai";
import { SpendGuard } from "../src/ai/llm/budget";
import { LlmAi, llmClient } from "../src/ai/llm/llmAi";
import { LLM_MODELS } from "../src/ai/llm/models";
import { OpenRouterClient } from "../src/ai/llm/openrouter";
import { SERVER_ROOT } from "../src/chain/config";
import { commitSelection, createMatch, resolveTurn } from "../src/engine/engine";
import { projectFor } from "../src/engine/projection";
import { createMatchRngs, createSeededRng, deriveSeed } from "../src/engine/rng";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const modelsArg = arg("models", "all");
const matches = Number(arg("matches", "1"));
const opponent = arg("opponent", "search-v3");
const maxUsd = Number(arg("max-usd", "0.5"));
const maxTurns = Number(arg("max-turns", "60"));
const models = modelsArg === "all" ? LLM_MODELS : LLM_MODELS.filter((m) => modelsArg.split(",").includes(m.id));
if (!models.length) throw new Error(`No models match ${modelsArg}`);

const shared = llmClient();
if (!shared) throw new Error("Set OPENROUTER_API_KEY (or API_KEY) in server/.env");
// This run's own cap, nested inside the persistent global ledger: whichever is lower wins.
const runGuard = new SpendGuard(maxUsd, null, shared.guard);
const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY || process.env.API_KEY!, runGuard);

interface Result {
  at: string;
  model: string;
  opponent: string;
  seed: string;
  outcome: "LLM" | "BOT" | "DRAW" | "UNFINISHED";
  turns: number;
  hp: { llm: number; bot: number };
  costUsd: number;
  avgMs: number;
  illegal: number;
  failed: number;
}

async function playOne(model: (typeof LLM_MODELS)[number], i: number): Promise<Result> {
  const seed = `llm-arena|${model.id}|${opponent}|${Date.now()}|${i}`;
  const master = deriveSeed(Buffer.from(seed), "master");
  const rngs = createMatchRngs(seed, { rules: "rules-v1", deck: "deck-v3" }, master);
  const state = createMatch({ matchId: seed, aiVersion: `llm:${model.id}`, humanDeckRng: rngs.humanDeck, aiDeckRng: rngs.aiDeck });
  const llm = new LlmAi(model, client);
  const bot = createAi(opponent);
  while (state.phase === "PLANNING" && state.turn <= maxTurns) {
    const d = await llm.decideAsync(projectFor(state, "AI"));
    if (!commitSelection(state, "AI", d.cards).ok) commitSelection(state, "AI", []);
    const pick = bot.decide(projectFor(state, "HUMAN"), createSeededRng(deriveSeed(master, `bot|${state.turn}`)));
    if (!commitSelection(state, "HUMAN", pick).ok) commitSelection(state, "HUMAN", []);
    resolveTurn(state, rngs.resolution);
    bot.observe(projectFor(state, "HUMAN"));
    if (runGuard.remainingUsd <= 0) break;
  }
  const s = llm.matchStats();
  const outcome = state.phase !== "FINISHED" ? "UNFINISHED" : state.outcome === "AI" ? "LLM" : state.outcome === "HUMAN" ? "BOT" : "DRAW";
  return {
    at: new Date().toISOString(),
    model: model.id,
    opponent,
    seed,
    outcome,
    turns: state.history.length,
    hp: { llm: state.players.AI.hp, bot: state.players.HUMAN.hp },
    costUsd: s.costUsd,
    avgMs: s.avgMs,
    illegal: s.illegal,
    failed: s.failed,
  };
}

const file = resolve(SERVER_ROOT, "data", "llm-benchmark.json");
const saved: Result[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];

console.log(`Run cap $${runGuard.remainingUsd.toFixed(2)} (global remaining $${shared.guard.remainingUsd.toFixed(2)}); ${models.length} model(s) × ${matches} vs ${opponent}`);
// Models run in parallel (independent providers); each model's matches run in order.
const results = await Promise.all(
  models.map(async (m) => {
    const out: Result[] = [];
    for (let i = 0; i < matches && runGuard.remainingUsd > 0; i++) {
      const r = await playOne(m, i);
      out.push(r);
      console.log(`${m.name.padEnd(20)} #${i + 1} ${r.outcome.padEnd(10)} turns=${r.turns} hp ${r.hp.llm}-${r.hp.bot} cost=$${r.costUsd.toFixed(4)} avg=${r.avgMs}ms illegal=${r.illegal} failed=${r.failed}`);
    }
    return out;
  }),
);
const finished = results.flat().filter((r) => r.outcome !== "UNFINISHED");
mkdirSync(resolve(SERVER_ROOT, "data"), { recursive: true });
writeFileSync(file, JSON.stringify([...saved, ...finished], null, 1));
console.log(`\nSpent this run: $${runGuard.spentUsd.toFixed(4)} · global ledger: $${shared.guard.spentUsd.toFixed(4)} · recorded ${finished.length} finished match(es)`);
