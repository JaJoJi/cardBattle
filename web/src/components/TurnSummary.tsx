import type { DamageRecord, Side, TurnReportView } from "../../../server/src/engine/types";
import { Card } from "./Card";

const NAME: Record<Side, string> = { HUMAN: "You", AI: "AI" };

function damageLine(d: DamageRecord): string {
  const who = `${NAME[d.sourcePlayer]} → ${NAME[d.target]}`;
  switch (d.category) {
    case "ATTACK":
      return d.unblockable
        ? `${who}: ${d.raw} unblockable Attack → ${d.hpDamage} HP`
        : `${who}: ${d.raw} Attack, ${d.absorbed} blocked → ${d.hpDamage} HP`;
    case "SPELL":
      return `${who}: ${d.raw} Spell (ignores Block) → ${d.hpDamage} HP`;
    case "REFLECT":
      return `${who}: ${d.hpDamage} reflected`;
    case "STATUS":
      return `${NAME[d.target]} took ${d.hpDamage} Poison`;
  }
}

export function TurnSummary({ report }: { report: TurnReportView | null }) {
  if (!report) {
    return (
      <section className="summary summary--empty">
        <p>Pick up to 2 cards (≤ 5 energy) and lock in. The AI has already locked its choice in secret — both are revealed together.</p>
      </section>
    );
  }
  const side = (s: Side) => (
    <div className="summary__side">
      <h3>{NAME[s]} played</h3>
      <div className="summary__cards">
        {report.played[s].length === 0 ? <span className="muted">Passed</span> : report.played[s].map((c) => <Card key={c.uid} def={c.def} size="mini" />)}
      </div>
      {report.blockGained[s] > 0 && <p className="tag tag--block">+{report.blockGained[s]} Block</p>}
    </div>
  );
  return (
    <section className="summary" aria-live="polite">
      <h2>Turn {report.turn} reveal</h2>
      <div className="summary__grid">
        {side("AI")}
        {side("HUMAN")}
      </div>
      <ul className="summary__log">
        {report.damage.map((d, i) => (
          <li key={i} className={`log log--${d.category.toLowerCase()}`}>{damageLine(d)}</li>
        ))}
        {report.heals.map((h, i) => (
          <li key={`h${i}`} className="log log--heal">
            {NAME[h.target]} healed {h.amount} ({h.source === "LIFESTEAL" ? "Lifesteal" : "Regeneration"})
          </li>
        ))}
        {report.youLost.length > 0 && (
          <li className="log log--discard">AI's Disruption discarded your {report.youLost.map((c) => c.def.name).join(", ")}</li>
        )}
        {report.opponentLostCount > 0 && <li className="log log--discard">Your Disruption discarded {report.opponentLostCount} hidden AI card(s)</li>}
        {report.damage.length === 0 && report.heals.length === 0 && <li className="log muted">No damage this turn</li>}
      </ul>
      <p className="summary__hp">
        After turn: You {report.hpAfter.HUMAN} HP · AI {report.hpAfter.AI} HP
      </p>
    </section>
  );
}
