import type { PlayerView } from "../../../server/src/engine/types";
import type { PlayMode, ServerConfig } from "../../../server/src/protocol";
import type { WalletState } from "../components/ChainParts";
import { ChainVault } from "./ChainVault";
import { VAULT_EMBLEM } from "../assets";
import { Art } from "../components/Art";
import { CoinIcon, CrownIcon, ShieldIcon, SwordIcon } from "../components/icons";
import { InfoTip } from "../components/InfoTip";
import { Champions, Leaderboard } from "./Champions";

interface Props {
  mode: PlayMode;
  config: ServerConfig | null;
  wallet: WalletState;
  activeMatch: PlayerView | null;
  activeIsChain: boolean;
  onEnter: () => void;
  onEnterChain: (model: string) => void;
  onResume: () => void;
}

export function VaultPage({ mode, config, wallet, activeMatch, activeIsChain, onEnter, onEnterChain, onResume }: Props) {
  const chain = mode === "chain" && config?.chainEnabled;
  return (
    <main className="vault">
      <section className="vault__hero">
        <Art className="vault__emblem" src={VAULT_EMBLEM} alt="Arena crest" fallback={<span className="vault__emblem-glyph"><ShieldIcon /></span>} />
        <div className="vault__intro">
          {chain ? (
            <span className="mock-badge mock-badge--chain">Live · Solana devnet · test USDC</span>
          ) : (
            <span className="mock-badge">Practice · free · no funds move</span>
          )}
          <h1>Card Battle Arena</h1>
          <p className="muted">Five AI models. One card game. Can you beat them?</p>
          <ol className="steps-row" aria-label="How it works">
            <li style={{ ["--i" as string]: 0 }}>
              <span className="steps-row__icon"><SwordIcon /></span>
              Pick a champion
            </li>
            <li style={{ ["--i" as string]: 1 }}>
              <span className="steps-row__icon"><CoinIcon /></span>
              Pay its fee
            </li>
            <li style={{ ["--i" as string]: 2 }}>
              <span className="steps-row__icon"><CrownIcon /></span>
              Win the prize
            </li>
          </ol>
        </div>
      </section>

      {activeMatch && activeMatch.phase !== "FINISHED" && (
        <div className="resume">
          <span>
            <strong>{activeIsChain ? "Challenge" : "Practice"} in progress</strong> · turn {activeMatch.turn} · you {activeMatch.self.hp} HP vs{" "}
            {activeMatch.opponent.hp} HP
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

function MockVaultBody({ onEnter }: { onEnter: () => void }) {
  return (
    <>
      <section>
        <h2 className="section-title">Practice</h2>
        <article className="practice">
          <span className="practice__icon"><ShieldIcon /></span>
          <div className="practice__text">
            <strong>House Bot</strong>
            <span className="muted">Free · no wallet</span>
          </div>
          <InfoTip label="About the house bot">
            Our own search AI: it simulates the game engine, counts cards and learns your patterns. Learn the cards here before you take
            on an LLM.
          </InfoTip>
          <button className="btn btn--gold" onClick={onEnter}>
            Practice now
          </button>
        </article>
      </section>
      <Champions onChallenge={null} hint="Switch to On-chain (top right) to challenge one with test USDC." />
      <Leaderboard />
    </>
  );
}
