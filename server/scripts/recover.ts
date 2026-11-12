// Cleans up house arenas left behind by crashes or abandoned tests.
//   - Registration arenas older than the entry window → cancel_arena (anyone who staked can then refund)
//   - Active/Eliminating arenas past the oracle-inactivity timeout → abandon_arena, then refund the house's entry
//   - House wins that were never claimed → claim_prize
// Live matches are never touched: they post a round every turn, far inside the timeouts.
// Usage: npm run chain:recover [-- --dry-run]
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { arenaStateLabel, pdas } from "@ritarena/sdk";
import { loadChainConfig } from "../src/chain/config";
import { ArenaHouse } from "../src/chain/house";
import { ENTRY_TIMEOUT_MS } from "../src/chain/onchainMatch";

const dry = process.argv.includes("--dry-run");
const cfg = loadChainConfig();
if (!cfg.house) {
  console.error(cfg.reason);
  process.exit(1);
}
const house = new ArenaHouse(new Connection(cfg.rpcUrl, "confirmed"), cfg.house);
const now = Math.floor(Date.now() / 1000);
type RawProgram = { methods: Record<string, () => { accountsPartial(a: object): { rpc(): Promise<string> } }> };
const program = (house.sdk as unknown as { program: RawProgram }).program;

async function refundHouse(arenaId: number, usdcMint: PublicKey) {
  const arenaPda = pdas.arena(arenaId);
  return program.methods
    .refundEntry()
    .accountsPartial({
      agentOwner: house.publicKey,
      arena: arenaPda,
      arenaEntry: pdas.arenaEntry(arenaPda, pdas.agentProfile(house.publicKey)),
      arenaVault: pdas.arenaVault(arenaPda),
      agentUsdc: await getAssociatedTokenAddress(usdcMint, house.publicKey),
      usdcMint,
    })
    .rpc();
}

const arenas = await house.sdk.listArenas({ creator: house.publicKey });
let actions = 0;
for (const a of arenas.sort((x, y) => Number(x.id) - Number(y.id))) {
  const id = Number(a.id);
  const state = arenaStateLabel(a.state);
  const houseEntry = await house.sdk.getAgentDetails(id, house.publicKey);
  const act = async (label: string, fn: () => Promise<string | null>) => {
    actions++;
    if (dry) return console.log(`#${id} (${state}): would ${label}`);
    try {
      const sig = await fn();
      console.log(`#${id} (${state}): ${label} — ${sig ?? "already done"}`);
    } catch (e) {
      console.log(`#${id} (${state}): ${label} FAILED — ${(e as Error).message.slice(0, 160)}`);
    }
  };

  if ("registration" in a.state) {
    // `createdAt` is decoded from the account but missing from the SDK typings.
    const createdAt = Number((a as unknown as { createdAt: { toString(): string } }).createdAt.toString());
    if (now - createdAt > ENTRY_TIMEOUT_MS / 1000) await act("cancel (entry window expired)", () => house.cancel(id));
  } else if ("active" in a.state || "eliminating" in a.state) {
    const last = Math.max(Number(a.lastSubmissionAt), Number(a.startedAt));
    const timeout = 2 * Number(a.eliminationInterval);
    if (now - last >= timeout) {
      await act("abandon (oracle inactive)", () => house.sdk.abandonArena(id));
      if (houseEntry && !houseEntry.refunded) await act("refund house entry", () => refundHouse(id, a.usdcMint));
    } else if (now - last > 120) {
      console.log(`#${id} (${state}): idle ${Math.round((now - last) / 60)} min — abandonable in ${Math.ceil((timeout - (now - last)) / 60)} min`);
    }
  } else if (("cancelled" in a.state || "abandoned" in a.state) && houseEntry && !houseEntry.refunded) {
    await act("refund house entry", () => refundHouse(id, a.usdcMint));
  } else if ("finished" in a.state && houseEntry && houseEntry.prizeRank > 0 && !houseEntry.prizeClaimed) {
    await act("claim house prize", () => house.claim(id, 5_000));
  }
}
const b = await house.balances();
console.log(`${actions ? "" : "Nothing to recover. "}House: ${b.sol} SOL, ${b.usdc} test USDC`);
