import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram } from "@solana/web3.js";
import { SERVER_ROOT } from "./config";

/** MagicBlock VRF constants (from ephemeral-vrf-sdk 0.17.3 `consts`). */
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const VRF_DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"); // devnet/mainnet base layer

export const SEED_SCHEME_VRF = "vrf-v2";

/**
 * Per-match shuffle seed from BOTH sources. Neither the house (committed first) nor the
 * VRF oracle (doesn't know the private entropy) can choose it; deck order stays private
 * until the entropy is revealed at the end.
 */
export function deriveVrfMaster(privateEntropy: Buffer, vrfRandomness: Buffer, matchId: string): Buffer {
  return createHash("sha256").update("RITARENA_SEED_V2").update(privateEntropy).update(vrfRandomness).update(matchId).digest();
}

export interface MatchRandomnessAccount {
  authority: PublicKey;
  arenaId: number;
  commitment: Buffer;
  randomness: Buffer;
  fulfilled: boolean;
  requestedSlot: number;
  fulfilledSlot: number;
}

export interface VrfLike {
  readonly programId: PublicKey;
  pda(arenaId: number): PublicKey;
  /** Idempotent: returns null if this arena's request already exists. */
  request(arenaId: number, commitment: Buffer): Promise<string | null>;
  /** Polls until MagicBlock's oracle has delivered the randomness. */
  waitFulfilled(arenaId: number, timeoutMs?: number): Promise<MatchRandomnessAccount>;
  read(arenaId: number): Promise<MatchRandomnessAccount | null>;
}

export function loadVrfIdl(): Idl {
  return JSON.parse(readFileSync(resolve(SERVER_ROOT, "../onchain/idl/cardbattle_vrf.json"), "utf8")) as Idl;
}

/** Client for the `cardbattle_vrf` program (see onchain/programs/cardbattle-vrf). */
export class MatchVrf implements VrfLike {
  readonly programId: PublicKey;
  private readonly program: Program;

  constructor(
    readonly connection: Connection,
    readonly authority: Keypair,
    idl: Idl = loadVrfIdl(),
  ) {
    const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
    this.program = new Program(idl, provider);
    this.programId = this.program.programId;
  }

  pda(arenaId: number): PublicKey {
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(BigInt(arenaId));
    return PublicKey.findProgramAddressSync([Buffer.from("match_rng"), this.authority.publicKey.toBuffer(), id], this.programId)[0];
  }

  async read(arenaId: number): Promise<MatchRandomnessAccount | null> {
    const accounts = this.program.account as unknown as Record<string, { fetchNullable(k: PublicKey): Promise<Record<string, unknown> | null> }>;
    const raw = await accounts.matchRandomness.fetchNullable(this.pda(arenaId));
    if (!raw) return null;
    const num = (v: unknown) => Number((v as BN).toString());
    return {
      authority: raw.authority as PublicKey,
      arenaId: num(raw.arenaId),
      commitment: Buffer.from(raw.commitment as number[]),
      randomness: Buffer.from(raw.randomness as number[]),
      fulfilled: raw.fulfilled as boolean,
      requestedSlot: num(raw.requestedSlot),
      fulfilledSlot: num(raw.fulfilledSlot),
    };
  }

  async request(arenaId: number, commitment: Buffer): Promise<string | null> {
    const existing = await this.read(arenaId);
    if (existing) {
      if (!existing.commitment.equals(commitment)) throw new Error(`Arena ${arenaId} already has a VRF request with a different commitment`);
      return null;
    }
    const programIdentity = PublicKey.findProgramAddressSync([Buffer.from("identity")], this.programId)[0];
    return this.program.methods
      .requestMatchRandomness(new BN(arenaId), [...commitment])
      .accountsPartial({
        payer: this.authority.publicKey,
        matchRng: this.pda(arenaId),
        oracleQueue: VRF_DEFAULT_QUEUE,
        programIdentity,
        vrfProgram: VRF_PROGRAM_ID,
        slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async waitFulfilled(arenaId: number, timeoutMs = 60_000): Promise<MatchRandomnessAccount> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const acc = await this.read(arenaId);
        if (acc?.fulfilled) return acc;
      } catch {
        /* transient RPC error */
      }
      if (Date.now() > end) throw new Error(`MagicBlock VRF did not deliver randomness for arena ${arenaId} within ${timeoutMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
}
