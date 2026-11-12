import type { DrawResult, Status } from "../../../server/src/engine/types";

const STATUS_LABEL: Record<Status["kind"], string> = {
  POISON: "Poison",
  REGENERATION: "Regeneration",
  UNBLOCKABLE: "Unstoppable",
  REFLECT: "Reflection",
  LIFESTEAL: "Lifesteal",
};

export function StatusChips({ statuses }: { statuses: Status[] }) {
  if (statuses.length === 0) return null;
  return (
    <div className="chips">
      {statuses.map((s) => (
        <span key={s.kind} className={`chip chip--${s.kind.toLowerCase()}`} title={`${s.remaining} turn(s) remaining incl. this one`}>
          {STATUS_LABEL[s.kind]}
          {s.amount ? ` ${s.amount}` : ""} · {s.remaining}t
        </span>
      ))}
    </div>
  );
}

export function HpBar({ hp, max }: { hp: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));
  const tone = pct > 50 ? "ok" : pct > 25 ? "warn" : "low";
  return (
    <div className="hp" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={hp} aria-label="HP">
      <div className={`hp__fill hp__fill--${tone}`} style={{ width: `${pct}%` }} />
      <span className="hp__label">
        {Math.max(0, hp)} / {max} HP
      </span>
    </div>
  );
}

export function drawNotice(d: DrawResult | null, who: "You" | "AI"): string | null {
  if (d === "HAND_FULL") return `${who === "You" ? "Your" : "AI"} hand is full (7) — draw skipped`;
  if (d === "DECK_EMPTY") return `${who === "You" ? "Your" : "AI"} deck is empty — draw skipped`;
  return null;
}
