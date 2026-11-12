import { useEffect, useMemo, useState } from "react";
import type { CardDefinition, PlayerView } from "../../server/src/engine/types";
import { Card, CardBack } from "./components/Card";
import { HpBar, StatusChips, drawNotice } from "./components/PlayerPanel";
import { TurnSummary } from "./components/TurnSummary";
import { useGame } from "./lib/useGame";

export function App() {
  const game = useGame();

  useEffect(() => {
    if (!game.error) return;
    const t = setTimeout(game.clearError, 4000);
    return () => clearTimeout(t);
  }, [game.error]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">◆</span> RitArena <span className="brand__sub">Card Battle</span>
        </div>
        <span className={`conn conn--${game.connection}`}>{game.connection === "open" ? "Connected" : game.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
      </header>

      {game.error && (
        <div className="toast" role="alert" onClick={game.clearError}>
          {game.error}
        </div>
      )}

      {!game.ready ? (
        <main className="center muted">Connecting to the arena…</main>
      ) : game.view ? (
        <Match view={game.view} deadline={game.deadline} onCommit={game.commit} onNewMatch={game.newMatch} />
      ) : (
        <Lobby catalog={game.catalog} onStart={game.newMatch} />
      )}
    </div>
  );
}

function Lobby({ catalog, onStart }: { catalog: CardDefinition[]; onStart: () => void }) {
  return (
    <main className="lobby">
      <section className="lobby__hero">
        <h1>Human vs AI</h1>
        <p>
          40 HP each · 5 energy every turn · play up to 2 cards · both sides choose in secret and reveal together. Block only stops Attack
          damage. A draw counts as a loss.
        </p>
        <button className="btn btn--primary btn--lg" onClick={onStart}>
          Start match
        </button>
      </section>
      <section>
        <h2 className="section-title">Cards in the deck</h2>
        <div className="catalog">
          {catalog.map((def) => (
            <Card key={def.id} def={def} />
          ))}
        </div>
      </section>
    </main>
  );
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

function Match({
  view,
  deadline,
  onCommit,
  onNewMatch,
}: {
  view: PlayerView;
  deadline: number | null;
  onCommit: (turn: number, cards: string[]) => void;
  onNewMatch: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const secondsLeft = useCountdown(deadline);
  const locked = view.self.committed !== null;
  const finished = view.phase === "FINISHED";

  // Reset selection when a new turn starts.
  useEffect(() => setSelected([]), [view.turn, view.matchId]);

  const costOf = (uids: string[]) => uids.reduce((s, uid) => s + (view.self.hand.find((c) => c.uid === uid)?.def.cost ?? 0), 0);
  const spent = costOf(selected);
  const remaining = view.self.energy - spent;

  const toggle = (uid: string) =>
    setSelected((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]));

  const canAdd = (uid: string, cost: number) =>
    selected.includes(uid) || (selected.length < view.maxCardsPerTurn && cost <= remaining);

  const notices = useMemo(
    () => [drawNotice(view.self.lastDraw, "You"), drawNotice(view.opponent.lastDraw, "AI")].filter(Boolean) as string[],
    [view.self.lastDraw, view.opponent.lastDraw],
  );

  return (
    <main className="match">
      <div className="turnbar">
        <span>
          Turn <strong>{view.turn}</strong> / {view.maxTurns}
        </span>
        {!finished && secondsLeft !== null && !locked && (
          <span className={`timer ${secondsLeft <= 10 ? "timer--low" : ""}`}>{secondsLeft}s · auto-pass at 0</span>
        )}
        <button className="btn btn--ghost" onClick={onNewMatch}>
          New match
        </button>
      </div>

      <section className="player player--opponent">
        <div className="player__head">
          <div className="avatar avatar--ai">AI</div>
          <div className="player__meta">
            <HpBar hp={view.opponent.hp} max={view.maxHp} />
            <StatusChips statuses={view.opponent.statuses} />
          </div>
          <div className="player__counts">
            <span>Deck {view.opponent.deckRemaining}</span>
            <span>Discard {view.opponent.discardCount}</span>
            {!finished && <span className={`badge ${view.opponent.committed ? "badge--ok" : ""}`}>{view.opponent.committed ? "Locked in" : "Thinking…"}</span>}
          </div>
        </div>
        <CardBack count={view.opponent.handCount} />
      </section>

      <TurnSummary report={view.lastTurn} />

      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n) => (
            <span key={n} className="notice">{n}</span>
          ))}
        </div>
      )}

      <section className="player player--self">
        <div className="player__head">
          <div className="avatar avatar--you">You</div>
          <div className="player__meta">
            <HpBar hp={view.self.hp} max={view.maxHp} />
            <StatusChips statuses={view.self.statuses} />
          </div>
          <div className="player__counts">
            <span>Deck {view.self.deckRemaining}</span>
            <span>Discard {view.self.discardCount}</span>
          </div>
        </div>

        <div className="energy" aria-label={`Energy ${remaining} of ${view.self.energy} remaining`}>
          {Array.from({ length: view.energyPerTurn }, (_, i) => (
            <span key={i} className={`pip ${i < remaining ? "pip--on" : i < view.self.energy ? "pip--spent" : ""}`} />
          ))}
          <span className="energy__label">
            {locked ? "Locked" : `${remaining} energy left · ${selected.length}/${view.maxCardsPerTurn} cards`}
          </span>
        </div>

        <div className="hand">
          {view.self.hand.map(({ uid, def }) => (
            <Card
              key={uid}
              def={def}
              selected={selected.includes(uid) || view.self.committed?.includes(uid)}
              disabled={locked || finished || !canAdd(uid, def.cost)}
              onClick={() => toggle(uid)}
            />
          ))}
          {view.self.hand.length === 0 && <p className="muted">Your hand is empty.</p>}
        </div>

        {!finished && (
          <div className="actions">
            {locked ? (
              <span className="muted">Locked in — revealing when both sides are ready…</span>
            ) : (
              <>
                <button className="btn btn--ghost" onClick={() => onCommit(view.turn, [])}>
                  Pass
                </button>
                <button className="btn btn--primary" disabled={selected.length === 0} onClick={() => onCommit(view.turn, selected)}>
                  Lock in {selected.length > 0 ? `${selected.length} card${selected.length > 1 ? "s" : ""} (${spent} energy)` : ""}
                </button>
              </>
            )}
          </div>
        )}
      </section>

      {finished && <GameOver view={view} onNewMatch={onNewMatch} />}
    </main>
  );
}

function GameOver({ view, onNewMatch }: { view: PlayerView; onNewMatch: () => void }) {
  const win = view.settlement === "HUMAN_WIN";
  const title = view.outcome === "DRAW" ? "Draw — counts as a loss" : win ? "Victory" : "Defeat";
  const reason = view.endReason === "TURN_LIMIT" ? "Turn limit reached — higher HP wins." : view.outcome === "DRAW" ? "Both sides fell in the same turn. The house wins draws." : null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="go-title">
      <div className={`overlay__card ${win ? "is-win" : "is-loss"}`}>
        <h2 id="go-title">{title}</h2>
        <p>
          You {Math.max(0, view.self.hp)} HP · AI {Math.max(0, view.opponent.hp)} HP
        </p>
        {reason && <p className="muted">{reason}</p>}
        <button className="btn btn--primary btn--lg" onClick={onNewMatch}>
          Play again
        </button>
      </div>
    </div>
  );
}
