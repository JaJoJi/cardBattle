# RitArena Card Battle

Turn-based **human vs AI** card battle for [RitArena](https://github.com/BonChain/ritarena).
Both sides secretly pick up to two cards, then reveal together. An authoritative game server
and web client, with two play modes you can toggle in the top bar:

- **Practice** — free matches against the house AI with a mock vault (no wallet, no chain).
- **On-chain (devnet)** — staked matches settled through the deployed **RitArena program on
  Solana devnet** using `@ritarena/sdk`, with test USDC. See [On-chain mode](#on-chain-mode-solana-devnet).

MagicBlock VRF / Private Ephemeral Rollups are not integrated yet (see [Roadmap](#roadmap)).

## Quick start

Requires Node.js 20+.

```bash
npm install          # root (dev tooling)
npm run install:all  # server + web dependencies

npm run dev          # server :3000 + Vite dev client :5173  → open http://localhost:5173
# or
npm run build && npm start   # production build served by the server → http://localhost:3000

npm test             # engine, privacy and session tests (vitest)
```

## On-chain mode (Solana devnet)

Each staked match is a **1v1 RitArena arena** on the already-deployed program
(`5fYaY6696pCJfPQvxC3GwHEDS91hXs1JZNpEK4ZmhCfH`) — **no contract changes**.

| Step | Who signs | Instruction |
| --- | --- | --- |
| 1. Create arena: entry fee = stake, max 2 agents, prize split `[100]`, creator fee 0, `rules_hash` = sha256 of rules + deck | house (server) | `create_arena` |
| 2. Player stakes (registers a profile first if needed) | **player wallet (Phantom)** | `register_profile`, `enter_arena` |
| 3. House matches the stake, starts | house | `enter_arena`, `start_arena` |
| 4. Round 1: Merkle root committing to `sha256(seed ‖ matchId)` | house | `submit_elimination` |
| 5. One round per turn: Merkle root of the turn log, both HPs as scores | house | `submit_elimination` |
| 6. Finalize rank-1 winner (draw ⇒ house); house auto-claims if it won | house | `finalize_arena`, `claim_prize` |
| 7. Player claims if they won (2 × stake − 1% protocol fee) | **player wallet** | `claim_prize` |

Safety ordering: the player stakes first and the house last, so if the house can't enter, the
server cancels the arena (`cancel_arena`) and the player gets a **Refund** button
(`refund_entry`). Players have a 10-minute entry window. If the server dies mid-match, the
arena can be abandoned after 30 minutes of oracle inactivity and both stakes refunded.
Gameplay never waits on the chain — turn commits are queued and sent in order.

**Verifiable shuffle:** the secret seed's commitment is posted before turn 1 and the seed is
revealed when the match ends (shown in the match's chain panel). `sha256(seed ‖ matchId)` must
equal the commitment, and `createMatchRngs(matchId, versions, seed)` reproduces both decks.

### Setup

```bash
cd server
npm run chain:keygen        # creates a devnet house wallet in server/.env (gitignored)
# fund the printed address with devnet SOL at https://faucet.solana.com (≈1 SOL)
npm run chain:setup         # registers the house profile, mints 1,000 test USDC
npm run chain:smoke         # optional: full devnet match with a throwaway player
cd .. && npm run build && npm start
```

Players need Phantom set to devnet (Settings → Developer Settings → Testnet Mode) with a little
devnet SOL; test USDC comes from the **Get 100 test USDC** button (the program's public faucet).
Without a house key the server runs Practice mode only and the toggle is disabled.

## Screens

- **Vault (home)** — house-vault stats, stake tiers (Bronze 1 / Silver 5 / Gold 25 / Mythic 100 USDC, 1.9× win payout),
  payout rules and recent settlements. **All vault numbers are mock data** from `web/src/data/mockVault.ts`; no funds move.
  Shows a "Continue match" banner if a match is in progress.
- **Match board** — felt table with the AI seat (HP orb, card backs, deck), arena lanes (AI lock seal vs your chosen
  cards), your seat (HP orb, energy crystals, deck), a fanned hand, a reveal overlay with card-flip after each turn,
  a battle log, and a game-over screen with the mock payout.

### Art placeholders

All art is optional. Drop files into `web/public/` with the names in
[`web/public/ASSETS.md`](web/public/ASSETS.md) (`cards/<card-id>.png`, `cards/back.png`, `avatars/player.png`,
`avatars/ai.png`, `vault/emblem.png`); anything missing falls back to a styled placeholder. Paths live in `web/src/assets.ts`.

## How to play

| Rule | Value |
| --- | --- |
| Starting HP (both) | 40 (max 40) |
| Starting hand | 5 cards, then 1 draw at the start of every turn (incl. turn 1) |
| Max hand size | 7 — a draw that would exceed it is skipped (shown in the UI) |
| Energy | 5 every turn, does not carry over |
| Cards per turn | 0, 1 or 2, total cost ≤ 5 |
| Selection | Simultaneous and hidden; revealed together once both are locked |
| Decks | Identical **60-card** deck (30 different cards × 2), separate independently shuffled copies |
| Deck building | Max **60 cards**, max **2 copies** of any card (`validateDeck`, enforced at match creation) |
| **Deck-out defeat** | At the End phase, a player with **1 or fewer cards left in their draw pile loses** |
| Draw (both defeated the same turn — by HP, deck-out, or one of each) | Recorded as `DRAW`, settled as a **human loss** (house rule) |

**Block only stops Attack damage.** All incoming Attack damage in a turn is summed into one
pool and the target's Block is subtracted once (`max(0, attack − block)`), so card order never
matters. Spell damage, Poison, and reflected damage ignore Block. Block expires at end of turn.

### Cards (deck-v3 — every card ×2)

Cards can combine effects (e.g. damage + Block). The engine resolves effects in its fixed phase
order below, never in the order they're listed on the card. Poison = 1/turn for 3 turns, refreshes, never stacks.

| Card | Type | Cost | Effect |
| --- | --- | --- | --- |
| Quick Strike | Attack | 1 | 2 damage |
| Heavy Strike | Attack | 2 | 4 damage |
| Shield Bash | Attack | 2 | 2 damage + 3 Block |
| Piercing Arrow | Attack | 2 | 3 **unblockable** damage |
| Venom Strike | Attack | 3 | 1 damage + Poison (applies even if blocked) |
| Cleave | Attack | 3 | 7 damage |
| Rending Claw | Attack | 3 | 4 damage + Poison |
| Draining Bite | Attack | 3 | 4 damage + heal 2 |
| Crushing Blow | Attack | 4 | 11 damage |
| Phantom Lance | Attack | 4 | 7 unblockable damage |
| Guillotine | Attack | 5 | 13 unblockable damage |
| Meteor Impact | Attack | 5 | 20 damage |
| Basic Shield | Defense | 1 | 3 Block |
| Bandage | Defense | 1 | 1 Block + heal 2 |
| Fortify | Defense | 2 | 6 Block |
| Tactical Retreat | Defense | 2 | 4 Block + draw 1 |
| Arcane Barrier | Defense | 3 | 10 Block |
| Second Wind | Defense | 3 | 5 Block + heal 4 |
| Iron Skin | Defense | 4 | 14 Block |
| Mirror Shield | Defense | 4 | 6 Block + Reflection this turn |
| Divine Protection | Defense | 5 | 20 Block |
| Arcane Insight | Spell | 1 | Draw 2 (after Disruption; respects hand limit; opponent sees only the count) |
| Toxic Cloud | Spell | 2 | Poison |
| Regeneration | Spell | 2 | Heal 2 at End phase, 3 turns |
| Unstoppable | Spell | 2 | All your Attack damage this turn is unblockable |
| Lifesteal | Spell | 2 | This turn + next, heal for HP damage your cards deal |
| Arcane Bolt | Spell | 3 | 5 Spell damage |
| Disruption | Spell | 3 | Opponent discards 2 random cards (caster doesn't see which) |
| Reflection | Spell | 3 | This turn, HP damage you take from cards is dealt back |
| Fireball | Spell | 4 | 9 Spell damage |

Values live in `server/src/engine/cards.ts` and `server/src/engine/rules.ts`.

### Resolution order (one turn)

1. **Start** — each side draws 1 (skipped if hand is 7 or deck empty), energy set to 5.
2. **Planning** — the AI locks its choice first (from its own view only); the human then locks or passes. Timer: 60 s, then auto-pass.
3. **Reveal + resolution** (both sides from the same snapshot):
   1. re-validate both selections · 2. consume cards & energy · 3. Block and flags (Unstoppable, Reflection, Lifesteal, Regeneration) ·
   4. random discard (Disruption) from the *remaining* hand — committed cards can't be invalidated · 4b. card draw (Arcane Insight) ·
   5–7. blockable Attack damage → one shared pool vs Block; unblockable Attack damage (card flag or Unstoppable) skips Block; apply Poison · 8. Spell damage ·
   9. Reflection, then Lifesteal (from actual HP damage) · 10. instant card heals, then Regeneration · 11. Poison ticks · 12. expire Block/statuses · 13. outcome — a side is defeated if HP ≤ 0 **or** its draw pile has ≤ 1 card.
4. Both sides' committed effects always resolve, even if someone hits 0 HP mid-turn.

## Proposed defaults (spec left these open)

These are deliberate choices, centralised so the product owner can change them:

| Topic | Default | Where |
| --- | --- | --- |
| Turn-1 draw | Yes — turn 1 starts with 6 cards in hand | `engine.ts` `startPhase` |
| Deck list | 60 cards = 30 cards × 2; new card values are prototypes | `cards.ts` |
| Deck-out threshold | ≤ 1 card at the End phase = defeat (`RULES.deckOutThreshold`) | `rules.ts` |
| Hand overflow | Draw skipped (card stays in deck), shown in UI | `engine.ts` |
| Poison | 1 dmg/tick, 3 End phases incl. the turn applied; reapply refreshes, never stacks | `rules.ts` |
| Durations | `duration` counts the current turn; decremented in End phase | `engine.ts` |
| Reflection | Reflects actual HP damage from Attack+Spell cards; ignores Block; cannot be re-reflected; doesn't reflect Poison | `engine.ts` |
| Lifesteal | Heals actual HP damage dealt by own Attack+Spell cards; not Poison/Reflect | `engine.ts` |
| Healing vs lethal | Healing cannot revive a player whose HP is ≤ 0 after damage | `engine.ts` `heal` |
| Turn limit | 60 turns; then higher HP wins, equal HP = DRAW (deck-out at ~turn 54 comes first) | `rules.ts` |
| Timeout | Human auto-passes after 60 s | `rules.ts`, `session.ts` |
| Card costs/values | All non-spec cards (see table) are proposed prototypes | `cards.ts` |
| Public counts | Hand size, deck remaining and discard count are public (never identities/order) | `projection.ts` |

## Architecture

```
server/                    Node + TypeScript, authoritative
  src/engine/types.ts      card/effect schema, private state, per-viewer projections (pure types)
  src/engine/cards.ts      card catalog + canonical deck
  src/engine/rules.ts      gameplay constants
  src/engine/rng.ts        seeded HMAC-SHA256 RNG, rejection sampling, Fisher–Yates
  src/engine/engine.ts     setup, validation, commit, deterministic turn resolver
  src/engine/projection.ts projectFor(state, side) — the only way state leaves the engine
  src/ai/bot.ts            deterministic heuristic AI (input: AI projection only)
  src/session.ts           one match: commit locking, AI-first commit, timeouts, seed commitment
  src/chain/config.ts      loads server/.env (house key, RPC)
  src/chain/house.ts       ArenaHouse: @ritarena/sdk wrapper (create/enter/start/round/finalize/cancel)
  src/chain/onchainMatch.ts staked-match lifecycle, ordered tx queue, refund/cancel paths
  scripts/                 chain:keygen, chain:setup, chain:smoke
  src/index.ts             HTTP (serves web/dist) + WebSocket /ws
  tests/                   engine, privacy/randomness, session tests
web/                       React + Vite client (renders projections, submits actions)
  src/pages/VaultPage.tsx  home: mock vault stats, stake tiers, settlements
  src/pages/MatchPage.tsx  game board, hand, reveal overlay, game over
  src/components/          GameCard, Hud (HP orb, energy, portraits), BattleLog, RevealOverlay
  src/data/mockVault.ts    MOCK vault data (Practice mode)
  src/pages/ChainVault.tsx live devnet vault (house balances, recent arenas) + wallet panel
  src/components/ChainParts.tsx mode toggle, staking screen, chain status/tx log, claim/refund
  src/lib/wallet.ts        Phantom connection; src/lib/chainClient.ts player-signed SDK calls
  public/ASSETS.md         expected art file names
```

Protocol (`server/src/protocol.ts`): client sends `new-match`, `resume {token}`, `commit {turn, cards}`;
server sends `welcome {catalog}`, `session {token}`, `state {view, deadline}`, `error`. The `turn`
field rejects stale/replayed submissions; the session token in `sessionStorage` lets a reload resume.

### Hidden information

- The full `MatchState` (both hands, deck permutations, draw pointers, pending commits) only exists in server memory.
- Clients receive `projectFor(state, "HUMAN")`: public state + own hand. The opponent is represented by counts and a `committed: boolean`.
- The AI receives `projectFor(state, "AI")` — the same function, so it structurally cannot see the human's hand or any deck order. A test confirms the AI's choice is unchanged when the hidden human hand changes.
- The AI commits **before** the human can submit each turn, so its choice can't depend on the human's.
- Disruption tells the caster only *how many* cards were discarded; the victim sees which.
- Card instance ids (`fortify#2`) come from the canonical pre-shuffle order, so they don't leak deck position.
- Server logs contain only match id, turn, HP and outcome.
- Each match draws a 32-byte secret from `crypto.randomBytes`, split into domain-separated streams (`human deck`, `AI deck`, `resolution`, `AI policy`) bound to match id + rules/deck versions.

## Trust assumptions & known limitations (MVP)

- **The game server is trusted for gameplay.** It sees both hands and both decks and computes every turn. On-chain mode
  makes the *money* trust-minimised (escrow, payouts and refunds are enforced by the RitArena program) and makes the
  *shuffle* verifiable after the fact (seed commitment → reveal), but the per-turn results and the winner it reports are
  the oracle's word. The per-turn Merkle roots let a full log be checked later; they don't prove correct play.
- The house wallet is also the arena oracle (it reports the result of a match it is playing in). That's inherent to the
  current RitArena oracle model; an independent oracle or PER/TEE execution is the next step.
- Randomness is server-local CSPRNG (committed before play in on-chain mode), not VRF.
- On-chain matches live in server memory; if the server restarts mid-match, recovery is via abandon → refund after 30 min.
- Matches are in memory; a server restart loses them. No accounts, no wallet, no stakes.
- The AI is a simple heuristic (`heuristic-v1`) with small private-RNG tie-breaking; it's not tuned.
- Balance is untested: flat 5 energy means Meteor Impact is playable from turn 1.
- **Simulated balance (2,000 AI-vs-AI matches, deck-v3).** Avg ~9 turns; ~45% / ~42% win split between the
  two seats, ~13% DRAW (mutual KO → human loss). Deck-out no longer triggers in practice with 60 cards
  (it did in ~84% of matches with the old 22-card deck).

## Roadmap

1. ~~Settlement via the RitArena program~~ — done for devnet (on-chain mode).
2. **MagicBlock VRF + PER proof of concept** — verify per-identity private reads, private VRF consumption, and commit-back; commit to `hash(privateEntropy)` before requesting VRF to prevent grinding.
3. Persist on-chain matches (resume after server restart), separate oracle from house wallet.
4. Wallet-adapter support beyond Phantom; end-to-end browser tests.
5. Legal review of human-vs-house real-money play before any mainnet stakes.
