# RitArena Card Game --- Agent Implementation Specification

**Document type:** Build specification for an AI coding agent\
**Project:** RitArena\
**Status:** Initial gameplay specification; implementation details
marked as proposed must be validated against the existing repository\
**Last updated:** 2026-11-12

------------------------------------------------------------------------

## 1. Objective

Implement a turn-based, human-versus-AI card battle for RitArena.

The game is simultaneous-selection: both sides secretly choose up to two
cards, then reveal their choices at the same time. Each side starts with
40 HP. Every card costs energy. The game must preserve **strict hidden
information**: each side can see its own hand, but never the opponent's
hand or either deck's remaining order.

The implementation must integrate with the existing RitArena repository
and its existing Solana/Anchor, TypeScript SDK, Next.js, and game-server
architecture where practical. Do not assume that the existing on-chain
program already supports this exact game mode, private card state, or
the proposed vault settlement model. Inspect the current code and
document the required changes before modifying core contracts.

## 2. Confirmed gameplay rules

  Rule                                                                        Value
  ------------------------------- -------------------------------------------------
  Human starting HP                                                              40
  AI starting HP                                                                 40
  Starting hand size                                                        5 cards
  Maximum hand size                                                         7 cards
  Energy gained each turn                                                         5
  Cards drawn each turn                                                           1
  Maximum cards played per turn                                                   2
  Card types                                                 Attack, Defense, Spell
  Energy cost                                         Every card has an energy cost
  Card selection                    Simultaneous and hidden until both sides commit
  Deck composition                             Identical composition for both sides
  Deck instances                            Separate, independently shuffled copies
  Hidden information                                                         Strict

### 2.1 Turn structure

Implement the following phases in this order:

1.  **Start phase**
    -   At the start of each turn, each player draws one card.
    -   Each player receives 5 energy for the turn.
    -   Resolve effects explicitly defined as start-of-turn effects.
    -   Do not allow the hand to exceed 7 cards. If a draw would exceed
        the maximum, apply the overflow rule in section 8.1.
2.  **Planning phase**
    -   Each player privately selects zero, one, or two cards from their
        own hand.
    -   The total energy cost of selected cards must not exceed 5.
    -   A player may pass by selecting zero cards.
    -   A selected card must be in that player's hand and cannot be
        selected twice.
    -   Card choices must remain hidden until both players have
        committed valid selections.
    -   The server/game engine must not reveal one side's selection to
        the other side before both commits are locked.
3.  **Reveal phase**
    -   Reveal both players' committed cards together.
    -   Once both commitments are locked, neither player can change
        their selection.
    -   If a player disconnects or fails to commit, use the match
        timeout/forfeit policy; do not silently expose the other
        player's selection.
4.  **Resolution phase**
    -   Resolve card effects using the deterministic ordering and damage
        rules in sections 4--6.
    -   Both players' already-committed cards must resolve even if one
        player reaches 0 HP earlier in the resolution, unless an
        explicit card rule says otherwise.
5.  **End phase**
    -   Resolve end-of-turn status effects, including Poison.
    -   Remove temporary Block and effects whose duration expires this
        turn.
    -   Check the final HP and match outcome.
    -   If the match continues, advance to the next turn.

## 3. Card data model

Every card must have at least:

-   `id`: stable unique card identifier.
-   `name`: display name.
-   `type`: `ATTACK`, `DEFENSE`, or `SPELL`.
-   `cost`: positive integer energy cost.
-   `description`: player-facing rules text.
-   `effect`: structured effect definition interpreted by the game
    engine.

Do not implement card effects by evaluating arbitrary JavaScript, Rust,
or user-provided code. Use a typed effect schema and a deterministic
effect resolver.

Suggested conceptual model:

``` ts
type CardType = "ATTACK" | "DEFENSE" | "SPELL";

interface CardDefinition {
  id: string;
  name: string;
  type: CardType;
  cost: number;
  description: string;
  effect: CardEffect;
}

type CardEffect =
  | { kind: "DAMAGE"; amount: number }
  | { kind: "DAMAGE_AND_POISON"; amount: number }
  | { kind: "GAIN_BLOCK"; amount: number }
  | { kind: "HEAL_OVER_TIME"; amountPerTurn: number; duration: number }
  | { kind: "DISCARD_RANDOM"; count: number }
  | { kind: "UNBLOCKABLE_ATTACKS"; duration: number }
  | { kind: "REFLECT_DAMAGE"; duration: number }
  | { kind: "LIFESTEAL"; duration: number };
```

This is an initial schema, not a requirement to use these exact names if
the repository already has a suitable typed card/effect model.

## 4. Initial example cards

These examples define the intended mechanics. They are not a complete
balanced deck list.

### 4.1 Attack cards

  Example name      Cost Effect
  --------------- ------ ---------------------------------------
  Quick Strike         1 Deal 2 Attack damage
  Heavy Strike         2 Deal 4 Attack damage
  Meteor Impact        5 Deal 20 Attack damage
  Venom Strike         3 Deal 1 Attack damage and apply Poison

**Poison application:** Venom Strike applies Poison when its effect
resolves, even if its 1 point of Attack damage is fully absorbed by
Block. Poison does not stack. The exact duration/refresh rule is not yet
finalized; implement it as configurable and do not hard-code an assumed
permanent duration without documenting that decision.

### 4.2 Defense cards

Defense cards generate a temporary Block pool for their owner.

  Example name          Cost Effect
  ------------------- ------ -------------------------
  Basic Shield             1 Gain 3 Block this turn
  Fortify                  2 Gain 6 Block this turn
  Arcane Barrier           3 Gain 10 Block this turn
  Divine Protection        5 Gain 20 Block this turn

Values are prototype examples and must be configurable for balance
testing.

### 4.3 Spell cards

Spell cards provide utility, buffs, debuffs, healing, or direct damage.
Every Spell costs energy.

Examples:

-   Regeneration: gain 2 HP at each end phase for a defined duration.
-   Disruption: discard two random cards from the opponent's hand.
-   Unstoppable: the caster's Attack damage cannot be blocked for the
    specified duration/turn.
-   Reflection: reflect damage received for the specified duration/turn.
-   Lifesteal: gain health based on qualifying damage dealt for the next
    two turns.

Because hidden information is strict, a discard effect must not expose
the opponent's hand to the caster. For the initial implementation,
discard randomly from the opponent's hand. If fewer than the requested
number of cards are available, discard all available cards.

All durations, trigger timings, and interactions must be explicit in
card definitions. Avoid ambiguous text such as "this turn" without
defining whether it expires before or after the End phase.

## 5. Energy and card-play validation

At each Start phase:

-   Set the player's energy to 5 for that turn.
-   Energy does not carry over unless a future card explicitly grants
    carryover.
-   A card can only be played if its cost is affordable.
-   The sum of the costs of both selected cards must be 5 or less.
-   A player may play fewer than two cards.
-   A player cannot play more than two cards.
-   A card is removed from the player's hand when the committed
    selection is accepted/locked, or at a clearly defined atomic point
    during reveal/resolution. Prevent duplicate spending and duplicate
    card use.
-   Invalid submissions must not consume cards or energy.
-   The server/game engine is authoritative for validation; never trust
    client-supplied cost, card type, effect, or card ownership.

## 6. Damage and Block resolution

### 6.1 Attack-only Block

Block absorbs damage from **Attack cards only**.

Block does not absorb:

-   Direct damage from Spell cards.
-   Poison damage-over-time ticks.
-   Other non-Attack/status damage sources.

Block is temporary and expires at the end of the current turn.

### 6.2 Shared Attack damage pool

For each target player, sum all incoming Attack-card damage that
qualifies for Block. Apply the target's Block once to that combined
pool.

``` text
attackDamageAfterBlock = max(0, totalIncomingAttackDamage - targetBlock)
```

The remaining Attack damage reduces HP.

Example:

``` text
Incoming Attack card damage: 4 + 8 = 12
Target Block:                 6
Attack damage to HP:          6
```

Do not allocate Block to individual Attack cards in card order or
prioritize the largest Attack. The shared pool makes the result
independent of Attack-card ordering.

### 6.3 Spell and status damage

Resolve Spell damage separately. It bypasses Block and reduces HP
directly.

Poison ticks also bypass Block and reduce HP directly.

Example:

``` text
Incoming Attack damage: 10
Incoming Spell damage:   5
Target Block:            6
Poison tick:             1

Attack HP damage:        max(0, 10 - 6) = 4
Spell HP damage:         5
Poison HP damage:        1
Total HP damage:         10
```

### 6.4 Unblockable Attack effect

If an effect makes Attack damage unblockable, that Attack damage must be
excluded from the Block-eligible portion of the shared pool and applied
directly to HP. The engine must track the source/flags of each damage
contribution so that unblockable damage is not accidentally reduced by
Block.

### 6.5 Damage records

Keep source-aware damage records. Do not only store one combined number
if other mechanics need to know the source or actual HP damage.

At minimum, track:

-   Source card and source player.
-   Target player.
-   Damage category (`ATTACK`, `SPELL`, `STATUS`).
-   Raw damage.
-   Whether the Attack damage is unblockable.
-   Amount absorbed by Block.
-   Actual HP damage dealt.

This is required for correct Lifesteal, Reflection, triggers, logging,
and replay.

## 7. Effect timing and simultaneous resolution

Both sides' committed cards are revealed simultaneously. Resolve effects
from a consistent pre-resolution snapshot.

Recommended initial sub-phases:

1.  Validate both committed selections against the same pre-resolution
    state.
2.  Consume the selected cards and their energy costs.
3.  Apply immediate defensive setup effects, including Block generation
    and temporary defensive/offensive flags.
4.  Apply non-damage utility effects whose timing is defined as
    pre-damage (for example, random discard). Do not allow one player's
    effect to retroactively invalidate the other player's
    already-committed cards.
5.  Calculate both sides' Attack damage pools.
6.  Apply Attack-only Block to each pool.
7.  Apply unblockable Attack damage.
8.  Apply Spell damage, which bypasses Block.
9.  Apply damage-triggered effects, including Lifesteal and Reflection,
    using actual HP damage and explicit trigger rules.
10. Apply healing effects at their defined timing.
11. Apply end-of-turn status effects, including Poison.
12. Expire temporary effects and Block.
13. Determine the match result.

If an effect's timing is not covered above, add an explicit timing field
or resolver phase rather than relying on card ordering.

**Simultaneous survival rule:** one player's HP reaching zero must not
cancel the other player's already-committed effects. Resolve both sides'
committed actions and end-of-turn effects before determining the result.

## 8. Hidden information and state visibility

Strict hidden information is mandatory.

### 8.1 Visibility matrix

  --------------------------------------------------------------------------
  Data                    Human player                 AI    Public observer
  ----------------- ------------------ ------------------ ------------------
  Public match                     Yes                Yes                Yes
  state (HP, turn,                                        
  public board)                                           

  Human hand                       Yes                 No                 No

  AI hand                           No                Yes                 No

  Human deck order                  No                 No                 No

  AI deck order                     No                 No                 No

  Own discard pile                 Yes                Yes    Depends on game
                                                          rules; recommended
                                                              public only if
                                                          explicitly exposed

  Opponent discard       Only if rules      Only if rules      Only if rules
  pile                       expose it          expose it          expose it

  Revealed/played                  Yes                Yes                Yes
  cards                                                   

  Private shuffle                   No                 No                 No
  entropy                                                 

  Final                            Yes                Yes                Yes
  winner/result                                           
  --------------------------------------------------------------------------

A player must not receive opponent hand IDs through API payloads,
websocket messages, logs, error messages, transaction/event data, or
client-side state.

**Hand overflow rule (proposed):** if the player already has 7 cards
when the Start phase draw occurs, the draw is skipped and no card is
added. Do not silently discard a card. Make this behavior visible in the
UI.

### 8.2 Authoritative game engine

-   The browser submits actions; it does not decide game outcomes.
-   The game engine validates turn, hand ownership, energy, card count,
    and card effects.
-   The human and AI must receive separate authorized state projections.
-   AI input must contain public state plus the AI's own hand only.
-   Do not pass the complete private match state to a general AI prompt
    or external model.
-   The AI must not be able to inspect the human hand or either deck
    order.
-   Avoid information leakage through error messages and timing
    differences where practical.

## 9. Decks, VRF, and MagicBlock privacy architecture

### 9.1 Separate identical decks

-   Define one canonical, versioned deck composition.
-   Create two independent instances for each match: one for the human
    and one for the AI.
-   Shuffle each instance independently.
-   Store each permutation and draw pointer only in confidential game
    state.
-   Each draw advances only that player's draw pointer.
-   Never accept a card ID from the browser as the result of a draw.

### 9.2 VRF

Use MagicBlock Solana VRF as a source of verifiable randomness, bound to
a unique match ID and the selected deck/rules version.

Important: a public VRF output is not secret. If a public output is used
directly as the deterministic shuffle seed, anyone can reproduce the
deck order. Do not use a publicly reproducible seed as the sole source
for a strict-hidden-information shuffle.

Proposed approach:

1.  Lock match participation and configuration before requesting
    randomness.
2.  Request and verify the VRF result using the supported MagicBlock
    integration.
3.  Deliver the verified result into the confidential execution
    boundary.
4.  Combine it with private entropy generated inside the trusted
    execution environment.
5.  Derive independent, domain-separated seeds for the human and AI
    decks.
6.  Shuffle each canonical deck with a cryptographically sound unbiased
    shuffle (for example, Fisher--Yates using rejection sampling for
    bounded random values).
7.  Keep seeds, permutations, and draw pointers private.

Conceptual derivation only:

``` text
humanSeed = KDF(
  privateEntropy,
  verifiedVrfOutput,
  matchId,
  "RITARENA_HUMAN_DECK_V1"
)

aiSeed = KDF(
  privateEntropy,
  verifiedVrfOutput,
  matchId,
  "RITARENA_AI_DECK_V1"
)
```

Do not treat this pseudocode as an approved cryptographic
implementation. Select reviewed primitives and follow MagicBlock's
current VRF integration documentation.

### 9.3 PER

Use MagicBlock Private Ephemeral Rollups (PER) as the intended
confidential execution/state layer, subject to a proof-of-concept
validating the actual access-control model.

Desired permissions:

  -----------------------------------------------------------------------
  Identity                            Required access
  ----------------------------------- -----------------------------------
  Human wallet/session                Public state + human hand

  AI identity                         Public state + AI hand

  Authoritative game engine           Both hands and both decks, only
                                      inside the trusted execution
                                      boundary

  Public observer                     Public state only
  -----------------------------------------------------------------------

The AI execution environment must not inherit unrestricted access to the
complete private state merely because it runs game logic.

Before implementing the full game, verify:

-   Whether PER can enforce the required per-identity read permissions.
-   Whether the VRF result can be consumed privately in the required
    execution flow.
-   Whether private accounts are protected across RPC, indexers, logs,
    events, transaction responses, and backend services.
-   How state is committed back to Solana and how the final result is
    verified.
-   Timeout, failure, restart, and recovery behavior.

Do not invent MagicBlock SDK methods or callback APIs. Inspect the
current official SDK/docs and repository dependencies. If the exact flow
is unsupported or unclear, document the limitation and propose a tested
alternative before proceeding.

## 10. Public and private match state

Suggested conceptual separation:

``` ts
interface PublicMatchState {
  matchId: string;
  humanPlayer: string;
  aiVersion: string;
  rulesVersion: string;
  deckVersion: string;
  currentTurn: number;
  currentPhase: string;
  humanHp: number;
  aiHp: number;
  humanPublicStatuses: PublicStatus[];
  aiPublicStatuses: PublicStatus[];
  publicBoard: PublicCard[];
  status: "CREATED" | "ACTIVE" | "FINISHED" | "CANCELLED";
  winner?: "HUMAN" | "AI" | "DRAW";
}

interface PrivateDeckState {
  cards: string[];       // private shuffled permutation
  drawIndex: number;     // private
}

interface PrivatePlayerState {
  hand: string[];        // private
  energy: number;
  block: number;
  privateStatuses: PrivateStatus[];
}
```

Adapt the data model to the existing implementation. Do not put private
fields into a public struct/account and rely only on the frontend to
hide them.

## 11. Match outcome and draw policy

**Product rule selected for this specification:** a draw counts as a
loss for the human player. The AI is treated as the house opponent.

Therefore:

-   Human HP \> 0 and AI HP \<= 0: human wins.
-   Human HP \<= 0 and AI HP \> 0: AI wins; human loses.
-   Both HP \<= 0 after all committed effects and end-phase effects:
    result is a draw, but settlement treats it as an AI/house win and a
    human loss.
-   If neither HP reaches zero: continue.

Represent the internal outcome as `DRAW` if useful for accurate game
records, but map it to the human-loss settlement outcome. Do not
mislabel the game-state fact as "AI survived"; it is a draw adjudicated
in the house's favor.

This is an explicit interpretation of "draw counts as player loss." If
the product owner intended a different adjudication, change this rule
before implementation.

## 12. AI behavior

-   AI uses the same card definitions, energy limit, maximum cards per
    turn, and game rules as the human.
-   AI receives only public state and its own hand.
-   AI chooses zero, one, or two cards within the 5-energy budget.
-   AI decisions must be deterministic for a fixed AI version and input,
    or have separately specified private randomness.
-   Snapshot the AI version for each match so a live deployment cannot
    silently change the behavior of an ongoing match.
-   Never expose hidden human state to the AI model or its prompt.
-   Log the AI's input projection and chosen action securely without
    logging the human's private hand.

## 13. Security, fairness, and anti-cheat requirements

-   Validate every action on the authoritative server/game engine.
-   Use unique match IDs and bind randomness to match ID, deck version,
    and rules version.
-   Prevent replay of old actions and duplicate card submissions.
-   Lock both players' choices before revealing either choice.
-   Prevent cancellation/restart after a player learns unfavorable
    randomness, except through a defined neutral failure/refund path.
-   Use atomic state transitions for card consumption, energy
    consumption, draw-pointer advancement, and HP/status changes.
-   Keep private card state out of public events and logs.
-   Do not assume a VRF proves correct game execution; it proves
    properties of randomness, not correctness of the entire game.
-   Do not assume a Merkle commitment alone proves the game result is
    correct.
-   Document the trust assumptions of the game server, TEE/PER operator,
    AI runtime, and settlement authority.

## 14. Solana settlement integration

Inspect the existing RitArena Anchor program and identify the current
match lifecycle and settlement interfaces before implementation.

The card-game engine should produce a final, authenticated match result
that the existing or modified on-chain program can validate under the
project's chosen trust model.

Do not implement or assume new vault economics in this task unless the
existing repository requires it. Preserve existing USDC escrow, prize,
creator-fee, and protocol-fee behavior where applicable.

If a trusted game server/oracle is used for the MVP, explicitly document
that the result depends on that authority. Treat stronger independent
verification as a separate milestone.

## 15. Suggested implementation milestones

### Milestone 1 --- Repository audit

-   Inspect the Anchor program, TypeScript SDK, Next.js app, and game
    server.
-   Identify existing match lifecycle, state model, wallet/USDC
    handling, and oracle/result verification.
-   Write a short gap analysis before changing architecture.
-   Identify where private execution and MagicBlock integrations belong.

### Milestone 2 --- Deterministic game engine

-   Implement typed card definitions and effect resolver.
-   Implement 40 HP, 5 starting cards, 7-card maximum, 5 energy per
    turn, one draw per turn, and maximum two cards played.
-   Implement Attack-only Block and shared Attack damage pool.
-   Implement Spell damage bypassing Block.
-   Add unit tests for damage and effect interactions.

### Milestone 3 --- Simultaneous selection

-   Implement private action selection and commit locking.
-   Ensure neither side sees the opponent's selected cards before both
    commit.
-   Add timeout and disconnect handling.
-   Test invalid card IDs, duplicate cards, over-budget selections, and
    over-limit selections.

### Milestone 4 --- Strict hidden information

-   Split public and private state.
-   Create separate human/AI state projections.
-   Verify API, websocket, logs, events, and error responses do not leak
    hidden data.
-   Test that the AI cannot access the human hand or either deck order.

### Milestone 5 --- MagicBlock VRF + PER proof of concept

-   Build a minimal integration test for VRF request and verification.
-   Test private consumption of VRF output.
-   Test two independently shuffled private deck instances.
-   Test identity-specific hand access.
-   Verify that an unauthorized observer cannot reconstruct or read deck
    order.
-   Document limitations before full integration.

### Milestone 6 --- Match completion and settlement

-   Resolve win, loss, and draw adjudication.
-   Submit authenticated final result through the existing settlement
    flow or a documented contract extension.
-   Test successful settlement, timeout, cancellation, and
    failure/refund paths.

### Milestone 7 --- UI and end-to-end tests

-   Display HP, energy, hand, public board, turn, and Block.
-   Allow selecting up to two cards within the energy budget.
-   Show the player's own hand only.
-   Show both selections after reveal.
-   Display damage breakdown: Attack damage, Block absorbed, Spell
    damage, Poison damage, and final HP.
-   Test complete human-versus-AI matches.

## 16. Required test cases

At minimum, add automated tests for:

### Setup and turn rules

-   Both players start at 40 HP.
-   Both start with 5 cards.
-   Hand never exceeds 7 cards.
-   Each turn grants 5 energy and one draw, subject to hand overflow.
-   A player cannot play more than two cards.
-   A player cannot spend more than 5 energy.
-   A player may pass.

### Damage and defense

-   4 + 8 Attack damage against 6 Block causes 6 HP damage.
-   10 Attack damage against 15 Block causes 0 HP damage.
-   10 Spell damage against 6 Block causes 10 HP damage.
-   10 Attack + 5 Spell against 6 Block causes 9 HP damage.
-   Poison applies even if its associated Attack damage is fully
    blocked.
-   Poison tick bypasses Block.
-   Unused Block expires at the end of the turn.
-   Unblockable Attack damage bypasses Block.
-   Lifesteal uses actual HP damage, not raw damage or Block-absorbed
    damage.
-   Reflection follows its documented source and timing rules.
-   Healing cannot raise HP above 40.

### Simultaneous actions and outcomes

-   Both players' selections remain hidden until both commit.
-   One player's lethal damage does not cancel the opponent's
    already-committed effects.
-   Both players reaching 0 HP produces internal `DRAW` and human-loss
    settlement adjudication.
-   A single surviving player is correctly declared the winner.
-   Invalid actions do not consume cards or energy.

### Privacy and randomness

-   Human cannot fetch AI hand.
-   AI cannot fetch human hand.
-   Neither side can fetch either deck order.
-   Public observer cannot fetch private hands or deck order.
-   Public VRF output alone does not reveal the deck order.
-   Separate deck seeds produce independently shuffled deck instances.
-   Shuffle implementation avoids modulo bias.
-   Randomness is bound to a unique match ID and versioned
    configuration.

## 17. Deliverables expected from the coding agent

1.  Repository audit and gap analysis.
2.  Updated game-engine implementation.
3.  Typed card definitions and initial example cards.
4.  Simultaneous action-selection and reveal flow.
5.  Attack-only Block and shared Attack damage pool.
6.  Strict public/private state separation.
7.  AI input isolation.
8.  MagicBlock VRF/PER proof-of-concept, or a documented blocker if the
    exact privacy flow is not supported.
9.  Unit, integration, privacy, and end-to-end tests.
10. Updated README/docs describing setup, game rules, architecture,
    trust assumptions, and known limitations.
11. A list of files changed, commands run, tests passed/failed, and
    unresolved risks.

## 18. Agent working instructions

-   First inspect the repository and report the existing architecture.
    Do not immediately rewrite the project.
-   Preserve existing conventions and working features.
-   Make small, reviewable changes in milestones.
-   Do not fabricate MagicBlock API methods or claim a privacy guarantee
    without an integration test or authoritative documentation.
-   Do not weaken strict hidden information to make the MVP easier
    without asking.
-   Do not silently invent card timings, poison duration, or other
    unresolved gameplay rules. Make them configurable and report the
    proposed default.
-   Keep gameplay rules deterministic and testable.
-   At the end of each milestone, report changed files, tests, results,
    and remaining blockers.
-   Ask the project owner before making irreversible changes to on-chain
    programs, deployed accounts, or settlement behavior.
