// Generates a fresh devnet house/oracle keypair into server/.env (gitignored).
// Usage: npm run chain:keygen [-- --force]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ENV_PATH } from "../src/chain/config";

const force = process.argv.includes("--force");
const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
if (/^CARDBATTLE_HOUSE_SECRET=/m.test(existing) && !force) {
  console.error(`A house key already exists in ${ENV_PATH}. Re-run with --force to replace it (the old wallet's funds stay with the old key).`);
  process.exit(1);
}

const kp = Keypair.generate();
const lines = existing
  .split(/\r?\n/)
  .filter((l) => l && !l.startsWith("CARDBATTLE_HOUSE_SECRET=") && !l.startsWith("CARDBATTLE_HOUSE_PUBKEY="));
lines.push(`CARDBATTLE_HOUSE_PUBKEY=${kp.publicKey.toBase58()}`);
lines.push(`CARDBATTLE_HOUSE_SECRET=${bs58.encode(kp.secretKey)}`);
if (!lines.some((l) => l.startsWith("SOLANA_RPC_URL="))) lines.push("SOLANA_RPC_URL=https://api.devnet.solana.com");
writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });

console.log("New devnet house wallet:", kp.publicKey.toBase58());
console.log(`Saved to ${ENV_PATH} (gitignored — never commit it).`);
console.log("Next: fund it with devnet SOL (https://faucet.solana.com), then run `npm run chain:setup`.");
