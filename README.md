# RitArena Card Battle

Turn-based **human vs AI** card battle for [RitArena](https://github.com/BonChain/ritarena).
Both sides secretly pick up to two cards, then reveal together. This repository is the
**off-chain MVP**: a playable authoritative game server + web client. Solana settlement,
MagicBlock VRF and Private Ephemeral Rollups are **not connected yet** (see [Roadmap](#roadmap)).

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

## How to play

| Rule | Value |
| --- | --- |
| Starting HP (both) | 40 (max 40) |
| Starting hand | 5 cards, then 1 draw at the start of every turn (incl. turn 1) |
| Max hand size | 7 — a draw that would exceed it is skipped (shown in the UI) |
| Energy | 5 every turn, does not carry over |
| Cards per turn | 0, 1 or 2, total cost ≤ 5 |
| Selection | Simultaneous and hidden; revealed together once both are locked |
| Decks | Identical 20-card composition, separate independently shuffled copies |
| Draw (both ≤ 0 HP) | Recorded as `DRAW`, settled as a **human loss** (house rule) |

**Block only stops Attack damage.** All incoming Attack damage in a turn is summed into one
pool and the target's Block is subtracted once (`max(0, attack − block)`), so card order never
matters. Spell damage, Poison, and reflected damage ignore Block. Block expires at end of turn.

### Cards (deck-v1)

| Card | Type | Cost | Effect | In deck |
| --- | --- | --- | --- | --- |
| Quick Strike | Attack | 1 | 2 damage | 2 |
| Heavy Strike | Attack | 2 | 4 damage | 3 |
| Meteor Impact | Attack | 5 | 20 damage | 1 |
| Venom Strike | Attack | 3 | 1 damage + Poison (applies even if blocked) | 2 |
| Basic Shield | Defense | 1 | 3 Block | 2 |
| Fortify | Defense | 2 | 6 Block | 2 |
| Arcane Barrier | Defense | 3 | 10 Block | 1 |
| Divine Protection | Defense | 5 | 20 Block | 1 |
| Arcane Bolt | Spell | 3 | 5 Spell damage | 1 |
| Regeneration | Spell | 2 | Heal 2 at End phase, 3 turns | 1 |
| Disruption | Spell | 3 | Opponent discards 2 random cards (caster doesn't see which) | 1 |
| Unstoppable | Spell | 2 | Your Attack damage this turn is unblockable | 1 |
| Reflection | Spell | 3 | This turn, HP damage you take from cards is dealt back | 1 |
| Lifesteal | Spell | 2 | This turn + next, heal for HP damage your cards deal | 1 |

Values live in `server/src/engine/cards.ts` and `server/src/engine/rules.ts`.

### Resolution order (one turn)

1. **Start** — each side draws 1 (skipped if hand is 7 or deck empty), energy set to 5.
2. **Planning** — the AI locks its choice first (from its own view only); the human then locks or passes. Timer: 60 s, then auto-pass.
3. **Reveal + resolution** (both sides from the same snapshot):
   1. re-validate both selections · 2. consume cards & energy · 3. Block and flags (Unstoppable, Reflection, Lifesteal, Regeneration) ·
   4. random discard (Disruption) from the *remaining* hand — committed cards can't be invalidated ·
   5–7. shared Attack pool vs Block (unblockable if Unstoppable), apply Poison · 8. Spell damage ·
   9. Reflection, then Lifesteal (from actual HP damage) · 10. Regeneration · 11. Poison ticks · 12. expire Block/statuses · 13. outcome.
4. Both sides' committed effects always resolve, even if someone hits 0 HP mid-turn.

## Proposed defaults (spec left these open)

These are deliberate choices, centralised so the product owner can change them:

| Topic | Default | Where |
| --- | --- | --- |
| Turn-1 draw | Yes — turn 1 starts with 6 cards in hand | `engine.ts` `startPhase` |
| Deck size / list | 20 cards as above | `cards.ts` `DECK_COMPOSITION` |
| Empty deck | Draw skipped, no fatigue | `engine.ts` |
| Hand overflow | Draw skipped (card stays in deck), shown in UI | `engine.ts` |
| Poison | 1 dmg/tick, 3 End phases incl. the turn applied; reapply refreshes, never stacks | `rules.ts` |
| Durations | `duration` counts the current turn; decremented in End phase | `engine.ts` |
| Reflection | Reflects actual HP damage from Attack+Spell cards; ignores Block; cannot be re-reflected; doesn't reflect Poison | `engine.ts` |
| Lifesteal | Heals actual HP damage dealt by own Attack+Spell cards; not Poison/Reflect | `engine.ts` |
| Healing vs lethal | Healing cannot revive a player whose HP is ≤ 0 after damage | `engine.ts` `heal` |
| Turn limit | 30 turns; then higher HP wins, equal HP = DRAW | `rules.ts` |
| Timeout | Human auto-passes after 60 s | `rules.ts`, `session.ts` |
| Spell costs | Regeneration 2, Disruption 3, Unstoppable 2, Reflection 3, Lifesteal 2, Arcane Bolt 3 | `cards.ts` |
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
  src/session.ts           one match: commit locking, AI-first commit, timeouts
  src/index.ts             HTTP (serves web/dist) + WebSocket /ws
  tests/                   engine, privacy/randomness, session tests
web/                       React + Vite client (renders projections, submits actions)
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

- **The game server is fully trusted.** It sees both hands and both decks and decides the result. Nothing is verifiable by the player yet.
- Randomness is server-local CSPRNG, not VRF. There is no commitment to the seed, so the operator could in principle grind decks.
- Matches are in memory; a server restart loses them. No accounts, no wallet, no stakes.
- The AI is a simple heuristic (`heuristic-v1`) with small private-RNG tie-breaking; it's not tuned.
- Balance is untested: flat 5 energy means Meteor Impact is playable from turn 1.
- Timing side-channels are reduced (AI commits at turn start) but not formally analysed.

## Roadmap

1. **MagicBlock VRF + PER proof of concept** — verify per-identity private reads, private VRF consumption, and commit-back; commit to `hash(privateEntropy)` before requesting VRF to prevent grinding.
2. **Settlement** — integrate with the RitArena Anchor program's arena lifecycle (`create/enter/start/finalize_arena`, USDC escrow, fees) via an authenticated result; draws settle as human loss.
3. Persistence, wallet sign-in, and end-to-end browser tests.
4. Legal review of human-vs-house real-money play before enabling stakes.
