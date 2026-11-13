import type { Side, Status, TurnReportView } from "../../../server/src/engine/types";
import { StatusChips } from "./Hud";

const STATUS_NAME: Record<Status["kind"], string> = {
  POISON: "Poison",
  REGENERATION: "Regeneration",
  UNBLOCKABLE: "Unstoppable",
  REFLECT: "Reflection",
  LIFESTEAL: "Lifesteal",
};

/** One side's line: HP before → after, then the statuses it received this turn. */
function SideRow({ report, side, name, compact }: { report: TurnReportView; side: Side; name: string; compact?: boolean }) {
  const before = Math.max(0, report.hpBefore[side]);
  const after = Math.max(0, report.hpAfter[side]);
  const delta = after - before;
  const applied = report.statusesApplied[side];
  return (
    <div className={`round-row ${compact ? "round-row--compact" : ""}`}>
      <span className="round-row__who">{name}</span>
      <span className="round-row__hp" aria-label={`${name} HP ${before} to ${after}`}>
        <span className="muted">{before}</span>
        <span className="round-row__arrow">→</span>
        <strong>{after}</strong>
        <span className={`round-row__delta ${delta < 0 ? "is-dmg" : delta > 0 ? "is-heal" : ""}`}>{delta === 0 ? "±0" : delta > 0 ? `+${delta}` : delta}</span>
      </span>
      {!compact && (
        <span className="round-row__status">
          {applied.length ? (
            applied.map((s, i) => (
              <span key={i} className={`chip chip--${s.kind.toLowerCase()}`} title={`${s.remaining} turn(s)`}>
                + {STATUS_NAME[s.kind]}
                {s.amount ? ` ${s.amount}` : ""}
                <span className="chip__turns">{s.remaining}</span>
              </span>
            ))
          ) : (
            <span className="muted small">no new effects</span>
          )}
        </span>
      )}
      {compact && applied.length > 0 && (
        <span className="round-row__status small">+ {applied.map((s) => STATUS_NAME[s.kind]).join(", ")}</span>
      )}
    </div>
  );
}

/** Per-round result: HP before → after for both sides, statuses applied, and what stays active. */
export function RoundSummary({ report, oppName, compact }: { report: TurnReportView; oppName: string; compact?: boolean }) {
  const active = (side: Side) => report.statusesAfter[side];
  return (
    <div className={`round-summary ${compact ? "round-summary--compact" : ""}`}>
      <SideRow report={report} side="AI" name={oppName} compact={compact} />
      <SideRow report={report} side="HUMAN" name="You" compact={compact} />
      {!compact && (active("AI").length > 0 || active("HUMAN").length > 0) && (
        <div className="round-summary__active">
          <span className="muted small">Still in effect next turn</span>
          {(["AI", "HUMAN"] as Side[]).map((s) =>
            active(s).length ? (
              <div key={s} className="round-summary__active-row">
                <span className="small">{s === "AI" ? oppName : "You"}</span>
                <StatusChips statuses={active(s)} />
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
