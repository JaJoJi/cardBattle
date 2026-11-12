import { useEffect, useRef, useState } from "react";
import type { Side, Status } from "../../../server/src/engine/types";
import { AVATAR } from "../assets";
import { Art } from "./Art";
import { BotIcon, UserIcon } from "./icons";

const STATUS_LABEL: Record<Status["kind"], string> = {
  POISON: "Poison",
  REGENERATION: "Regen",
  UNBLOCKABLE: "Unstoppable",
  REFLECT: "Reflect",
  LIFESTEAL: "Lifesteal",
};

export function StatusChips({ statuses }: { statuses: Status[] }) {
  if (statuses.length === 0) return null;
  return (
    <div className="chips">
      {statuses.map((s) => (
        <span key={s.kind} className={`chip chip--${s.kind.toLowerCase()}`} title={`${s.remaining} turn(s) remaining incl. this one`}>
          {STATUS_LABEL[s.kind]}
          {s.amount ? ` ${s.amount}` : ""}
          <span className="chip__turns">{s.remaining}</span>
        </span>
      ))}
    </div>
  );
}

export function Portrait({ side }: { side: Side }) {
  return (
    <Art
      className={`portrait portrait--${side.toLowerCase()}`}
      src={AVATAR[side]}
      alt={side === "AI" ? "Arena AI" : "You"}
      fallback={<span className="portrait__glyph">{side === "AI" ? <BotIcon /> : <UserIcon />}</span>}
    />
  );
}

/** HP orb with a floating delta whenever HP changes. */
export function HpOrb({ hp, max }: { hp: number; max: number }) {
  const prev = useRef(hp);
  const [delta, setDelta] = useState<{ v: number; key: number } | null>(null);
  useEffect(() => {
    if (hp !== prev.current) setDelta({ v: hp - prev.current, key: Date.now() });
    prev.current = hp;
  }, [hp]);
  const pct = Math.max(0, Math.min(1, hp / max));
  const tone = pct > 0.5 ? "ok" : pct > 0.25 ? "warn" : "low";
  return (
    <div className={`orb orb--${tone}`} style={{ ["--pct" as string]: `${pct * 100}%` }} role="meter" aria-label="HP" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.max(0, hp)}>
      <span className="orb__value">{Math.max(0, hp)}</span>
      <span className="orb__max">/ {max}</span>
      {delta && delta.v !== 0 && (
        <span key={delta.key} className={`orb__delta ${delta.v < 0 ? "is-dmg" : "is-heal"}`}>
          {delta.v > 0 ? `+${delta.v}` : delta.v}
        </span>
      )}
    </div>
  );
}

export function EnergyCrystals({ total, available, max }: { total: number; available: number; max: number }) {
  return (
    <div className="crystals" aria-label={`Energy ${available} of ${total}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`crystal ${i < available ? "is-on" : i < total ? "is-spent" : ""}`} />
      ))}
      <span className="crystals__label">
        {available}/{total}
      </span>
    </div>
  );
}

export function DeckPile({ count, label }: { count: number; label: string }) {
  return (
    <div className="pile" title={`${label}: ${count} cards`}>
      <span className="pile__stack" />
      <span className="pile__count">{count}</span>
      <span className="pile__label">{label}</span>
    </div>
  );
}
