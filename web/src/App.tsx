import { useEffect, useState } from "react";
import { STAKE_TIERS, type StakeTier } from "./data/mockVault";
import { useGame } from "./lib/useGame";
import { MatchPage } from "./pages/MatchPage";
import { VaultPage } from "./pages/VaultPage";

const TIER_KEY = "ritarena-cardbattle-tier";

function loadTier(): StakeTier | null {
  try {
    return STAKE_TIERS.find((t) => t.id === sessionStorage.getItem(TIER_KEY)) ?? null;
  } catch {
    return null;
  }
}
function saveTier(tier: StakeTier) {
  try {
    sessionStorage.setItem(TIER_KEY, tier.id);
  } catch {
    /* ignore */
  }
}

export function App() {
  const game = useGame();
  const [page, setPage] = useState<"vault" | "match">("vault");
  const [tier, setTier] = useState<StakeTier | null>(loadTier);
  // While a new match is requested, ignore the previous match's view.
  const [waitingFrom, setWaitingFrom] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!game.error) return;
    const t = setTimeout(game.clearError, 4000);
    return () => clearTimeout(t);
  }, [game.error]);

  useEffect(() => {
    if (waitingFrom !== undefined && game.view && game.view.matchId !== waitingFrom) setWaitingFrom(undefined);
  }, [game.view, waitingFrom]);

  const startMatch = (t: StakeTier | null) => {
    if (t) {
      setTier(t);
      saveTier(t);
    }
    setWaitingFrom(game.view?.matchId ?? null);
    setPage("match");
    game.newMatch();
  };

  const showMatch = page === "match" && game.view && waitingFrom === undefined;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setPage("vault")}>
          <span className="brand__mark">◆</span> RitArena <span className="brand__sub">Card Battle</span>
        </button>
        <span className={`conn conn--${game.connection}`}>
          {game.connection === "open" ? "Connected" : game.connection === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
      </header>

      {game.error && (
        <div className="toast" role="alert" onClick={game.clearError}>
          {game.error}
        </div>
      )}

      {!game.ready ? (
        <main className="center muted">Connecting to the arena…</main>
      ) : page === "vault" ? (
        <VaultPage activeMatch={game.view} onEnter={startMatch} onResume={() => setPage("match")} />
      ) : showMatch ? (
        <MatchPage
          view={game.view!}
          deadline={game.deadline}
          tier={tier}
          onCommit={game.commit}
          onNewMatch={() => startMatch(tier)}
          onBack={() => setPage("vault")}
        />
      ) : (
        <main className="center muted">Shuffling decks…</main>
      )}
    </div>
  );
}
