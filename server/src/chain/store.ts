import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SERVER_ROOT } from "./config";
import type { OnChainSnapshot } from "./onchainMatch";

/**
 * File-per-match store for staked matches (server/data/matches, gitignored).
 * Snapshots contain the match's secret shuffle seed, so files are written owner-only
 * and must never be served or committed.
 */
export class MatchStore {
  constructor(readonly dir: string = resolve(SERVER_ROOT, "data", "matches")) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(token: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("bad token");
    return join(this.dir, `${token}.json`);
  }

  /** Atomic write: temp file + rename, so a crash never leaves a half-written snapshot. */
  save(snap: OnChainSnapshot): void {
    const file = this.path(snap.session.token);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, file);
  }

  remove(token: string): void {
    const file = this.path(token);
    if (existsSync(file)) rmSync(file);
  }

  loadAll(): { snap: OnChainSnapshot; file: string }[] {
    const out: { snap: OnChainSnapshot; file: string }[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.dir, name);
      try {
        const snap = JSON.parse(readFileSync(file, "utf8")) as OnChainSnapshot;
        if (snap.version === 1) out.push({ snap, file });
      } catch (e) {
        console.error(`[store] unreadable snapshot ${name}: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
