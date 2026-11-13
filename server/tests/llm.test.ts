import { afterEach, describe, expect, it } from "vitest";
import { SpendGuard } from "../src/ai/llm/budget";
import { LlmAi, setLlmClient } from "../src/ai/llm/llmAi";
import { LLM_MODELS, llmVersionOf } from "../src/ai/llm/models";
import { OpenRouterClient } from "../src/ai/llm/openrouter";
import { SYSTEM_PROMPT, parseTurn, turnPrompt } from "../src/ai/llm/prompt";
import { createMatch } from "../src/engine/engine";
import { projectFor } from "../src/engine/projection";
import { createMatchRngs } from "../src/engine/rng";
import type { PlayerView } from "../src/engine/types";
import { MatchSession } from "../src/session";

const MODEL = LLM_MODELS.find((m) => m.id.startsWith("z-ai"))!;

function freshViews() {
  const rngs = createMatchRngs("m-llm", { rules: "r", deck: "d" }, Buffer.alloc(32, 7));
  const state = createMatch({ matchId: "m-llm", aiVersion: "x", humanDeckRng: rngs.humanDeck, aiDeckRng: rngs.aiDeck });
  return { state, ai: projectFor(state, "AI"), human: projectFor(state, "HUMAN") };
}

/** Fake OpenRouter: answers with the given reply contents in order and records requests. */
function fakeClient(replies: (string | ((v: unknown) => string))[], capUsd = 1) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const r = replies.shift() ?? '{"cards":[],"reason":"pass"}';
    const content = typeof r === "function" ? r(body) : r;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.001, prompt_tokens: 900, completion_tokens: 30 } }), { status: 200 });
  }) as typeof fetch;
  const client = new OpenRouterClient("test-key", new SpendGuard(capUsd, null), fetchImpl);
  return { client, requests };
}

const cheapest = (v: PlayerView) => [...v.self.hand].sort((a, b) => a.def.cost - b.def.cost)[0].uid;

afterEach(() => setLlmClient(null));

describe("LLM prompt", () => {
  it("contains only the seat's own hand — never the opponent's", () => {
    const { ai, human } = freshViews();
    const prompt = turnPrompt(ai, []);
    const state = JSON.parse(prompt.split("\n")[1]);
    expect(state.you.hand.map((c: { uid: string }) => c.uid)).toEqual(ai.self.hand.map((c) => c.uid));
    expect(state.opponent).not.toHaveProperty("hand");
    expect(state.opponent.handSize).toBe(human.self.hand.length);
    // Both decks use the same uids, so only uids that are NOT also in the AI hand prove a leak.
    const aiUids = new Set(ai.self.hand.map((c) => c.uid));
    // (The system prompt is static text with no per-match data.)
    for (const c of human.self.hand) if (!aiUids.has(c.uid)) expect(prompt).not.toContain(c.uid);
    expect(SYSTEM_PROMPT).not.toContain(ai.matchId);
  });

  it("validates replies against hand, card count and energy", () => {
    const { ai } = freshViews();
    const [a, b, c] = ai.self.hand;
    expect(parseTurn(`{"cards":["${a.uid}"],"reason":"x"}`, ai)).toMatchObject({ ok: true, cards: [a.uid] });
    expect(parseTurn("```json\n{\"cards\":[],\"reason\":\"pass\"}\n```", ai)).toMatchObject({ ok: true, cards: [] });
    expect(parseTurn(`{"cards":["${a.uid}","${b.uid}","${c.uid}"]}`, ai).ok).toBe(false);
    expect(parseTurn(`{"cards":["${a.uid}","${a.uid}"]}`, ai).ok).toBe(false);
    expect(parseTurn(`{"cards":["not_a_card#1"]}`, ai).ok).toBe(false);
    expect(parseTurn("I will attack!", ai).ok).toBe(false);
    const poor = { ...ai, self: { ...ai.self, energy: 0 } };
    expect(parseTurn(`{"cards":["${a.uid}"]}`, poor)).toMatchObject({ ok: false });
  });
});

describe("SpendGuard", () => {
  it("enforces a daily cap that resets the next UTC day", () => {
    let t = Date.parse("2026-11-13T10:00:00Z");
    const g = new SpendGuard(10, null, null, 1, () => t);
    g.reserve(0.5)!(0.9, "m");
    expect(g.remainingUsd).toBeCloseTo(0.1);
    expect(g.reserve(0.2)).toBeNull();
    t = Date.parse("2026-11-14T00:00:01Z");
    expect(g.remainingUsd).toBe(1);
  });

  it("a sub-budget is limited by, and charges, its parent", () => {
    const parent = new SpendGuard(1, null);
    const run = new SpendGuard(5, null, parent);
    expect(run.remainingUsd).toBe(1);
    run.reserve(0.4)!(0.3, "m");
    expect(parent.spentUsd).toBeCloseTo(0.3);
    expect(run.reserve(0.8)).toBeNull(); // parent has only 0.7 left
  });
});

describe("LlmAi", () => {
  it("retries once after an illegal reply, then plays the legal one", async () => {
    const { ai } = freshViews();
    const { client, requests } = fakeClient(['{"cards":["nope#9"],"reason":"?"}', `{"cards":["${cheapest(ai)}"],"reason":"cheap"}`]);
    const llm = new LlmAi(MODEL, client);
    const d = await llm.decideAsync(ai);
    expect(d.cards).toEqual([cheapest(ai)]);
    expect(d.meta).toMatchObject({ outcome: "retried", calls: 2, reason: "cheap" });
    expect(requests[1].messages.at(-1)!.content).toMatch(/Invalid move/);
  });

  it("passes after two illegal replies, and never calls the API once the budget is spent", async () => {
    const { ai } = freshViews();
    const bad = '{"cards":["nope#9"],"reason":"?"}';
    const twice = fakeClient([bad, bad]);
    expect((await new LlmAi(MODEL, twice.client).decideAsync(ai)).meta).toMatchObject({ outcome: "illegal", cards: [] });

    const broke = fakeClient([], 0);
    const d = await new LlmAi(MODEL, broke.client).decideAsync(ai);
    expect(d).toMatchObject({ cards: [], meta: { outcome: "budget" } });
    expect(broke.requests).toHaveLength(0);
  });

  it("charges the spend guard with the real reported cost", async () => {
    const { ai } = freshViews();
    const { client } = fakeClient(['{"cards":[],"reason":"wait"}']);
    await new LlmAi(MODEL, client).decideAsync(ai);
    expect(client.guard.spentUsd).toBeCloseTo(0.001);
    expect(client.guard.byModel()[MODEL.id]).toEqual({ spentUsd: 0.001, calls: 1 });
  });
});

describe("MatchSession with an LLM opponent", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const pickFrom = (body: unknown) => {
    const msg = (body as { messages: { content: string }[] }).messages[1].content;
    const hand = JSON.parse(msg.split("\n")[1]).you.hand as { uid: string; cost: number }[];
    const c = hand.filter((h) => h.cost <= 5)[0];
    return JSON.stringify({ cards: c ? [c.uid] : [], reason: `secret plan ${c?.uid}` });
  };

  it("lets the human lock in first, resolves when the model answers, and replays from the record", async () => {
    const { client, requests } = fakeClient(Array.from({ length: 200 }, () => pickFrom));
    setLlmClient(client);
    const s = new MatchSession(() => {}, 60_000, {}, { aiVersion: llmVersionOf(MODEL) });
    expect(s.aiThinking).toBe(true);
    expect(s.humanView().view.opponent.committed).toBe(false);
    expect(s.commitHuman(1, []).ok).toBe(true); // human first; the model's request was already sent
    expect(requests).toHaveLength(1);
    await flush();
    expect(s.humanView().view.turn).toBe(2);

    // Reasons could reveal the AI's hand: hidden until the match is over.
    expect(s.revealedAiThoughts()).toBeNull();

    await flush();
    const snap = s.snapshot();
    s.dispose();
    expect(snap.aiMeta).toHaveLength(2); // turn 1 resolved + turn 2 already decided
    const before = requests.length;
    const restored = new MatchSession(() => {}, 60_000, {}, { restore: snap });
    expect(restored.humanView().view.turn).toBe(2);
    expect(requests.length).toBe(before); // every decided turn is replayed from the record, never re-asked
    restored.dispose();
  });

  it("plays a whole match to the end and then reveals every reason", async () => {
    const { client } = fakeClient(Array.from({ length: 200 }, () => pickFrom));
    setLlmClient(client);
    const s = new MatchSession(() => {}, 60_000, {}, { aiVersion: llmVersionOf(MODEL) });
    for (let i = 0; i < 80 && !s.finished; i++) {
      await flush();
      const { view } = s.humanView();
      if (!view.self.committed) s.commitHuman(view.turn, []);
      await flush();
    }
    expect(s.finished).toBe(true);
    const thoughts = s.revealedAiThoughts() as { reason: string }[];
    expect(thoughts.length).toBeGreaterThan(3);
    expect(thoughts[0].reason).toMatch(/secret plan/);
    s.dispose();
  });
});
