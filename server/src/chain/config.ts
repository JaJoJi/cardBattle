import { Keypair, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
export const ENV_PATH = resolve(SERVER_ROOT, ".env");

export interface ChainConfig {
  enabled: boolean;
  cluster: "devnet";
  rpcUrl: string;
  /** Oracle + house wallet (creates arenas, enters as the AI, reports and finalizes). */
  house: Keypair | null;
  /** Why on-chain mode is disabled, if it is. */
  reason?: string;
}

/** Reads server/.env. On-chain mode is enabled only when a house key is configured. */
export function loadChainConfig(): ChainConfig {
  loadEnv({ path: ENV_PATH, quiet: true });
  const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
  const secret = process.env.CARDBATTLE_HOUSE_SECRET;
  if (!secret) {
    return { enabled: false, cluster: "devnet", rpcUrl, house: null, reason: "No house key — run `npm run chain:keygen` in server/" };
  }
  try {
    const house = Keypair.fromSecretKey(bs58.decode(secret));
    return { enabled: true, cluster: "devnet", rpcUrl, house };
  } catch {
    return { enabled: false, cluster: "devnet", rpcUrl, house: null, reason: "CARDBATTLE_HOUSE_SECRET is not a valid base58 secret key" };
  }
}
