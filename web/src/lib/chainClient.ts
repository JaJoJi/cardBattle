// Player-side RitArena actions, signed in the player's wallet via @ritarena/sdk.
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { RitArena, pdas } from "@ritarena/sdk";
import type { BrowserWallet } from "./wallet";

export const USDC = 1_000_000;

let conn: Connection | null = null;
export function connection(rpcUrl: string): Connection {
  if (!conn || conn.rpcEndpoint !== rpcUrl) conn = new Connection(rpcUrl, "confirmed");
  return conn;
}

function sdkFor(rpcUrl: string, wallet: BrowserWallet): RitArena {
  // The SDK expects an Anchor Wallet; Phantom signs, nothing else is needed.
  return new RitArena(connection(rpcUrl), wallet as unknown as ConstructorParameters<typeof RitArena>[1]);
}

export async function walletBalances(rpcUrl: string, owner: string): Promise<{ sol: number; usdc: number }> {
  const c = connection(rpcUrl);
  const pk = new PublicKey(owner);
  const reader = RitArena.readOnly(c);
  const [lamports, protocol] = await Promise.all([c.getBalance(pk), reader.getProtocol()]);
  let usdc = 0;
  if (protocol) {
    try {
      const ata = await getAssociatedTokenAddress(protocol.usdcMint, pk);
      usdc = Number((await c.getTokenAccountBalance(ata)).value.amount) / USDC;
    } catch {
      usdc = 0;
    }
  }
  return { sol: lamports / LAMPORTS_PER_SOL, usdc };
}

/** Public devnet test-USDC faucet built into the RitArena program (max 1,000 per call). */
export async function mintTestUsdc(rpcUrl: string, wallet: BrowserWallet, amountUsdc: number): Promise<string> {
  return sdkFor(rpcUrl, wallet).mintTestUsdc(amountUsdc * USDC);
}

/** Registers a RitArena profile if needed, then stakes by entering the arena. */
export async function enterArena(rpcUrl: string, wallet: BrowserWallet, arenaId: number): Promise<string[]> {
  const sdk = sdkFor(rpcUrl, wallet);
  const sigs: string[] = [];
  if (!(await sdk.hasProfile(wallet.publicKey))) {
    sigs.push(await sdk.registerProfile(`Player ${wallet.publicKey.toBase58().slice(0, 4)}`));
  }
  for (let attempt = 1; ; attempt++) {
    try {
      sigs.push(await sdk.enterArena(arenaId));
      return sigs;
    } catch (e) {
      // A just-created arena may not be visible on the RPC yet.
      if (attempt >= 5 || !/not found/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export async function claimPrize(rpcUrl: string, wallet: BrowserWallet, arenaId: number): Promise<string> {
  return sdkFor(rpcUrl, wallet).claimPrize(arenaId);
}

/** Refunds the player's entry from a cancelled arena (`refund_entry`; no SDK wrapper yet). */
export async function refundEntry(rpcUrl: string, wallet: BrowserWallet, arenaId: number): Promise<string> {
  const sdk = sdkFor(rpcUrl, wallet);
  const arena = await sdk.getArena(arenaId);
  if (!arena) throw new Error(`Arena ${arenaId} not found`);
  const arenaPda = pdas.arena(arenaId);
  const owner = wallet.publicKey;
  const program = (sdk as unknown as {
    program: { methods: { refundEntry(): { accountsPartial(a: object): { rpc(): Promise<string> } } } };
  }).program;
  return program.methods
    .refundEntry()
    .accountsPartial({
      agentOwner: owner,
      arena: arenaPda,
      arenaEntry: pdas.arenaEntry(arenaPda, pdas.agentProfile(owner)),
      arenaVault: pdas.arenaVault(arenaPda),
      agentUsdc: await getAssociatedTokenAddress(arena.usdcMint, owner),
      usdcMint: arena.usdcMint,
    })
    .rpc();
}

export const friendlyError = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  if (/User rejected/i.test(m)) return "You rejected the request in your wallet.";
  if (/insufficient lamports|0x1\b|Attempt to debit/i.test(m)) return "Not enough devnet SOL for fees — fund your wallet at faucet.solana.com.";
  if (/insufficient funds/i.test(m)) return "Not enough test USDC — use the faucet button first.";
  return m.slice(0, 220);
};
