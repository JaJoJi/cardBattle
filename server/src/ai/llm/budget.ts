import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SERVER_ROOT } from "../../chain/config";

/**
 * Hard spend guard for OpenRouter. The API key has no limit of its own, so every call
 * first reserves its worst-case cost here and is refused if that could cross the cap;
 * the reservation is then replaced by the real cost from the response. Persisted so a
 * restart never forgets what was spent.
 */
interface Ledger {
  spentUsd: number;
  /** UTC day (YYYY-MM-DD) → USD spent that day. */
  byDay?: Record<string, number>;
  byModel: Record<string, { spentUsd: number; calls: number }>;
}

export class SpendGuard {
  private ledger: Ledger;
  private reservedUsd = 0;

  constructor(
    readonly capUsd: number,
    private readonly file: string | null = resolve(SERVER_ROOT, "data", "llm-spend.json"),
    /** A sub-budget (e.g. one benchmark run) also charges its parent, and is limited by it. */
    private readonly parent: SpendGuard | null = null,
    /** Max USD per UTC day (Infinity = none). Devnet USDC is free but API credit is not. */
    readonly dailyCapUsd: number = Infinity,
    private readonly now: () => number = Date.now,
  ) {
    this.ledger = { spentUsd: 0, byModel: {} };
    if (file && existsSync(file)) {
      try {
        this.ledger = JSON.parse(readFileSync(file, "utf8")) as Ledger;
      } catch {
        /* corrupt ledger: start from zero but keep the cap */
      }
    }
  }

  get spentUsd() {
    return this.ledger.spentUsd;
  }
  get remainingUsd(): number {
    const today = this.ledger.byDay?.[this.day()] ?? 0;
    const own = Math.max(0, Math.min(this.capUsd - this.ledger.spentUsd, this.dailyCapUsd - today) - this.reservedUsd);
    return this.parent ? Math.min(own, this.parent.remainingUsd) : own;
  }
  byModel() {
    return structuredClone(this.ledger.byModel);
  }

  /** Reserves `usd`; returns a settle function, or null if the cap would be exceeded. */
  reserve(usd: number): ((actualUsd: number, model: string) => void) | null {
    if (usd > this.remainingUsd) return null;
    const parentSettle = this.parent?.reserve(usd) ?? null;
    this.reservedUsd += usd;
    let done = false;
    return (actualUsd, model) => {
      if (done) return;
      done = true;
      this.reservedUsd -= usd;
      parentSettle?.(actualUsd, model);
      this.ledger.spentUsd += actualUsd;
      const day = this.day();
      this.ledger.byDay = { ...this.ledger.byDay, [day]: (this.ledger.byDay?.[day] ?? 0) + actualUsd };
      const m = (this.ledger.byModel[model] ??= { spentUsd: 0, calls: 0 });
      m.spentUsd += actualUsd;
      m.calls++;
      this.save();
    };
  }

  private day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.ledger, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Default cap leaves headroom under the $10 OpenRouter credit. Override with LLM_BUDGET_USD. */
export const DEFAULT_BUDGET_USD = 8;
/** Default daily cap (LLM_DAILY_USD): ~10 Opus matches or hundreds on the cheap models. */
export const DEFAULT_DAILY_USD = 1.5;
