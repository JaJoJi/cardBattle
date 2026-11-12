import { useEffect } from "react";
import type { Side, TurnReportView } from "../../../server/src/engine/types";
import { ReportLines } from "./BattleLog";
import { GameCard } from "./GameCard";

export function RevealOverlay({ report, onClose }: { report: TurnReportView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" || e.key === "Enter") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lane = (side: Side) => (
    <div className={`reveal__lane reveal__lane--${side.toLowerCase()}`}>
      <span className="reveal__who">{side === "AI" ? "Arena AI" : "You"}</span>
      <div className="reveal__cards">
        {report.played[side].length === 0 ? (
          <span className="reveal__pass">Pass</span>
        ) : (
          report.played[side].map((c, i) => (
            <div key={c.uid} className="flip" style={{ animationDelay: `${(side === "AI" ? 0 : 0.25) + i * 0.12}s` }}>
              <GameCard def={c.def} size="md" />
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="reveal-title" onClick={onClose}>
      <div className="reveal" onClick={(e) => e.stopPropagation()}>
        <h2 id="reveal-title" className="reveal__title">Turn {report.turn} — Reveal</h2>
        {lane("AI")}
        <div className="reveal__vs">VS</div>
        {lane("HUMAN")}
        <ReportLines report={report} />
        <p className="reveal__hp">
          You <strong>{Math.max(0, report.hpAfter.HUMAN)}</strong> HP · AI <strong>{Math.max(0, report.hpAfter.AI)}</strong> HP
        </p>
        <button className="btn btn--gold" onClick={onClose} autoFocus>
          Continue
        </button>
      </div>
    </div>
  );
}
