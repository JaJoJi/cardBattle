import { useEffect, useState } from "react";
import { pdas } from "@ritarena/sdk";
import type { ServerConfig } from "../../../server/src/protocol";
import { WalletPanel, type WalletState } from "../components/ChainParts";
import { usdc } from "../data/mockVault";
import { explorerAddr, shortAddr } from "../lib/wallet";

interface VaultSnapshot {
  enabled: boolean;
  error?: string;
  reason?: string;
  house?: string;
  programId?: string;
  houseSol?: number;
  houseUsdc?: number;
  liveMatches?: number;
  stakeTiers?: number[];
  recentArenas?: { arenaId: number; state: string; stake: number; pot: number; rounds: number }[];
}

const TIER_NAMES: Record<number, string> = { 1: "Bronze", 5: "Silver", 25: "Gold", 100: "Mythic" };
const TIER_IDS: Record<number, string> = { 1: "bronze", 5: "silver", 25: "gold", 100: "mythic" };

export function ChainVault({ config, w, onEnter }: { config: ServerConfig; w: WalletState; onEnter: (stakeUsdc: number) => void }) {
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
  const tiers = snap?.stakeTiers ?? [1, 5, 25, 100];

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

      <section>
        <h2 className="section-title">Choose your stake</h2>
        <div className="tiers">
          {tiers.map((stake) => {
            const payout = stake * 2 * 0.99;
            const houseCanCover = houseUsdc >= stake;
            return (
              <article key={stake} className={`tier tier--${TIER_IDS[stake] ?? "bronze"}`}>
                <span className="tier__name">{TIER_NAMES[stake] ?? `${stake} USDC`}</span>
                <span className="tier__stake">
                  {usdc(stake, 0)} <small>test USDC</small>
                </span>
                <dl className="tier__meta">
                  <div>
                    <dt>Win pays</dt>
                    <dd>{usdc(payout)} USDC</dd>
                  </div>
                  <div>
                    <dt>Pot</dt>
                    <dd>2 × stake</dd>
                  </div>
                </dl>
                <button className="btn btn--gold" disabled={!w.address || !houseCanCover} onClick={() => onEnter(stake)}>
                  {!w.address ? "Connect wallet first" : houseCanCover ? "Stake & enter" : "House can't cover"}
                </button>
              </article>
            );
          })}
        </div>
        <p className="muted small fineprint">
          Each match is a 1v1 RitArena arena on devnet: you and the house each stake the entry fee into on-chain escrow; the server
          (oracle) posts a hash of every turn and finalizes the winner. 1% protocol fee · draws settle to the house · the shuffle seed
          is committed before turn 1 and revealed at the end.
        </p>
      </section>

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
