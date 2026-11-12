import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { SERVER_ROOT } from "../chain/config";
import type { ObservedPlay } from "./memory";
import { emptyStats, recordPlay, type PatternStats } from "./patterns";

/**
 * Per-player play-pattern profiles (staked matches only, keyed by wallet). Built purely from
 * plays that were revealed to both sides — never hands or deck order. A match starts with a
 * frozen copy (so replays are deterministic); the profile is updated once when it ends.
 */
interface StoredProfile {
  stats: PatternStats;
  /** Matches already folded in (dedupe across restarts). */
  recent: string[];
}

export class ProfileStore {
  constructor(readonly dir: string = resolve(SERVER_ROOT, "data", "profiles")) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(wallet: string): string {
    new PublicKey(wallet); // only valid base58 addresses become file names
    return join(this.dir, `${wallet}.json`);
  }

  private read(wallet: string): StoredProfile | null {
    const f = this.path(wallet);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as StoredProfile;
    } catch {
      return null;
    }
  }

  /** The prior a new match against this wallet starts with (undefined for a new player). */
  prior(wallet: string): PatternStats | undefined {
    return this.read(wallet)?.stats;
  }

  /** Folds a finished match's revealed plays into the profile, once per match id. */
  record(wallet: string, matchId: string, plays: ObservedPlay[]): void {
    const p = this.read(wallet) ?? { stats: emptyStats(), recent: [] };
    if (p.recent.includes(matchId)) return;
    for (const play of plays) recordPlay(p.stats, play);
    p.stats.matches++;
    p.recent = [...p.recent, matchId].slice(-200);
    const f = this.path(wallet);
    writeFileSync(`${f}.tmp`, JSON.stringify(p), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
}
