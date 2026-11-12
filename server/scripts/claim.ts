// Recovers a house win whose prize wasn't collected (e.g. the claim step failed).
// Safe to re-run: it does nothing if the prize was already claimed.
// Usage: npm run chain:claim -- <arenaId> [<arenaId> ...]
import { Connection } from "@solana/web3.js";
import { arenaStateLabel } from "@ritarena/sdk";
import { loadChainConfig } from "../src/chain/config";
import { ArenaHouse } from "../src/chain/house";

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
if (ids.length === 0) {
  console.error("Usage: npm run chain:claim -- <arenaId> [...]");
  process.exit(1);
}
const cfg = loadChainConfig();
if (!cfg.house) {
  console.error(cfg.reason);
  process.exit(1);
}
const house = new ArenaHouse(new Connection(cfg.rpcUrl, "confirmed"), cfg.house);
let failed = false;
for (const id of ids) {
  const arena = await house.sdk.getArena(id);
  if (!arena) {
    console.log(`#${id}: not found`);
    failed = true;
    continue;
  }
  if (!arena.creator.equals(house.publicKey)) {
    console.log(`#${id}: not created by this house wallet — skipping`);
    continue;
  }
  try {
    const sig = await house.claim(id, 5_000);
    console.log(sig ? `#${id}: claimed — https://explorer.solana.com/tx/${sig}?cluster=devnet` : `#${id}: already claimed`);
  } catch (e) {
    console.log(`#${id} (${arenaStateLabel(arena.state)}): ${(e as Error).message}`);
    failed = true;
  }
}
const b = await house.balances();
console.log(`House now holds ${b.usdc} test USDC, ${b.sol} SOL`);
process.exit(failed ? 1 : 0);
