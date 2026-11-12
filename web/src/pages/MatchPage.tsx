import { useEffect, useRef, useState } from "react";
import type { PlayerView, TurnReportView } from "../../../server/src/engine/types";
import { BattleLog } from "../components/BattleLog";
import { CardBack, GameCard } from "../components/GameCard";
import { DeckPile, EnergyCrystals, HpOrb, Portrait, StatusChips } from "../components/Hud";
import { LockIcon } from "../components/icons";
import { RevealOverlay } from "../components/RevealOverlay";
import { usdc, type StakeTier } from "../data/mockVault";
import type { ChainStatus } from "../../../server/src/chain/types";
import type { ServerConfig } from "../../../server/src/protocol";
import { ChainPanel, ChainSettlement, type WalletState } from "../components/ChainParts";

interface Props {
  view: PlayerView;
  deadline: number | null;
  tier: StakeTier | null;
  chain: ChainStatus | null;
  config: ServerConfig | null;
  wallet: WalletState;
  onCommit: (turn: number, cards: string[]) => void;
  onNewMatch: () => void;
  onBack: () => void;
}

function useCountdown(deadline: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function MatchPage({ view, deadline, tier, chain, config, wallet, onCommit, onNewMatch, onBack }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reports, setReports] = useState<TurnReportView[]>([]);
  const [reveal, setReveal] = useState<TurnReportView | null>(null);
  const seenTurn = useRef<{ matchId: string; turn: number } | null>(null);
  const secondsLeft = useCountdown(deadline);

  const locked = view.self.committed !== null;
  const finished = view.phase === "FINISHED";

  // Track revealed turns: show the reveal overlay for new ones, not on first load/resume.
  useEffect(() => {
    const last = view.lastTurn;
    if (seenTurn.current?.matchId !== view.matchId) {
      seenTurn.current = { matchId: view.matchId, turn: last?.turn ?? 0 };
      setReports(last ? [last] : []);
      setReveal(null);
      return;
    }
    if (last && last.turn > seenTurn.current.turn) {
      seenTurn.current.turn = last.turn;
      setReports((r) => [...r, last]);
      setReveal(last);
    }
  }, [view.matchId, view.lastTurn]);

  useEffect(() => setSelected([]), [view.turn, view.matchId]);

  const handById = new Map(view.self.hand.map((c) => [c.uid, c]));
  const spent = selected.reduce((s, uid) => s + (handById.get(uid)?.def.cost ?? 0), 0);
  const remaining = view.self.energy - spent;
  const laneCards = (view.self.committed ?? selected).map((uid) => handById.get(uid)).filter(Boolean) as typeof view.self.hand;
  const handCards = view.self.hand.filter((c) => !laneCards.includes(c));

  const canAdd = (uid: string, cost: number) => selected.length < view.maxCardsPerTurn && cost <= remaining && !selected.includes(uid);
  const toggle = (uid: string) => setSelected((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]));

  const drawNote =
    view.self.lastDraw === "HAND_FULL" ? "Hand full (7) — draw skipped" : view.self.lastDraw === "DECK_EMPTY" ? "Deck empty — draw skipped" : null;

  const mid = (handCards.length - 1) / 2;

  return (
    <main className="match">
      <div className="match__bar">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          ← Vault
        </button>
        <span className="turn-pill">
          Turn <strong>{view.turn}</strong>/{view.maxTurns}
        </span>
        {!finished && !locked && secondsLeft !== null && (
          <span className={`timer ${secondsLeft <= 10 ? "timer--low" : ""}`}>⏱ {secondsLeft}s</span>
        )}
        {chain ? (
          <span className="stake-pill stake-pill--chain" title="Staked on Solana devnet">
            Arena #{chain.arenaId} · {usdc(chain.stakeMicro / 1_000_000, 0)} USDC staked
          </span>
        ) : (
          tier && (
            <span className="stake-pill" title="Practice — no funds move">
              Practice · {tier.name} {usdc(tier.stake, 0)} USDC
            </span>
          )
        )}
      </div>

      <div className="match__layout">
        <div className="board">
          {/* Opponent */}
          <section className="seat seat--ai">
            <Portrait side="AI" />
            <div className="seat__info">
              <span className="seat__name">Arena AI</span>
              <StatusChips statuses={view.opponent.statuses} />
            </div>
            <HpOrb hp={view.opponent.hp} max={view.maxHp} />
            <div className="opp-hand" aria-label={`AI holds ${view.opponent.handCount} cards`}>
              {Array.from({ length: view.opponent.handCount }, (_, i) => {
                const m = (view.opponent.handCount - 1) / 2;
                return <CardBack key={i} size="xs" style={{ transform: `rotate(${(i - m) * -5}deg) translateY(${Math.abs(i - m) * 3}px)` }} />;
              })}
            </div>
            <DeckPile count={view.opponent.deckRemaining} label="Deck" threshold={view.deckOutThreshold} />
          </section>

          {/* Arena */}
          <section className="arena" aria-label="Arena">
            <div className="lane lane--ai">
              {finished ? null : view.opponent.committed ? (
                <div className="seal">
                  <LockIcon /> AI locked in
                </div>
              ) : (
                <div className="seal seal--wait">AI is thinking…</div>
              )}
            </div>
            <div className="arena__divider">
              <span>VS</span>
            </div>
            <div className="lane lane--you">
              {laneCards.length === 0 ? (
                <div className="lane__hint">{locked ? "You passed this turn" : "Select up to 2 cards from your hand"}</div>
              ) : (
                laneCards.map((c) => (
                  <GameCard
                    key={c.uid}
                    def={c.def}
                    size="md"
                    className="in-lane"
                    onClick={locked || finished ? undefined : () => toggle(c.uid)}
                  />
                ))
              )}
              {locked && laneCards.length > 0 && (
                <span className="lane__tag">
                  <LockIcon /> Hidden from AI until reveal
                </span>
              )}
            </div>
          </section>

          {/* Player */}
          <section className="seat seat--you">
            <Portrait side="HUMAN" />
            <div className="seat__info">
              <span className="seat__name">You</span>
              <StatusChips statuses={view.self.statuses} />
              {drawNote && <span className="note">{drawNote}</span>}
              {view.self.deckRemaining <= view.deckOutThreshold + 2 && (
                <span className="note note--danger">
                  Deck low: {view.self.deckRemaining} left — {view.deckOutThreshold} or fewer at the End phase and you lose
                </span>
              )}
            </div>
            <HpOrb hp={view.self.hp} max={view.maxHp} />
            <EnergyCrystals total={view.self.energy} available={locked ? view.self.energy - (laneCards.reduce((s, c) => s + c.def.cost, 0)) : remaining} max={view.energyPerTurn} />
            <DeckPile count={view.self.deckRemaining} label="Deck" threshold={view.deckOutThreshold} />
          </section>

          <section className="hand" aria-label="Your hand">
            {handCards.length === 0 && <p className="muted">No cards in hand.</p>}
            {handCards.map((c, i) => (
              <GameCard
                key={c.uid}
                def={c.def}
                size="lg"
                disabled={locked || finished || !canAdd(c.uid, c.def.cost)}
                onClick={() => toggle(c.uid)}
                className="in-hand"
                style={{ ["--rot" as string]: `${(i - mid) * 4}deg`, ["--drop" as string]: `${Math.abs(i - mid) * 8}px` }}
              />
            ))}
          </section>

          {!finished && (
            <div className="actions">
              {locked ? (
                <span className="muted">Locked in — revealing…</span>
              ) : (
                <>
                  <span className="actions__summary">
                    {selected.length}/{view.maxCardsPerTurn} cards · {spent} energy
                  </span>
                  <button className="btn btn--ghost" onClick={() => onCommit(view.turn, [])}>
                    Pass
                  </button>
                  <button className="btn btn--gold btn--lg" disabled={selected.length === 0} onClick={() => onCommit(view.turn, selected)}>
                    Lock in
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="side-col">
          {chain && <ChainPanel status={chain} />}
          <BattleLog reports={reports} />
        </div>
      </div>

      {reveal && <RevealOverlay report={reveal} onClose={() => setReveal(null)} />}
      {finished && !reveal && (
        <GameOver
          view={view}
          tier={tier}
          settlement={chain && config ? <ChainSettlement status={chain} w={wallet} config={config} /> : null}
          onNewMatch={onNewMatch}
          onBack={onBack}
        />
      )}
    </main>
  );
}

function GameOver({
  view,
  tier,
  settlement,
  onNewMatch,
  onBack,
}: {
  view: PlayerView;
  tier: StakeTier | null;
  settlement: React.ReactNode;
  onNewMatch: () => void;
  onBack: () => void;
}) {
  const win = view.settlement === "HUMAN_WIN";
  const title = view.outcome === "DRAW" ? "Draw" : win ? "Victory" : "Defeat";
  const why = (who: string, reasons: string[]) =>
    reasons.map((r) => (r === "HP" ? `${who} fell to 0 HP` : `${who} ran out of deck (${view.deckOutThreshold} or fewer cards)`));
  const reasons =
    view.endReason === "TURN_LIMIT"
      ? ["Turn limit reached — higher HP wins."]
      : view.lossReasons
        ? [...why("You", view.lossReasons.HUMAN), ...why("The AI", view.lossReasons.AI)]
        : [];
  const reason = reasons.length ? reasons.join(" · ") + (view.outcome === "DRAW" ? ". Draws go to the house." : ".") : null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="go-title">
      <div className={`gameover ${win ? "is-win" : "is-loss"}`}>
        <h2 id="go-title">{title}</h2>
        <p>
          You {Math.max(0, view.self.hp)} HP · AI {Math.max(0, view.opponent.hp)} HP
        </p>
        {reason && <p className="muted">{reason}</p>}
        {settlement}
        {!settlement && tier && (
          <p className="gameover__payout">
            {win ? `Mock payout: ${usdc(tier.stake * tier.payoutMultiplier)} USDC` : `Mock stake of ${usdc(tier.stake)} USDC kept by the vault`}
          </p>
        )}
        <div className="gameover__actions">
          <button className="btn btn--ghost" onClick={onBack}>
            Back to vault
          </button>
          <button className="btn btn--gold btn--lg" onClick={onNewMatch}>
            Play again
          </button>
        </div>
      </div>
    </div>
  );
}
