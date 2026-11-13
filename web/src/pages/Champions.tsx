import { useEffect, useState } from "react";
import type { ModelCard } from "../../../server/src/arena/book";
import { InfoTip } from "../components/InfoTip";
import { ChevronIcon, CoinIcon, CrownIcon, TrophyIcon } from "../components/icons";
import { usdc } from "../data/mockVault";

export interface ArenaSnapshot {
  models: (ModelCard & { unavailable: string | null })[];
  budget: { spentUsd: number; remainingUsd: number; capUsd: number; dailyCapUsd: number } | null;
  chainEnabled: boolean;
}

const M = 1_000_000;
const TONES = ["gold", "mythic", "silver", "bronze", "silver"];
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;
const cents = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

/** Win rate to show: vs humans once there are games, otherwise the seed benchmark vs our bot. */
function headlineWinRate(m: ModelCard): { rate: number | null; label: string } {
  if (m.games) return { rate: m.winRate, label: `vs humans · ${games(m.games)}` };
  if (m.benchGames) return { rate: m.benchWinRate, label: `vs house bot · ${games(m.benchGames)}` };
  return { rate: null, label: "no games yet" };
}

export function ModelLogo({ src, name, size = 40 }: { src: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="model-logo" style={{ width: size, height: size }}>
      {failed ? <span className="model-logo__mono">{name[0]}</span> : <img src={src} alt={`${name} logo`} onError={() => setFailed(true)} />}
    </span>
  );
}

/** Thin bar that fills to the win rate (animated on first paint). */
function RateBar({ rate }: { rate: number | null }) {
  return (
    <span className="ratebar" aria-hidden="true">
      <span className="ratebar__fill" style={{ ["--to" as string]: `${Math.round((rate ?? 0) * 100)}%` }} />
    </span>
  );
}

export function useArena() {
  const [snap, setSnap] = useState<ArenaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/arena")
        .then((r) => r.json())
        .then((b) => alive && (setSnap(b), setError(null)))
        .catch((e) => alive && setError(String(e)));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { snap, error };
}

function ChampionCard({ m, rank, onChallenge, blocked }: { m: ArenaSnapshot["models"][number]; rank: number; onChallenge: ((id: string) => void) | null; blocked?: string | null }) {
  const [open, setOpen] = useState(false);
  const why = m.unavailable ?? blocked ?? null;
  const wr = headlineWinRate(m);
  return (
    <article className={`tier tier--${TONES[(rank - 1) % TONES.length]} champion`} style={{ ["--i" as string]: rank }}>
      <div className="champion__head">
        <ModelLogo src={m.logo} name={m.name} size={44} />
        <div>
          <span className="tier__name">
            #{rank} · {m.vendor}
          </span>
          <span className="champion__name">{m.name}</span>
        </div>
      </div>

      <div className="champion__stats">
        <span className="stat" title="Elo rating — starts at 1500, moves after every match">
          <TrophyIcon />
          <strong>{m.elo}</strong>
          <small>Elo</small>
        </span>
        <span className="stat stat--rate" title={`Win rate ${wr.label}`}>
          <strong>{pct(wr.rate)}</strong>
          <small>wins</small>
          <RateBar rate={wr.rate} />
        </span>
      </div>

      <div className="champion__money">
        <span className="money" title="Your fee to challenge">
          <CoinIcon /> <strong>{usdc(m.priceMicro / M)}</strong>
          <small>fee</small>
        </span>
        <span className="money money--prize" title="What you win if you beat it">
          <CrownIcon /> <strong>{usdc(m.prizeMicro / M)}</strong>
          <small>prize</small>
        </span>
      </div>

      <button type="button" className="champion__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Details <ChevronIcon />
      </button>
      {open && (
        <dl className="champion__details">
          <div>
            <dt>Win rate</dt>
            <dd>{wr.label}</dd>
          </div>
          <div>
            <dt>Record vs humans</dt>
            <dd>{m.games ? `${m.wins}W ${m.losses}L${m.draws ? ` ${m.draws}D` : ""}` : "none yet"}</dd>
          </div>
          <div>
            <dt>Bounty pool</dt>
            <dd>{usdc(m.bountyMicro / M)} USDC</dd>
          </div>
          <div>
            <dt>API cost / match</dt>
            <dd>{cents(m.avgCostUsd)}</dd>
          </div>
        </dl>
      )}

      {onChallenge && (
        <button className="btn btn--gold" disabled={!!why} title={why ?? undefined} onClick={() => onChallenge(m.id)}>
          {why ? (m.unavailable ? "Resting" : why) : "Challenge"}
        </button>
      )}
    </article>
  );
}

/**
 * The five LLM champions. `onChallenge` is null in practice mode (cards are read-only there);
 * `blocked` explains why challenges are unavailable (e.g. wallet not connected).
 */
export function Champions({ onChallenge, blocked, hint }: { onChallenge: ((model: string) => void) | null; blocked?: string | null; hint?: string }) {
  const { snap, error } = useArena();
  return (
    <section>
      <h2 className="section-title">
        AI champions
        <InfoTip label="How fees and prizes work">
          <strong>Fee</strong> = (1 USDC + 3 × the model's real API cost) × a skill factor that rises with its win rate against humans.
          <br />
          <strong>Prize</strong> = at least 2× your fee, or 70% of the champion's bounty if that's larger.
          <br />
          Every fee pays the API bill and a 10% platform cut; the rest grows that champion's bounty. Draws go to the house.
        </InfoTip>
      </h2>
      {hint && <p className="muted small hint">{hint}</p>}
      {error && <p className="error-text small">Could not load the arena: {error}</p>}
      <div className="tiers tiers--champions">
        {(snap?.models ?? []).map((m, i) => (
          <ChampionCard key={m.id} m={m} rank={i + 1} onChallenge={onChallenge} blocked={blocked} />
        ))}
        {!snap && !error && <p className="muted">Loading champions…</p>}
      </div>
    </section>
  );
}

/** The benchmark: champions ranked by Elo. */
export function Leaderboard() {
  const { snap } = useArena();
  if (!snap) return null;
  return (
    <section>
      <h2 className="section-title">
        Benchmark
        <InfoTip label="About the ratings">
          Elo starts at 1500 and moves after every match against each player's own rating. Seed games against our bot (fixed at 1500)
          give the starting spread. Fees use only the win rate against humans.
          {snap.budget && (
            <>
              <br />
              API budget: ${snap.budget.spentUsd.toFixed(2)} of ${snap.budget.capUsd.toFixed(2)} used, max ${snap.budget.dailyCapUsd.toFixed(2)}/day. Champions
              rest when it runs out.
            </>
          )}
        </InfoTip>
      </h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Model</th>
              <th scope="col" className="num">Elo</th>
              <th scope="col">Win rate</th>
              <th scope="col" className="num">Fee</th>
            </tr>
          </thead>
          <tbody>
            {snap.models.map((m, i) => {
              const wr = headlineWinRate(m);
              return (
                <tr key={m.id}>
                  <td className="lb-rank">{i + 1}</td>
                  <td>
                    <span className="lb-model">
                      <ModelLogo src={m.logo} name={m.name} size={26} />
                      {m.name}
                    </span>
                  </td>
                  <td className="num">
                    <strong>{m.elo}</strong>
                  </td>
                  <td>
                    <span className="lb-rate" title={wr.label}>
                      <RateBar rate={wr.rate} />
                      {pct(wr.rate)}
                    </span>
                  </td>
                  <td className="num">{usdc(m.priceMicro / M)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
