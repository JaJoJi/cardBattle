import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchSession } from "../src/session";

describe("MatchSession", () => {
  afterEach(() => vi.useRealTimers());

  it("AI is locked before the human submits; human sees only that it committed", () => {
    const s = new MatchSession(() => {});
    const { view } = s.humanView();
    expect(view.opponent.committed).toBe(true);
    expect(view.self.committed).toBeNull();
    s.dispose();
  });

  it("rejects stale-turn submissions (replay protection)", () => {
    const s = new MatchSession(() => {});
    expect(s.commitHuman(1, [])).toEqual({ ok: true });
    expect(s.humanView().view.turn).toBe(2);
    expect(s.commitHuman(1, []).ok).toBe(false);
    s.dispose();
  });

  it("timeout auto-passes the human and advances the turn", () => {
    vi.useFakeTimers();
    const changes: number[] = [];
    const s = new MatchSession((m) => changes.push(m.humanView().view.turn), 1000);
    vi.advanceTimersByTime(1001);
    expect(s.humanView().view.turn).toBe(2);
    expect(s.humanView().view.lastTurn!.played.HUMAN).toEqual([]);
    expect(changes).toEqual([1, 2]); // live view pushed at start, then after the timed-out turn
    s.dispose();
  });

  it("a full match always terminates", () => {
    const s = new MatchSession(() => {});
    let guard = 0;
    while (!s.finished && guard++ < 100) {
      const { view } = s.humanView();
      const pick = view.self.hand.filter((c) => c.def.type === "ATTACK" && c.def.cost <= view.self.energy).slice(0, 1);
      expect(s.commitHuman(view.turn, pick.map((c) => c.uid)).ok).toBe(true);
    }
    expect(s.finished).toBe(true);
    expect(["HUMAN_WIN", "HUMAN_LOSS"]).toContain(s.humanView().view.settlement);
    s.dispose();
  });
});
