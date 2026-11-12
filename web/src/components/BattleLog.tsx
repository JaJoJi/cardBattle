import type { DamageRecord, Side, TurnReportView } from "../../../server/src/engine/types";
import { GameCard } from "./GameCard";

const NAME: Record<Side, string> = { HUMAN: "You", AI: "AI" };

export function damageLine(d: DamageRecord): string {
  const who = `${NAME[d.sourcePlayer]} → ${NAME[d.target]}`;
  switch (d.category) {
    case "ATTACK":
      return d.unblockable
        ? `${who}: ${d.raw} unblockable Attack · ${d.hpDamage} HP`
        : `${who}: ${d.raw} Attack − ${d.absorbed} Block · ${d.hpDamage} HP`;
    case "SPELL":
      return `${who}: ${d.raw} Spell (ignores Block) · ${d.hpDamage} HP`;
    case "REFLECT":
      return `${who}: ${d.hpDamage} reflected`;
    case "STATUS":
      return `${NAME[d.target]}: ${d.hpDamage} Poison`;
  }
}

export function ReportLines({ report }: { report: TurnReportView }) {
  return (
    <ul className="lines">
      {(["AI", "HUMAN"] as Side[]).map((s) =>
        report.blockGained[s] > 0 ? (
          <li key={`b${s}`} className="line line--block">{NAME[s]}: +{report.blockGained[s]} Block</li>
        ) : null,
      )}
      {report.damage.map((d, i) => (
        <li key={i} className={`line line--${d.category.toLowerCase()}`}>{damageLine(d)}</li>
      ))}
      {report.heals.map((h, i) => (
        <li key={`h${i}`} className="line line--heal">
          {NAME[h.target]}: +{h.amount} HP ({h.source === "LIFESTEAL" ? "Lifesteal" : "Regen"})
        </li>
      ))}
      {report.youDrew.length > 0 && <li className="line line--draw">You drew {report.youDrew.map((c) => c.def.name).join(", ")}</li>}
      {report.opponentDrewCount > 0 && <li className="line line--draw">AI drew {report.opponentDrewCount} card(s)</li>}
      {report.youLost.length > 0 && <li className="line line--discard">Disruption discarded your {report.youLost.map((c) => c.def.name).join(", ")}</li>}
      {report.opponentLostCount > 0 && <li className="line line--discard">Your Disruption discarded {report.opponentLostCount} hidden AI card(s)</li>}
      {report.damage.length === 0 && report.heals.length === 0 && <li className="line muted">No damage</li>}
    </ul>
  );
}

export function BattleLog({ reports }: { reports: TurnReportView[] }) {
  return (
    <aside className="log-panel" aria-label="Battle log">
      <h2 className="log-panel__title">Battle log</h2>
      {reports.length === 0 && <p className="muted small">Revealed turns appear here.</p>}
      <ol className="log-panel__list">
        {[...reports].reverse().map((r) => (
          <li key={r.turn} className="log-entry">
            <div className="log-entry__head">
              <span>Turn {r.turn}</span>
              <span className="muted">
                You {Math.max(0, r.hpAfter.HUMAN)} · AI {Math.max(0, r.hpAfter.AI)}
              </span>
            </div>
            <div className="log-entry__cards">
              <span className="who">AI</span>
              {r.played.AI.length ? r.played.AI.map((c) => <GameCard key={c.uid} def={c.def} size="sm" />) : <span className="muted small">pass</span>}
            </div>
            <div className="log-entry__cards">
              <span className="who">You</span>
              {r.played.HUMAN.length ? r.played.HUMAN.map((c) => <GameCard key={c.uid} def={c.def} size="sm" />) : <span className="muted small">pass</span>}
            </div>
            <ReportLines report={r} />
          </li>
        ))}
      </ol>
    </aside>
  );
}
