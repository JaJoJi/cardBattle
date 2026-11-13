# RitArena Card Battle

Turn-based **human vs AI** card battle for [RitArena](https://github.com/BonChain/ritarena).
Both sides secretly pick up to two cards, then reveal together. An authoritative game server
and web client, with two play modes you can toggle in the top bar:

- **Practice** — free matches against the house bot (`search-v3`). No wallet, no chain, no API cost.
- **On-chain (devnet)** — challenge one of **five LLM champions** (via OpenRouter) for test USDC,
  settled through the deployed **RitArena program on Solana devnet** using `@ritarena/sdk`.
  Every challenge feeds a public **Card Battle benchmark**. See [LLM arena](#llm-arena-ai-champions)
  and [On-chain mode](#on-chain-mode-solana-devnet).

Staked matches are shuffled with **MagicBlock VRF** (see [Randomness](#randomness-magicblock-vrf)).
MagicBlock Private Ephemeral Rollups (private hands) are not integrated yet (see [Roadmap](#roadmap)).

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

## LLM arena (AI champions)

There are no stake tiers. A player picks a champion and pays its **current price**:

| Champion | OpenRouter id | Notes |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `deepseek/deepseek-v4.1-flash-1017` | |
| Hy4 | `tencent/hy4` | reasoning off (with it on, it spent its whole token cap thinking and returned nothing) |
| GLM 5.3 Flash | `z-ai/glm-5.3-flash` | |
| GPT-6 Luna | `openai/gpt-6-luna` | |
| Claude Opus 5.5 | `anthropic/claude-opus-5.5` | ~20–60× the API cost of the others; output capped at 800 tokens |

These are the top five vendors in OpenRouter's weekly ranking (2026-11-13). Edit them in `server/src/ai/llm/models.ts`.

**How a model plays** (`server/src/ai/llm/`): each turn it gets the rules, the card list and its own
`PlayerView` only, which is the same hidden-information projection the bot gets. It sees its own hand, public
counts and the last 6 public turns. No player-written text ever reaches the prompt. It replies with structured JSON
`{cards, reason}`, and the server validates that reply against hand, energy and card count. An illegal reply gets one retry with the
error; after that, or on a timeout (22 s per call), the model **passes**. The bot never fills in, so the benchmark measures the
model alone. The human's timer runs while the model thinks. Each turn's choice, reason and cost is saved with the match, so a
restart replays from the record and never asks the model again. **Reasons are only shown after the match ends**, because they
can hint at the model's hand.

**Pricing and bounty** (`server/src/arena/`):

```
price = (1 USDC + 3 × avg real API cost per match) × skill      rounded up to 0.10
skill = clamp(1 + 2·(winRate − ½), 0.75, 3)                     winRate smoothed with 20 pseudo-games at 50%
prize = max(2 × price, 70% of the champion's free bounty)       locked in the quote (5 min)
```

The money uses the existing equal-stake 1v1 arena, with no contract change. The player stakes the price, and the house stakes the same
amount from the champion's bounty. If the player wins, they claim the pot (2 × price − 1%) and the house sends `prize − pot` as a
separate USDC transfer. That transfer is sent **once and never auto-retried**, because a timed-out confirmation may still have landed.
If the house wins (draws included), it claims the pot. The player's half, minus the real API cost and a 10% platform cut, goes into that
champion's bounty. Stronger champions lose less often, so their bounties and prizes grow, which is what makes their higher price worth paying.
The house keeps each bounty at a 5 USDC floor (tracked as subsidy), and each accepted quote reserves its worst-case payout so
concurrent wins stay covered. The book lives in `server/data/arena-book.json`.

**API budget.** The server's OpenRouter key (`OPENROUTER_API_KEY`) has an $8 limit enforced by OpenRouter. On top of that, the
server checks a persistent ledger (`server/data/llm-spend.json`) before every call: `LLM_BUDGET_USD` (default 8) total and
`LLM_DAILY_USD` (default 1.5) per UTC day. Devnet USDC is free but API credit is real, so there is also a limit of 10 challenges per
wallet per day, and a champion rests whenever the budget can't cover 3 of its matches.

**Seed benchmark** (spends real credit, capped per run):

```bash
cd server
npm run llm:arena -- --models all --matches 1 --max-usd 0.5            # LLM vs search-v3 bot
npm run llm:arena -- --models z-ai/glm-5.3-flash --matches 10 --opponent heuristic-v2
```

Results go to `server/data/llm-benchmark.json`, and their costs seed price estimates until humans have played. They never count toward win rates.

`GET /api/arena` returns the leaderboard (record, win rate, cost, price, prize, bounty) and the budget.

## On-chain mode (Solana devnet)

Each staked match is a **1v1 RitArena arena** on the already-deployed program
(`5fYaY6696pCJfPQvxC3GwHEDS91hXs1JZNpEK4ZmhCfH`) — **no contract changes**.

| Step | Who signs | Instruction |
| --- | --- | --- |
| 0. Pick a champion → price quote; prove wallet ownership by signing a one-time message bound to wallet + price + champion (no tx, no fee) | **player wallet** | off-chain `signMessage` |
| 1. Create arena: entry fee = stake, max 2 agents, prize split `[100]`, creator fee 0, `rules_hash` = sha256 of rules + deck | house (server) | `create_arena` |
| 2. Player stakes (registers a profile first if needed) | **player wallet (Phantom)** | `register_profile`, `enter_arena` |
| 3. House matches the stake (from the champion's bounty), starts | house | `enter_arena`, `start_arena` |
| 4. Round 1: Merkle root committing to `sha256(seed ‖ matchId)` | house | `submit_elimination` |
| 5. One round per turn: Merkle root of the turn log, both HPs as scores | house | `submit_elimination` |
| 6. Finalize rank-1 winner (draw ⇒ house); house auto-claims if it won | house | `finalize_arena`, `claim_prize` |
| 7. Player claims if they won (2 × stake − 1% protocol fee); house sends the bounty top-up | **player wallet** / house | `claim_prize`, SPL transfer |

Safety ordering: the player stakes first and the house last, so if the house can't enter, the
server cancels the arena (`cancel_arena`) and the player gets a **Refund** button
(`refund_entry`). Players have a 10-minute entry window. If the server dies mid-match, the
arena can be abandoned after 30 minutes of oracle inactivity and both stakes refunded.
Gameplay never waits on the chain — turn commits are queued and sent in order.
Every house write is idempotent (it checks on-chain state first), so retries after a devnet
confirmation timeout or a stale RPC read never double-send; finalize and the house claim are
separate steps, and a failed claim never un-settles the match.

### Abuse limits & restart recovery

Creating an arena costs the house SOL (rent), so staked matches are gated:

- **Wallet sign-in** — the server issues a single-use challenge (5-minute expiry) bound to the wallet and
  stake; the match is only created if the ed25519 signature verifies (`server/src/chain/auth.ts`).
- **One open staked match per wallet**, max **6 per IP and 6 per wallet per hour**, at most **20 arenas
  waiting to start** at once, and new matches pause if the house has < 0.05 SOL.
- WebSocket hardening: 16 KB max message, 40 messages / 10 s per connection, 10 sign-in challenges / min.
  Set `TRUST_PROXY=1` only when running behind a reverse proxy that sets `X-Forwarded-For`.

**Restarts don't lose staked matches.** Each one is saved to `server/data/matches/<token>.json`
(gitignored, owner-only — it contains the secret seed) on every turn and chain update. Because the engine,
AI and RNG are deterministic for a given seed, a snapshot is just the seed plus the player's moves; on start
the server replays it to the exact same state and resumes from the saved phase:

| Saved phase | On restart |
| --- | --- |
| creating | cancelled (no one could have staked yet) |
| awaiting-entry / starting | resumes watching for the stake; enter/start are idempotent |
| playing / finalizing | replays the match, posts only rounds missing on-chain, finalizes + claims if over |
| settled / cancelled / failed | kept 7 days for display, then deleted |

Players reconnect to the same match automatically (their session token survives the restart).

### Randomness (MagicBlock VRF)

Staked matches use a small companion program, **`cardbattle_vrf`**
(`Ffw8AgNQn4iCYTeLuS8off5SzqSfdnexHZMx3BjpegL4` on devnet, source in `onchain/`), built on
MagicBlock's `ephemeral-rollups-sdk` 0.17.3 (VRF feature). It holds no funds and doesn't touch RitArena.

1. After **both** stakes are in (arena still in Registration), the house sends one transaction that
   stores `commitment = sha256(entropy ‖ matchId)` in a per-arena account **and** requests VRF with
   that commitment as the `caller_seed`. The house is bound to its secret entropy before the VRF output exists.
2. MagicBlock's oracle calls back `consume_match_randomness` (only the scoped VRF identity can, via
   `#[vrf_callback]`) and the verified 32-byte output is stored on-chain (~3 s on devnet).
3. The match seed is `sha256("RITARENA_SEED_V2" ‖ entropy ‖ vrf ‖ matchId)`: the house can't grind it,
   the oracle can't predict it, and the deck order stays private because the entropy is secret.
4. Only then is the arena started. If VRF never arrives, the arena is cancelled and both stakes refunded.
5. At the end the entropy is revealed; anyone can check it against the on-chain commitment, read the
   VRF output from the account, and reproduce both decks (`npm run chain:smoke -- vrf` does exactly this).

Rebuild / redeploy (WSL): `onchain/` is an Anchor 1.0.2 workspace; `anchor build`, then
`solana program deploy target/deploy/cardbattle_vrf.so --program-id target/deploy/cardbattle_vrf-keypair.json`
with the house key as upgrade authority. Set `CARDBATTLE_VRF_PROGRAM_ID` in `server/.env`; without it,
staked matches fall back to the server-seed commit-reveal below.

**Remaining trust:** the house still learns the decks once VRF lands (it runs the game), so before
starting it *could* cancel a match whose decks it dislikes — both stakes are refunded and the cancel is
public, but it is a free option. Closing that needs the game itself to run in a TEE / MagicBlock PER.

**Verifiable shuffle (fallback without VRF):** the secret seed's commitment is posted before turn 1 and the seed is
revealed when the match ends (shown in the match's chain panel). `sha256(seed ‖ matchId)` must
equal the commitment, and `createMatchRngs(matchId, versions, seed)` reproduces both decks.

### Setup

```bash
cd server
npm run chain:keygen        # creates a devnet house wallet in server/.env (gitignored)
# fund the printed address with devnet SOL at https://faucet.solana.com (≈1 SOL)
npm run chain:setup         # registers the house profile, mints 1,000 test USDC
npm run chain:smoke         # devnet checks: house-wins, player-wins (+claim), cancel, refund, restart, vrf
npm run chain:claim -- <id> # recover a house win whose claim step failed (safe to re-run)
cd .. && npm run build && npm start
```

Players need Phantom set to devnet (Settings → Developer Settings → Testnet Mode) with a little
devnet SOL; test USDC comes from the **Get 100 test USDC** button (the program's public faucet).
Without a house key the server runs Practice mode only and the toggle is disabled.

## Screens

- **Vault (home)** — free practice vs the house bot, the five LLM champions (price, prize, bounty, record), the benchmark leaderboard,
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
  src/pages/VaultPage.tsx  home: practice card, champions, leaderboard (src/pages/Champions.tsx)
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
- Randomness: MagicBlock VRF + house entropy for staked matches (see above); practice mode uses a local CSPRNG.
- Staked matches are persisted to local disk (single server). Running several server instances would need a shared store.
- Matches are in memory; a server restart loses them. No accounts, no wallet, no stakes.
- The AI is a simple heuristic (`heuristic-v1`) with small private-RNG tie-breaking; it's not tuned.
- Balance is untested: flat 5 energy means Meteor Impact is playable from turn 1.
- **Simulated balance (2,000 AI-vs-AI matches, deck-v3).** Avg ~9 turns; ~45% / ~42% win split between the
  two seats, ~13% DRAW (mutual KO → human loss). Deck-out no longer triggers in practice with 60 cards
  (it did in ~84% of matches with the old 22-card deck).

## Roadmap

1. ~~Settlement via the RitArena program~~ — done for devnet (on-chain mode).
2. ~~MagicBlock VRF~~ — done (devnet). Next: **MagicBlock PER** for hidden hands / game execution — verify per-identity private reads, private VRF consumption, and commit-back; commit to `hash(privateEntropy)` before requesting VRF to prevent grinding.
3. ~~Persist on-chain matches~~ — done. Next: separate the oracle from the house wallet.
4. Wallet-adapter support beyond Phantom; end-to-end browser tests.
5. Legal review of human-vs-house real-money play before any mainnet stakes.
