// Prepares the house wallet on devnet: checks SOL, registers the RitArena profile,
// and tops up test USDC (the program's public devnet faucet, max 1,000 per call).
// Usage: npm run chain:setup [-- --usdc 1000]
import { Connection } from "@solana/web3.js";
import { MAX_TEST_USDC_PER_CALL } from "@ritarena/sdk";
import { loadChainConfig } from "../src/chain/config";
import { ArenaHouse, USDC } from "../src/chain/house";

const cfg = loadChainConfig();
if (!cfg.house) {
  console.error(cfg.reason);
  process.exit(1);
}
const flag = process.argv.indexOf("--usdc");
const wantUsdc = flag > 0 ? Number(process.argv[flag + 1]) : 1000;

const house = new ArenaHouse(new Connection(cfg.rpcUrl, "confirmed"), cfg.house);
console.log("House wallet:", house.publicKey.toBase58());

const before = await house.balances();
console.log(`Balance: ${before.sol} SOL, ${before.usdc} test USDC`);
if (before.sol < 0.05) {
  console.error("Not enough devnet SOL for fees/rent. Fund the wallet at https://faucet.solana.com and re-run.");
  process.exit(1);
}

const profileTx = await house.ensureProfile();
console.log(profileTx ? `Registered house profile: ${profileTx}` : "House profile already registered.");

let remaining = Math.max(0, wantUsdc - before.usdc) * USDC;
while (remaining > 0) {
  const amount = Math.min(remaining, MAX_TEST_USDC_PER_CALL);
  const tx = await house.sdk.mintTestUsdc(amount);
  console.log(`Minted ${amount / USDC} test USDC: ${tx}`);
  remaining -= amount;
}

const after = await house.balances();
console.log(`Ready: ${after.sol} SOL, ${after.usdc} test USDC`);
