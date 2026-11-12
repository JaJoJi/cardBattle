import type { PlayerView } from "../../../server/src/engine/types";
import type { PlayMode, ServerConfig } from "../../../server/src/protocol";
import type { WalletState } from "../components/ChainParts";
import { ChainVault } from "./ChainVault";
import { VAULT_EMBLEM } from "../assets";
import { Art } from "../components/Art";
import { CheckIcon, EqualIcon, VaultIcon, XIcon } from "../components/icons";
import { MOCK_VAULT, RECENT_SETTLEMENTS, STAKE_TIERS, freeLiquidity, maxSinglePayout, usdc, type StakeTier } from "../data/mockVault";

interface Props {
  mode: PlayMode;
  config: ServerConfig | null;
  wallet: WalletState;
  activeMatch: PlayerView | null;
  activeIsChain: boolean;
  onEnter: (tier: StakeTier) => void;
  onEnterChain: (stakeUsdc: number) => void;
  onResume: () => void;
}

export function VaultPage({ mode, config, wallet, activeMatch, activeIsChain, onEnter, onEnterChain, onResume }: Props) {
  const chain = mode === "chain" && config?.chainEnabled;
  return (
    <main className="vault">
      <section className="vault__hero">
        <Art className="vault__emblem" src={VAULT_EMBLEM} alt="Vault emblem" fallback={<span className="vault__emblem-glyph"><VaultIcon /></span>} />
        <div className="vault__intro">
          {chain ? (
            <span className="mock-badge mock-badge--chain">Live · Solana devnet · test USDC</span>
          ) : (
            <span className="mock-badge">Practice · mock data · no funds move</span>
          )}
          <h1>{MOCK_VAULT.name}</h1>
          <p className="muted">
            {chain
              ? "Stake test USDC on devnet and duel the house AI. The house matches your stake; the winner takes the pot."
              : "Free practice against the house AI. Switch to On-chain to stake test USDC on Solana devnet."}
          </p>
        </div>
      </section>

      {activeMatch && activeMatch.phase !== "FINISHED" && (
        <div className="resume">
          <span>
            You have {activeIsChain ? "a staked" : "a practice"} match in progress — turn {activeMatch.turn}, you {activeMatch.self.hp} HP vs AI{" "}
            {activeMatch.opponent.hp} HP.
          </span>
          <button className="btn btn--gold" onClick={onResume}>
            Continue match
          </button>
        </div>
      )}

      {chain && config ? <ChainVault config={config} w={wallet} onEnter={onEnterChain} /> : <MockVaultBody onEnter={onEnter} />}
    </main>
  );
}

function MockVaultBody({ onEnter }: { onEnter: (tier: StakeTier) => void }) {
  const tiles = [
    { label: "Vault balance", value: usdc(MOCK_VAULT.balanceUsdc), unit: "USDC" },
    { label: "Free liquidity", value: usdc(freeLiquidity()), unit: "USDC" },
    { label: "Locked in live matches", value: usdc(MOCK_VAULT.lockedInMatchesUsdc), unit: "USDC" },
    { label: "24h volume", value: usdc(MOCK_VAULT.volume24hUsdc, 0), unit: "USDC" },
    { label: "Matches settled", value: MOCK_VAULT.matchesPlayed.toLocaleString("en-US"), unit: "" },
    { label: "Player win rate", value: (MOCK_VAULT.playerWinRate * 100).toFixed(1), unit: "%" },
  ];

  return (
    <>
      <section className="tiles" aria-label="Vault statistics">
        {tiles.map((t) => (
          <div key={t.label} className="tile">
            <span className="tile__label">{t.label}</span>
            <span className="tile__value">
              {t.value}
              {t.unit && <span className="tile__unit"> {t.unit}</span>}
            </span>
          </div>
        ))}
      </section>

      <section>
        <h2 className="section-title">Choose your stake</h2>
        <div className="tiers">
          {STAKE_TIERS.map((tier) => {
            const payout = tier.stake * tier.payoutMultiplier;
            const covered = payout <= maxSinglePayout();
            return (
              <article key={tier.id} className={`tier tier--${tier.id}`}>
                <span className="tier__name">{tier.name}</span>
                <span className="tier__stake">
                  {usdc(tier.stake, 0)} <small>USDC</small>
                </span>
                <dl className="tier__meta">
                  <div>
                    <dt>Win pays</dt>
                    <dd>{usdc(payout)} USDC</dd>
                  </div>
                  <div>
                    <dt>Multiplier</dt>
                    <dd>{tier.payoutMultiplier}×</dd>
                  </div>
                </dl>
                <button className="btn btn--gold" disabled={!covered} onClick={() => onEnter(tier)}>
                  {covered ? "Enter arena" : "Exceeds vault limit"}
                </button>
              </article>
            );
          })}
        </div>
        <p className="muted small fineprint">
          Practice mode: no funds move yet. Protocol fee {MOCK_VAULT.protocolFeeBps / 100}% · a single payout is capped at{" "}
          {MOCK_VAULT.maxPayoutShareBps / 100}% of free liquidity ({usdc(maxSinglePayout())} USDC) · draws settle as a loss · a deck of 1 or fewer cards at the End phase is a defeat.
        </p>
      </section>

      <section>
        <h2 className="section-title">Recent settlements</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="num">Stake</th>
                <th scope="col">Result</th>
                <th scope="col" className="num">Payout</th>
                <th scope="col" className="num">Turns</th>
                <th scope="col" className="num">When</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_SETTLEMENTS.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.player}</td>
                  <td className="num">{usdc(r.stake)}</td>
                  <td>
                    <span className={`result result--${r.result.toLowerCase()}`}>
                      {r.result === "WIN" ? <CheckIcon /> : r.result === "LOSS" ? <XIcon /> : <EqualIcon />}
                      {r.result === "DRAW" ? "Draw (loss)" : r.result === "WIN" ? "Win" : "Loss"}
                    </span>
                  </td>
                  <td className="num">{r.payout > 0 ? usdc(r.payout) : "—"}</td>
                  <td className="num">{r.turns}</td>
                  <td className="num muted">{r.minutesAgo}m ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
