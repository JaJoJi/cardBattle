// End-to-end devnet check of the on-chain flow without a browser wallet.
// Uses the funded house wallet plus a throwaway player keypair:
//   fund player (0.05 SOL from house) → player mints test USDC → create arena →
//   player enters → house enters + starts → play (player passes) → finalize → claims.
// Usage: npm run chain:smoke   (requires `npm run chain:setup` first)
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { RitArena, arenaStateLabel } from "@ritarena/sdk";
import { loadChainConfig } from "../src/chain/config";
import { ArenaHouse, USDC } from "../src/chain/house";
import { OnChainMatch } from "../src/chain/onchainMatch";

const cfg = loadChainConfig();
if (!cfg.house) {
  console.error(cfg.reason);
  process.exit(1);
}
const connection = new Connection(cfg.rpcUrl, "confirmed");
const house = new ArenaHouse(connection, cfg.house);
const STAKE = 1 * USDC;

const hb = await house.balances();
console.log(`House ${house.publicKey.toBase58()}: ${hb.sol} SOL, ${hb.usdc} USDC`);
if (hb.sol < 0.15 || hb.usdc < 1) {
  console.error("House needs ≥0.15 SOL and ≥1 test USDC. Run `npm run chain:setup` after funding.");
  process.exit(1);
}

// 1. Throwaway player, funded by the house for fees + rent.
const player = Keypair.generate();
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: player.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
  [cfg.house],
);
const playerSdk = RitArena.fromKeypair(connection, player);
await playerSdk.registerProfile("Smoke Player");
await playerSdk.mintTestUsdc(5 * USDC);
console.log(`Player ${player.publicKey.toBase58()} funded`);

// 2. Drive a real OnChainMatch exactly as the server does.
let done: () => void;
const finished = new Promise<void>((r) => (done = r));
const match = new OnChainMatch(
  house,
  player.publicKey,
  STAKE,
  (m) => {
    const last = m.status.txs.at(-1);
    if (last) console.log(`  [${m.status.phase}] ${last.label}: ${last.status}${last.sig ? ` ${last.sig}` : ""}${last.error ? ` — ${last.error}` : ""}`);
    if (["settled", "failed", "cancelled"].includes(m.status.phase)) done();
  },
  () => {},
);
await match.begin();
if (match.status.phase !== "awaiting-entry") process.exit(1);
console.log(`Arena #${match.arenaId} created; player entering…`);
console.log("  player enter:", await playerSdk.enterArena(match.arenaId!));
await match.checkEntry();

// 3. Play: the player passes every turn until the match ends (house AI wins).
let guard = 0;
while (!match.session.finished && guard++ < 100) {
  const t = match.session.humanView().view.turn;
  const r = match.session.commitHuman(t, []);
  if (!r.ok) throw new Error(r.reason);
}
console.log(`Match over after ${match.session.humanView().view.lastTurn?.turn} turns: ${match.session.outcome.outcome}`);
await finished;

const arena = await house.sdk.getArena(match.arenaId!);
console.log(`Arena #${match.arenaId} state: ${arena ? arenaStateLabel(arena.state) : "?"}, rounds: ${arena?.currentRound}`);
console.log(`Seed commitment ${match.status.seedCommitment}\nSeed reveal      ${match.status.seedReveal}`);
const ok = (match.status.phase as string) === "settled";
console.log(ok ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED: ${match.status.error}`);
match.dispose();
process.exit(ok ? 0 : 1);
