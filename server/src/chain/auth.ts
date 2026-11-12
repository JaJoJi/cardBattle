import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Proof of wallet ownership for staked matches. The server issues a one-time challenge
 * bound to the wallet and stake; the player signs it in their wallet (signMessage, no
 * transaction, no fee). Without this, anyone could make the house create arenas — and
 * spend SOL on rent — for arbitrary addresses.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface Challenge {
  nonce: string;
  wallet: string;
  stakeMicro: number;
  message: string;
  expiresAt: number;
}

export function challengeMessage(wallet: string, stakeMicro: number, nonce: string, issuedAt: Date): string {
  return [
    "RitArena Card Battle — start a staked match",
    `Wallet: ${wallet}`,
    `Stake: ${stakeMicro / 1_000_000} test USDC`,
    "Network: Solana devnet",
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt.toISOString()}`,
    "Signing this message does not send a transaction or cost any fee.",
  ].join("\n");
}

export class ChallengeStore {
  private readonly pending = new Map<string, Challenge>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(wallet: string, stakeMicro: number): Challenge {
    new PublicKey(wallet); // throws on an invalid address
    this.prune();
    const nonce = randomBytes(16).toString("hex");
    const c: Challenge = {
      nonce,
      wallet,
      stakeMicro,
      message: challengeMessage(wallet, stakeMicro, nonce, new Date(this.now())),
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.pending.set(nonce, c);
    return c;
  }

  /** Verifies and consumes a challenge. Each nonce works once, for the wallet and stake it was issued for. */
  redeem(nonce: unknown, wallet: unknown, stakeMicro: unknown, signatureB58: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof nonce !== "string" || typeof wallet !== "string" || typeof signatureB58 !== "string") {
      return { ok: false, reason: "Missing wallet signature" };
    }
    const c = this.pending.get(nonce);
    if (!c) return { ok: false, reason: "Unknown or already used sign-in challenge — try again" };
    this.pending.delete(nonce); // single use, even on failure
    if (this.now() > c.expiresAt) return { ok: false, reason: "Sign-in challenge expired — try again" };
    if (c.wallet !== wallet || c.stakeMicro !== stakeMicro) return { ok: false, reason: "Challenge does not match this wallet or stake" };
    let sig: Uint8Array;
    try {
      sig = bs58.decode(signatureB58);
    } catch {
      return { ok: false, reason: "Malformed signature" };
    }
    const valid = sig.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(c.message), sig, new PublicKey(wallet).toBytes());
    return valid ? { ok: true } : { ok: false, reason: "Wallet signature is invalid" };
  }

  private prune() {
    const t = this.now();
    for (const [k, c] of this.pending) if (t > c.expiresAt) this.pending.delete(k);
  }
}

/** Sliding-window counter, e.g. "at most 6 staked matches per IP per hour". */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns false if the key is over its limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
