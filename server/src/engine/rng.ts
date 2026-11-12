import { createHmac, randomBytes } from "node:crypto";

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/** Domain-separated sub-seed: HMAC-SHA256(master, label). */
export function deriveSeed(master: Buffer, label: string): Buffer {
  return createHmac("sha256", master).update(label).digest();
}

/** Deterministic RNG: HMAC-SHA256 in counter mode + rejection sampling (no modulo bias). */
export function createSeededRng(seed: Buffer): Rng {
  let counter = 0n;
  let block = Buffer.alloc(0);
  let offset = 0;

  function nextUint32(): number {
    if (offset + 4 > block.length) {
      const c = Buffer.alloc(8);
      c.writeBigUInt64BE(counter++);
      block = createHmac("sha256", seed).update(c).digest();
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  }

  return {
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
        throw new Error(`invalid bound ${maxExclusive}`);
      }
      const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
      let x: number;
      do x = nextUint32();
      while (x >= limit);
      return x % maxExclusive;
    },
  };
}

/** Unbiased Fisher–Yates shuffle. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface MatchRngs {
  humanDeck: Rng;
  aiDeck: Rng;
  resolution: Rng; // e.g. random discard
  ai: Rng; // AI decision noise
}

/**
 * Local stand-in for the future VRF + private-entropy design: one private master
 * secret per match, split into independent, domain-separated streams bound to the
 * match id and versions. The master secret never leaves the server process.
 */
export function createMatchRngs(
  matchId: string,
  versions: { rules: string; deck: string },
  master: Buffer = randomBytes(32),
): MatchRngs {
  const bind = (label: string) =>
    createSeededRng(deriveSeed(master, `${label}|${matchId}|${versions.rules}|${versions.deck}`));
  return {
    humanDeck: bind("RITARENA_HUMAN_DECK_V1"),
    aiDeck: bind("RITARENA_AI_DECK_V1"),
    resolution: bind("RITARENA_RESOLUTION_V1"),
    ai: bind("RITARENA_AI_POLICY_V1"),
  };
}
