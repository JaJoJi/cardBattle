// End-to-end devnet checks of the on-chain flow without a browser wallet.
// A throwaway player keypair (funded by the house) plays real staked matches.
//
// Usage: npm run chain:smoke [-- house-wins player-wins cancel refund restart]
//        (no args = all scenarios)
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { RitArena, arenaStateLabel, pdas } from "@ritarena/sdk";
import { chooseCards } from "../src/ai/bot";
import { loadChainConfig } from "../src/chain/config";
import { ArenaHouse, USDC } from "../src/chain/house";
import { OnChainMatch, type ChainPhase } from "../src/chain/onchainMatch";
import { createMatchRngs, createSeededRng, shuffle } from "../src/engine/rng";
import { canonicalDeck, DECK_VERSION } from "../src/engine/cards";
import { RULES } from "../src/engine/rules";
import { MatchVrf, deriveVrfMaster } from "../src/chain/vrf";
import { seedCommitment } from "../src/session";

const cfg = loadChainConfig();
if (!cfg.house) {
  console.error(cfg.reason);
  process.exit(1);
}
const connection = new Connection(cfg.rpcUrl, "confirmed");
const house = new ArenaHouse(connection, cfg.house);
const STAKE = 1 * USDC;
const ALL = ["house-wins", "player-wins", "cancel", "refund", "restart", "vrf"];
const vrfClient = cfg.vrfProgramId ? new MatchVrf(connection, cfg.house) : null;
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const hb = await house.balances();
console.log(`House ${house.publicKey.toBase58()}: ${hb.sol} SOL, ${hb.usdc} USDC`);
if (hb.sol < 0.5 || hb.usdc < 10) {
  console.error("House needs ≥0.5 SOL and ≥10 test USDC for the full smoke run.");
  process.exit(1);
}

// ---------------------------------------------------------------- player setup
const player = Keypair.generate();
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: player.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })),
  [cfg.house],
);
const playerSdk = RitArena.fromKeypair(connection, player);
await playerSdk.registerProfile("Smoke Player");
await playerSdk.mintTestUsdc(20 * USDC);
const usdcOf = async (pk: PublicKey) => (await house.balances(pk)).usdc;
console.log(`Player ${player.publicKey.toBase58()} funded: ${await usdcOf(player.publicKey)} USDC\n`);

// ---------------------------------------------------------------- helpers
const TERMINAL: ChainPhase[] = ["settled", "failed", "cancelled"];

function newMatch(log = true, useVrf = false) {
  return track(new OnChainMatch(
    house,
    player.publicKey,
    STAKE,
    (m) => {
      const t = m.status.txs.at(-1);
      if (log && t && t.status !== "pending") console.log(`    [${m.status.phase}] ${t.label}: ${t.status}${t.error ? ` — ${t.error}` : ""}`);
    },
    () => {},
    undefined,
    undefined,
    useVrf ? vrfClient ?? undefined : undefined,
  ));
}

async function until(m: OnChainMatch, pred: () => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout in phase ${m.status.phase}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function enterAndStart(m: OnChainMatch) {
  await m.begin();
  if (m.status.phase !== "awaiting-entry") throw new Error(`create failed: ${m.status.error}`);
  await playerSdk.enterArena(m.arenaId!);
  await house.waitUntil(() => house.hasEntered(m.arenaId!, player.publicKey), "player entry");
  await m.checkEntry();
  if ((m.status.phase as string) !== "playing") throw new Error(`start failed in phase ${m.status.phase}: ${m.status.error ?? "no error"}`);
}

/** Plays to the end. `smart` = the player uses the same heuristic as the AI. */
function playOut(m: OnChainMatch, smart: boolean, seed: string) {
  const rng = createSeededRng(Buffer.from(seed));
  let guard = 0;
  while (!m.session.finished && guard++ < 100) {
    const view = m.session.humanView().view;
    const r = m.session.commitHuman(view.turn, smart ? chooseCards(view, rng) : []);
    if (!r.ok) throw new Error(r.reason);
  }
}

async function arenaSummary(id: number) {
  const a = await house.sdk.getArena(id);
  const entries = await house.sdk.getArenaEntries(id);
  const who = (pk: PublicKey) => (pk.equals(house.publicKey) ? "house" : "player");
  return `${a ? arenaStateLabel(a.state) : "?"}, rounds ${a?.currentRound}, ` + entries.map((e) => `${who(e.owner)}: rank ${e.prizeRank} claimed ${e.prizeClaimed} refunded ${e.refunded}`).join("; ");
}

// ---------------------------------------------------------------- scenarios
const results: Record<string, string> = {};
const check = (name: string, ok: boolean, detail: string) => {
  results[name] = `${ok ? "PASS" : "FAIL"} — ${detail}`;
  console.log(`  => ${results[name]}\n`);
};

const live: OnChainMatch[] = [];
const track = <T extends OnChainMatch>(m: T) => (live.push(m), m);

for (const name of scenarios) {
  console.log(`▶ ${name}`);
  await new Promise((r) => setTimeout(r, 3_000)); // pace scenarios for public RPC limits
  try {
    if (name === "house-wins") {
      const m = newMatch();
      await enterAndStart(m);
      playOut(m, false, "pass");
      await until(m, () => TERMINAL.includes(m.status.phase));
      const s = await arenaSummary(m.arenaId!);
      check(name, m.status.phase === "settled" && m.status.winner === "HOUSE" && /house: rank 1 claimed true/.test(s), `arena #${m.arenaId}: ${s}`);
      m.dispose();
    } else if (name === "player-wins") {
      let won: OnChainMatch | null = null;
      for (let attempt = 1; attempt <= 6 && !won; attempt++) {
        const m = newMatch(false);
        await enterAndStart(m);
        playOut(m, true, `smart-${attempt}-${Date.now()}`);
        await until(m, () => TERMINAL.includes(m.status.phase));
        console.log(`    attempt ${attempt}: arena #${m.arenaId} → ${m.status.winner} (${m.session.outcome.outcome})`);
        if (m.status.winner === "PLAYER") won = m;
        else m.dispose();
      }
      if (!won) {
        check(name, false, "player did not win in 6 attempts (heuristic vs heuristic) — re-run");
        continue;
      }
      const before = await usdcOf(player.publicKey);
      const sig = await playerSdk.claimPrize(won.arenaId!);
      const want = before + won.status.payoutMicro / USDC;
      await house.waitUntil(async () => (await usdcOf(player.publicKey)) >= want - 1e-6, "player prize");
      const after = await usdcOf(player.publicKey);
      const s = await arenaSummary(won.arenaId!);
      check(name, Math.abs(after - before - won.status.payoutMicro / USDC) < 1e-6, `arena #${won.arenaId}: claimed ${after - before} USDC (${sig.slice(0, 16)}…); ${s}`);
      won.dispose();
    } else if (name === "cancel") {
      const m = newMatch();
      await m.begin();
      await m.cancelByPlayer();
      await house.waitUntil(async () => "cancelled" in ((await house.sdk.getArena(m.arenaId!))?.state ?? {}), "cancel");
      const s = await arenaSummary(m.arenaId!);
      check(name, m.status.phase === "cancelled" && s.startsWith("Cancelled"), `arena #${m.arenaId}: ${s}`);
      m.dispose();
    } else if (name === "refund") {
      // Player stakes, then the arena is cancelled before the house enters (what the server
      // does when the house can't enter). The player signs refund_entry.
      const m = newMatch();
      await m.begin();
      await playerSdk.enterArena(m.arenaId!);
      await house.waitUntil(() => house.hasEntered(m.arenaId!, player.publicKey), "player entry");
      await house.cancel(m.arenaId!);
      await house.waitUntil(async () => "cancelled" in ((await house.sdk.getArena(m.arenaId!))?.state ?? {}), "cancel");
      const before = await usdcOf(player.publicKey);
      const arenaPda = pdas.arena(m.arenaId!);
      const arena = (await house.sdk.getArena(m.arenaId!))!;
      const program = (playerSdk as unknown as { program: { methods: { refundEntry(): { accountsPartial(a: object): { rpc(): Promise<string> } } } } }).program;
      await program.methods
        .refundEntry()
        .accountsPartial({
          agentOwner: player.publicKey,
          arena: arenaPda,
          arenaEntry: pdas.arenaEntry(arenaPda, pdas.agentProfile(player.publicKey)),
          arenaVault: pdas.arenaVault(arenaPda),
          agentUsdc: await getAssociatedTokenAddress(arena.usdcMint, player.publicKey),
          usdcMint: arena.usdcMint,
        })
        .rpc();
      await house.waitUntil(async () => (await usdcOf(player.publicKey)) >= before + STAKE / USDC - 1e-6, "refund");
      const after = await usdcOf(player.publicKey);
      const s = await arenaSummary(m.arenaId!);
      check(name, Math.abs(after - before - STAKE / USDC) < 1e-6, `arena #${m.arenaId}: refunded ${after - before} USDC; ${s}`);
      m.dispose();
    } else if (name === "restart") {
      // Play 3 turns, "crash" (drop the object), restore from the snapshot, finish.
      const m = newMatch();
      await enterAndStart(m);
      for (let t = 1; t <= 3 && !m.session.finished; t++) m.session.commitHuman(m.session.humanView().view.turn, []);
      await until(m, () => m.status.txs.filter((t) => t.status === "ok" && t.label.startsWith("Commit")).length >= 2, 60_000);
      const snap = m.snapshot();
      const turnBefore = m.session.humanView().view.turn;
      m.dispose();
      console.log(`    simulated crash at turn ${turnBefore}; restoring…`);
      const r = track(OnChainMatch.restore(house, snap, (x) => {
        const t = x.status.txs.at(-1);
        if (t && t.status !== "pending") console.log(`    [restored:${x.status.phase}] ${t.label}: ${t.status}${t.error ? ` — ${t.error}` : ""}`);
      }, () => {}));
      const sameTurn = r.session.humanView().view.turn === turnBefore;
      await r.resume();
      playOut(r, false, "pass");
      await until(r, () => TERMINAL.includes(r.status.phase));
      const failedTx = r.status.txs.filter((t) => t.status === "failed");
      const s = await arenaSummary(r.arenaId!);
      check(name, sameTurn && r.status.phase === "settled" && failedTx.length === 0, `arena #${r.arenaId}: resumed at turn ${turnBefore}, ${s}${failedTx.length ? `; failed: ${failedTx.map((t) => t.label).join(", ")}` : ""}`);
      r.dispose();
    } else if (name === "vrf") {
      if (!vrfClient) {
        check(name, false, "CARDBATTLE_VRF_PROGRAM_ID not set");
        continue;
      }
      const m = newMatch(true, true);
      await enterAndStart(m);
      const opening = m.session.humanView().view.self.hand.map((c) => c.uid);
      playOut(m, false, "pass");
      await until(m, () => TERMINAL.includes(m.status.phase));
      // Independent verification from public data: on-chain VRF account + revealed entropy.
      const acc = (await vrfClient.read(m.arenaId!))!;
      const entropy = Buffer.from(m.status.seedReveal!, "hex");
      const commitOk = acc.commitment.toString("hex") === seedCommitment(entropy, m.session.matchId);
      const master = deriveVrfMaster(entropy, acc.randomness, m.session.matchId);
      const deck = shuffle(canonicalDeck(), createMatchRngs(m.session.matchId, { rules: RULES.version, deck: DECK_VERSION }, master).humanDeck);
      const dealOk = JSON.stringify(deck.slice(0, 6)) === JSON.stringify(opening);
      const s = await arenaSummary(m.arenaId!);
      check(
        name,
        m.status.phase === "settled" && acc.fulfilled && commitOk && dealOk,
        `arena #${m.arenaId}: VRF ${m.status.vrf?.account} fulfilled=${acc.fulfilled}, commitment ok=${commitOk}, opening hand re-derived=${dealOk}; ${s}`,
      );
    } else {
      console.log(`  unknown scenario ${name}`);
    }
  } catch (e) {
    check(name, false, (e as Error).message);
  } finally {
    for (const m of live.splice(0)) m.dispose(); // stop pollers even when a scenario fails
  }
}

console.log("Summary:");
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(12)} ${v}`);
const final = await house.balances();
console.log(`House now: ${final.sol} SOL, ${final.usdc} USDC`);
process.exit(Object.values(results).every((r) => r.startsWith("PASS")) ? 0 : 1);
