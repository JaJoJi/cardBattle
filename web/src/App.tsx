import { useEffect, useState } from "react";
import type { PlayMode } from "../../server/src/protocol";
import { ModeToggle, StakingScreen } from "./components/ChainParts";
import bs58 from "bs58";
import { friendlyError } from "./lib/chainClient";
import { useGame } from "./lib/useGame";
import { useWallet } from "./lib/wallet";
import { MatchPage } from "./pages/MatchPage";
import { VaultPage } from "./pages/VaultPage";

const MODE_KEY = "ritarena-cardbattle-mode";

function load<T>(key: string, parse: (v: string | null) => T): T {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function App() {
  const game = useGame();
  const wallet = useWallet();
  const [page, setPage] = useState<"vault" | "match">("vault");
  const [mode, setMode] = useState<PlayMode>(() => load(MODE_KEY, (v) => (v === "chain" ? "chain" : "mock")));
  /** The champion of the last challenge, for "rematch". */
  const [lastModel, setLastModel] = useState<string | null>(null);
  // While a new match is requested, ignore the previous match's view.
  const [waitingFrom, setWaitingFrom] = useState<string | null | undefined>(undefined);

  const chainAvailable = !!game.config?.chainEnabled;
  const effectiveMode: PlayMode = mode === "chain" && chainAvailable ? "chain" : "mock";

  useEffect(() => {
    if (!game.error) return;
    const t = setTimeout(game.clearError, 5000);
    return () => clearTimeout(t);
  }, [game.error]);

  // A rejected new-match request (e.g. invalid stake) returns to the vault.
  useEffect(() => {
    if (game.errorSeq > 0 && waitingFrom !== undefined) {
      setWaitingFrom(undefined);
      setPage("vault");
    }
  }, [game.errorSeq]);

  useEffect(() => {
    if (waitingFrom !== undefined && game.view && game.view.matchId !== waitingFrom) setWaitingFrom(undefined);
  }, [game.view, waitingFrom]);

  const changeMode = (m: PlayMode) => {
    setMode(m);
    save(MODE_KEY, m);
  };

  const begin = (start: () => void) => {
    setWaitingFrom(game.view?.matchId ?? null);
    setPage("match");
    start();
  };

  const startMock = () => begin(() => game.newMatch({ mode: "mock" }));

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  /** Gets a price quote, proves wallet ownership by signing it (no transaction, no fee), then asks for an arena. */
  const startChain = async (model: string) => {
    if (!wallet.wallet || !wallet.address) return void wallet.connect();
    setSignError(null);
    setSigning(true);
    try {
      const challenge = await game.requestChallenge(wallet.address, model);
      if (!challenge) return; // server error already shown
      const signature = await wallet.wallet.signMessage(new TextEncoder().encode(challenge.message));
      setLastModel(model);
      begin(() =>
        game.newMatch({
          mode: "chain",
          model,
          quoteId: challenge.quote.id,
          player: wallet.address!,
          nonce: challenge.nonce,
          signature: bs58.encode(signature),
        }),
      );
    } catch (e) {
      setSignError(friendlyError(e));
    } finally {
      setSigning(false);
    }
  };

  const isChainGame = game.mode === "chain" && !!game.chain;
  const preGame = isChainGame && game.chain!.phase !== "playing" && !(game.view?.phase === "FINISHED") && !game.view?.lastTurn;
  const showMatch = page === "match" && game.view && waitingFrom === undefined;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setPage("vault")}>
          <span className="brand__mark">◆</span> RitArena <span className="brand__sub">Card Battle</span>
        </button>
        <div className="topbar__right">
          <ModeToggle mode={effectiveMode} onChange={changeMode} config={game.config} />
          <span className={`conn conn--${game.connection}`}>
            {game.connection === "open" ? "Connected" : game.connection === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      </header>

      {(game.error || signError) && (
        <div className="toast" role="alert" onClick={() => (game.clearError(), setSignError(null))}>
          {game.error ?? signError}
        </div>
      )}
      {signing && <div className="toast toast--info">Approve the challenge message in your wallet (no fee)…</div>}

      {!game.ready ? (
        <main className="center muted">Connecting to the arena…</main>
      ) : page === "vault" ? (
        <VaultPage
          mode={effectiveMode}
          config={game.config}
          wallet={wallet}
          activeMatch={game.view}
          activeIsChain={isChainGame}
          onEnter={startMock}
          onEnterChain={(m) => void startChain(m)}
          onResume={() => setPage("match")}
        />
      ) : showMatch && preGame && game.config ? (
        <StakingScreen
          status={game.chain!}
          w={wallet}
          config={game.config}
          onEntered={game.chainEntered}
          onCancel={game.chainCancel}
          onBack={() => setPage("vault")}
        />
      ) : showMatch ? (
        <MatchPage
          view={game.view!}
          deadline={game.deadline}
          opponent={game.opponent}
          chain={isChainGame ? game.chain : null}
          config={game.config}
          wallet={wallet}
          onCommit={game.commit}
          onNewMatch={() => (isChainGame && (game.chain?.opponent?.model ?? lastModel) ? void startChain(game.chain?.opponent?.model ?? lastModel!) : startMock())}
          onBack={() => setPage("vault")}
        />
      ) : (
        <main className="center muted">{effectiveMode === "chain" ? "Creating your arena on devnet…" : "Shuffling decks…"}</main>
      )}
    </div>
  );
}
