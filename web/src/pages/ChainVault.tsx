import { useEffect, useState } from "react";
import { pdas } from "@ritarena/sdk";
import type { ServerConfig } from "../../../server/src/protocol";
import { WalletPanel, type WalletState } from "../components/ChainParts";
import { usdc } from "../data/mockVault";
import { explorerAddr, shortAddr } from "../lib/wallet";
import { Champions, Leaderboard } from "./Champions";

interface VaultSnapshot {
  enabled: boolean;
  error?: string;
  reason?: string;
  house?: string;
  programId?: string;
  houseSol?: number;
  houseUsdc?: number;
  liveMatches?: number;
  recentArenas?: { arenaId: number; state: string; stake: number; pot: number; rounds: number }[];
}


export function ChainVault({ config, w, onEnter }: { config: ServerConfig; w: WalletState; onEnter: (model: string) => void }) {
  const [snap, setSnap] = useState<VaultSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/vault")
        .then((r) => r.json())
        .then((b) => alive && setSnap(b))
        .catch((e) => alive && setSnap({ enabled: true, error: String(e) }));
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const houseUsdc = snap?.houseUsdc ?? 0;

  return (
    <>
      <WalletPanel w={w} config={config} />

      {snap?.error && <p className="error-text small">Could not read the vault from devnet: {snap.error}</p>}

      <section className="tiles" aria-label="Live vault statistics">
        <div className="tile">
          <span className="tile__label">House vault</span>
          <span className="tile__value">
            {snap ? usdc(houseUsdc) : "…"}
            <span className="tile__unit"> USDC</span>
          </span>
        </div>
        <div className="tile">
          <span className="tile__label">House SOL (fees)</span>
          <span className="tile__value">{snap?.houseSol !== undefined ? snap.houseSol.toFixed(3) : "…"}</span>
        </div>
        <div className="tile">
          <span className="tile__label">Live staked matches</span>
          <span className="tile__value">{snap?.liveMatches ?? "…"}</span>
        </div>
        <div className="tile">
          <span className="tile__label">House wallet</span>
          <span className="tile__value tile__value--sm">
            {config.house ? (
              <a className="mono" href={explorerAddr(config.house)} target="_blank" rel="noreferrer">
                {shortAddr(config.house)}
              </a>
            ) : (
              "—"
            )}
          </span>
        </div>
      </section>

      <Champions onChallenge={onEnter} blocked={!w.address ? "Connect wallet first" : null} />
      <details className="fold">
        <summary>How on-chain challenges work</summary>
        <p className="muted small">
          Each challenge is a 1v1 RitArena arena on devnet: you stake the fee and the house matches it from the champion's bounty, both in
          on-chain escrow. The server posts a hash of every turn and finalizes the winner; a prize above the pot is topped up by the house.
          The shuffle seed is committed before turn 1 and revealed at the end.
        </p>
      </details>

      <Leaderboard />

      <section>
        <h2 className="section-title">Recent house arenas</h2>
        {snap?.recentArenas && snap.recentArenas.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Arena</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">Stake</th>
                  <th scope="col" className="num">Pot</th>
                  <th scope="col" className="num">Rounds</th>
                </tr>
              </thead>
              <tbody>
                {snap.recentArenas.map((a) => (
                  <tr key={a.arenaId}>
                    <td>
                      <a className="mono" href={explorerAddr(pdas.arena(a.arenaId).toBase58())} target="_blank" rel="noreferrer">
                        #{a.arenaId} ↗
                      </a>
                    </td>
                    <td>{a.state}</td>
                    <td className="num">{usdc(a.stake)}</td>
                    <td className="num">{usdc(a.pot)}</td>
                    <td className="num">{a.rounds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">{snap ? "No arenas yet — the first staked match will appear here." : "Loading…"}</p>
        )}
      </section>
    </>
  );
}
