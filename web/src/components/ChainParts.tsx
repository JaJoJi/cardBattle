import { useCallback, useEffect, useState } from "react";
import type { ChainStatus } from "../../../server/src/chain/types";
import type { PlayMode, ServerConfig } from "../../../server/src/protocol";
import { claimPrize, enterArena, friendlyError, mintTestUsdc, refundEntry, walletBalances, USDC } from "../lib/chainClient";
import { explorerAddr, explorerTx, shortAddr, type BrowserWallet } from "../lib/wallet";
import { usdc } from "../data/mockVault";
import { CheckIcon, LockIcon, XIcon } from "./icons";

// ------------------------------------------------------------------ mode toggle

export function ModeToggle({ mode, onChange, config }: { mode: PlayMode; onChange: (m: PlayMode) => void; config: ServerConfig | null }) {
  const chainOff = !config?.chainEnabled;
  return (
    <div className="mode-toggle" role="radiogroup" aria-label="Play mode">
      <button role="radio" aria-checked={mode === "mock"} className={mode === "mock" ? "is-on" : ""} onClick={() => onChange("mock")}>
        Practice
      </button>
      <button
        role="radio"
        aria-checked={mode === "chain"}
        className={mode === "chain" ? "is-on" : ""}
        onClick={() => onChange("chain")}
        disabled={chainOff}
        title={chainOff ? config?.chainDisabledReason ?? "On-chain mode unavailable" : "Staked matches on Solana devnet"}
      >
        On-chain <small>devnet</small>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ wallet

export interface WalletState {
  available: boolean;
  address: string | null;
  wallet: BrowserWallet | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  error: string | null;
}

export function useBalances(rpcUrl: string | undefined, address: string | null) {
  const [bal, setBal] = useState<{ sol: number; usdc: number } | null>(null);
  const refresh = useCallback(async () => {
    if (!rpcUrl || !address) return setBal(null);
    try {
      setBal(await walletBalances(rpcUrl, address));
    } catch {
      /* keep last */
    }
  }, [rpcUrl, address]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);
  return { bal, refresh };
}

export function WalletPanel({ w, config }: { w: WalletState; config: ServerConfig }) {
  const { bal, refresh } = useBalances(config.rpcUrl, w.address);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const faucet = async () => {
    if (!w.wallet) return;
    setBusy(true);
    setMsg(null);
    try {
      await mintTestUsdc(config.rpcUrl, w.wallet, 100);
      setMsg("Minted 100 test USDC.");
      await refresh();
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!w.address) {
    return (
      <section className="wallet-panel">
        <div>
          <strong>Connect a Solana wallet</strong>
          <p className="muted small">On-chain matches stake test USDC on devnet. Set Phantom to devnet (Settings → Developer Settings → Testnet Mode).</p>
          {w.error && <p className="small error-text">{w.error}</p>}
        </div>
        <button className="btn btn--gold" onClick={w.connect}>
          {w.available ? "Connect Phantom" : "Install Phantom"}
        </button>
      </section>
    );
  }
  return (
    <section className="wallet-panel">
      <div className="wallet-panel__info">
        <a className="mono" href={explorerAddr(w.address)} target="_blank" rel="noreferrer">
          {shortAddr(w.address)}
        </a>
        <span>
          <strong>{bal ? bal.sol.toFixed(3) : "…"}</strong> <span className="muted">SOL</span>
        </span>
        <span>
          <strong>{bal ? usdc(bal.usdc) : "…"}</strong> <span className="muted">test USDC</span>
        </span>
        {msg && <span className="small muted">{msg}</span>}
      </div>
      <div className="wallet-panel__actions">
        {bal && bal.sol < 0.02 && (
          <a className="btn btn--ghost btn--sm" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            Get devnet SOL ↗
          </a>
        )}
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={faucet}>
          {busy ? "Minting…" : "Get 100 test USDC"}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ status + tx log

const PHASE_LABEL: Record<ChainStatus["phase"], string> = {
  creating: "Creating arena…",
  "awaiting-entry": "Waiting for your stake",
  starting: "House staking & starting…",
  playing: "Live on devnet",
  finalizing: "Finalizing result…",
  settled: "Settled",
  cancelled: "Cancelled",
  failed: "Needs attention",
};

export function ChainPanel({ status }: { status: ChainStatus }) {
  return (
    <section className="chain-panel" aria-label="On-chain status">
      <div className="chain-panel__head">
        <span className={`chain-dot chain-dot--${status.phase}`} />
        <strong>{PHASE_LABEL[status.phase]}</strong>
        {status.arenaId !== null && <span className="muted small">Arena #{status.arenaId}</span>}
      </div>
      <dl className="chain-panel__meta">
        <div>
          <dt>Stake</dt>
          <dd>{usdc(status.stakeMicro / USDC)} USDC</dd>
        </div>
        <div>
          <dt>Win pays</dt>
          <dd>{usdc(status.payoutMicro / USDC)} USDC</dd>
        </div>
        <div>
          <dt>House</dt>
          <dd>
            <a className="mono" href={explorerAddr(status.house)} target="_blank" rel="noreferrer">
              {shortAddr(status.house)}
            </a>
          </dd>
        </div>
      </dl>
      <details className="chain-panel__seed">
        <summary>
          Randomness: {status.seedScheme === "vrf-v2" ? <strong className="vrf-badge">MagicBlock VRF</strong> : "server seed (commit-reveal)"}
        </summary>
        {status.seedScheme === "vrf-v2" ? (
          <>
            <p className="small muted">
              The house committed to secret entropy and requested MagicBlock VRF in one transaction, before the VRF output existed.
              Decks are shuffled from sha256(entropy ‖ VRF ‖ matchId) — neither side could choose them.
            </p>
            {status.vrf && (
              <p className="small">
                VRF account:{" "}
                <a className="mono" href={explorerAddr(status.vrf.account)} target="_blank" rel="noreferrer">
                  {shortAddr(status.vrf.account)} ↗
                </a>
                {status.vrf.randomness ? (
                  <>
                    <br />
                    VRF output: <span className="mono break">{status.vrf.randomness}</span>
                  </>
                ) : (
                  <span className="muted"> — waiting for the oracle…</span>
                )}
              </p>
            )}
            <p className="small">
              Entropy commitment: <span className="mono break">{status.seedCommitment}</span>
            </p>
            {status.seedReveal ? (
              <p className="small">
                Revealed entropy: <span className="mono break">{status.seedReveal}</span>
                <br />
                <span className="muted">Check: sha256(entropy ‖ matchId) = commitment (stored in the VRF account); then the seed reproduces both decks.</span>
              </p>
            ) : (
              <p className="muted small">The house entropy is revealed when the match ends.</p>
            )}
          </>
        ) : (
          <>
            <p className="mono small break">{status.seedCommitment}</p>
            {status.seedReveal ? (
              <p className="small">
                Revealed seed: <span className="mono break">{status.seedReveal}</span>
                <br />
                <span className="muted">sha256(seed ‖ matchId) must equal the commitment above; replaying the shuffle reproduces both decks.</span>
              </p>
            ) : (
              <p className="muted small">The secret seed is revealed when the match ends so you can verify the decks weren't changed.</p>
            )}
          </>
        )}
      </details>
      {status.error && <p className="small error-text">{status.error}</p>}
      <ol className="txs">
        {[...status.txs].reverse().map((t, i) => (
          <li key={status.txs.length - i} className={`tx tx--${t.status}`}>
            <span className="tx__icon">{t.status === "ok" ? <CheckIcon /> : t.status === "failed" ? <XIcon /> : <span className="spinner" />}</span>
            <span className="tx__label">{t.label}</span>
            {t.sig && (
              <a className="tx__link" href={explorerTx(t.sig)} target="_blank" rel="noreferrer">
                view ↗
              </a>
            )}
            {t.error && <span className="tx__err small">{t.error}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ staking (pre-game)

export function StakingScreen({
  status,
  w,
  config,
  onEntered,
  onCancel,
  onBack,
}: {
  status: ChainStatus;
  w: WalletState;
  config: ServerConfig;
  onEntered: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const { bal, refresh } = useBalances(config.rpcUrl, w.address);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stake = status.stakeMicro / USDC;
  const wrongWallet = w.address && w.address !== status.player;
  const secsLeft = status.entryDeadline ? Math.max(0, Math.round((status.entryDeadline - Date.now()) / 1000)) : null;

  const stakeNow = async () => {
    if (!w.wallet || status.arenaId === null) return;
    setBusy(true);
    setErr(null);
    try {
      await enterArena(config.rpcUrl, w.wallet, status.arenaId);
      onEntered();
      void refresh();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const steps: { label: string; state: "done" | "active" | "todo" }[] = [
    { label: status.arenaId !== null ? `Arena #${status.arenaId} created by the house` : "Creating 1v1 arena", state: status.arenaId !== null ? "done" : "active" },
    { label: `Stake ${usdc(stake)} test USDC from your wallet`, state: status.phase === "awaiting-entry" ? "active" : status.phase === "creating" ? "todo" : "done" },
    { label: "House matches your fee from the bounty and starts the match", state: status.phase === "starting" ? "active" : status.phase === "playing" ? "done" : "todo" },
  ];

  return (
    <main className="staking">
      <div className="staking__card">
        <span className="mock-badge mock-badge--chain">Solana devnet · test USDC</span>
        <h1>{status.opponent ? `Challenge ${status.opponent.name}` : "Stake & enter"}</h1>
        <p className="muted">
          {status.prizeMicro ? (
            <>
              Beat it and win <strong>{usdc(status.prizeMicro / USDC)} USDC</strong>: the arena pot ({usdc(status.payoutMicro / USDC)}) plus{" "}
              {usdc((status.topUpMicro ?? 0) / USDC)} from its bounty. Draws go to the house.
            </>
          ) : (
            <>
              Winner takes the pot: <strong>{usdc(status.payoutMicro / USDC)} USDC</strong> (2× stake − 1% protocol fee). Draws go to the house.
            </>
          )}
        </p>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.label} className={`step step--${s.state}`}>
              <span className="step__dot">{s.state === "done" ? <CheckIcon /> : s.state === "active" ? <span className="spinner" /> : null}</span>
              {s.label}
            </li>
          ))}
        </ol>

        {status.phase === "awaiting-entry" && (
          <>
            {!w.address ? (
              <button className="btn btn--gold btn--lg" onClick={w.connect}>
                Connect wallet
              </button>
            ) : wrongWallet ? (
              <p className="error-text small">Switch your wallet back to {shortAddr(status.player)} — this arena was created for that address.</p>
            ) : (
              <>
                <p className="small muted">
                  Wallet: {bal ? `${bal.sol.toFixed(3)} SOL · ${usdc(bal.usdc)} test USDC` : "…"}
                  {bal && bal.usdc < stake && " — not enough test USDC, use the faucet on the vault page."}
                </p>
                <button className="btn btn--gold btn--lg" disabled={busy || (bal !== null && bal.usdc < stake)} onClick={stakeNow}>
                  <LockIcon /> {busy ? "Confirm in wallet…" : `Stake ${usdc(stake)} USDC`}
                </button>
              </>
            )}
            {secsLeft !== null && <p className="small muted">Entry window closes in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")}</p>}
            <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
              Cancel match
            </button>
          </>
        )}
        {err && <p className="error-text small">{err}</p>}
        {(status.phase === "cancelled" || status.phase === "failed") && (
          <>
            <p className="error-text">{status.error}</p>
            {status.playerCanRefund && <RefundButton status={status} w={w} config={config} />}
            <button className="btn btn--ghost" onClick={onBack}>
              Back to vault
            </button>
          </>
        )}
      </div>
      <ChainPanel status={status} />
    </main>
  );
}

function RefundButton({ status, w, config }: { status: ChainStatus; w: WalletState; config: ServerConfig }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    if (!w.wallet || status.arenaId === null) return;
    setState("busy");
    setErr(null);
    try {
      await refundEntry(config.rpcUrl, w.wallet, status.arenaId);
      setState("done");
    } catch (e) {
      setErr(friendlyError(e));
      setState("idle");
    }
  };
  return (
    <>
      <button className="btn btn--gold" onClick={run} disabled={state !== "idle" || !w.wallet}>
        {state === "done" ? "Stake refunded" : state === "busy" ? "Confirm in wallet…" : `Refund my ${usdc(status.stakeMicro / USDC)} USDC`}
      </button>
      {err && <p className="error-text small">{err}</p>}
    </>
  );
}

// ------------------------------------------------------------------ settlement (game over)

export function ChainSettlement({ status, w, config }: { status: ChainStatus; w: WalletState; config: ServerConfig }) {
  const [claim, setClaim] = useState<{ state: "idle" | "busy" | "done"; sig?: string; err?: string }>({ state: "idle" });
  const payout = usdc(status.payoutMicro / USDC);

  const doClaim = async () => {
    if (!w.wallet || status.arenaId === null) return;
    setClaim({ state: "busy" });
    try {
      const sig = await claimPrize(config.rpcUrl, w.wallet, status.arenaId);
      setClaim({ state: "done", sig });
    } catch (e) {
      setClaim({ state: "idle", err: friendlyError(e) });
    }
  };

  if (status.phase === "finalizing") return <p className="gameover__payout">Recording the result on devnet…</p>;
  if (status.phase === "failed") return <p className="error-text small">{status.error}</p>;
  if (status.phase !== "settled") return null;
  if (status.winner === "HOUSE") return <p className="gameover__payout">The house won the {payout} USDC pot (result finalized on-chain).</p>;
  return (
    <div className="claim">
      <p className="gameover__payout">You won {payout} test USDC!</p>
      {claim.state === "done" ? (
        <a className="btn btn--ghost" href={explorerTx(claim.sig!)} target="_blank" rel="noreferrer">
          Claimed — view transaction ↗
        </a>
      ) : !w.wallet ? (
        <button className="btn btn--gold btn--lg" onClick={w.connect}>
          Connect wallet to claim
        </button>
      ) : (
        <button className="btn btn--gold btn--lg" onClick={doClaim} disabled={claim.state === "busy"}>
          {claim.state === "busy" ? "Confirm in wallet…" : `Claim ${payout} USDC`}
        </button>
      )}
      {claim.err && <p className="error-text small">{claim.err}</p>}
    </div>
  );
}
