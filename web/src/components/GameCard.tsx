import type { CSSProperties } from "react";
import type { CardDefinition } from "../../../server/src/engine/types";
import { CARD_BACK, cardArt } from "../assets";
import { Art } from "./Art";
import { ShieldIcon, SwordIcon, TypeIcon } from "./icons";

const TYPE_LABEL = { ATTACK: "Attack", DEFENSE: "Defense", SPELL: "Spell" } as const;

/** Headline number for the corner badge: damage if the card deals any, else Block. */
function statOf(def: CardDefinition): { icon: "sword" | "shield"; value: number } | null {
  const dmg = def.effects.reduce((s, e) => s + (e.kind === "DAMAGE" ? e.amount : 0), 0);
  if (dmg > 0) return { icon: "sword", value: dmg };
  const block = def.effects.reduce((s, e) => s + (e.kind === "GAIN_BLOCK" ? e.amount : 0), 0);
  if (block > 0) return { icon: "shield", value: block };
  return null;
}

interface Props {
  def: CardDefinition;
  size?: "lg" | "md" | "sm";
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
  className?: string;
}

export function GameCard({ def, size = "md", selected, disabled, onClick, style, className }: Props) {
  const stat = statOf(def);
  const cls = ["gcard", `gcard--${def.type.toLowerCase()}`, `gcard--${size}`, selected && "is-selected", disabled && "is-disabled", onClick && "is-clickable", className]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="gcard__frame" />
      <span className="gcard__cost" aria-label={`Cost ${def.cost}`}>{def.cost}</span>
      <Art className="gcard__art" src={cardArt(def.id)} alt={def.name} fallback={<span className="gcard__glyph"><TypeIcon type={def.type} /></span>} />
      <span className="gcard__name">{def.name}</span>
      <span className="gcard__type">
        <TypeIcon type={def.type} /> {TYPE_LABEL[def.type]}
      </span>
      {size !== "sm" && <span className="gcard__text">{def.description}</span>}
      {stat && (
        <span className={`gcard__stat gcard__stat--${stat.icon}`}>
          {stat.icon === "sword" ? <SwordIcon /> : <ShieldIcon />}
          {stat.value}
        </span>
      )}
    </>
  );

  if (!onClick) {
    return <div className={cls} style={style} title={`${def.name} — ${def.description}`}>{body}</div>;
  }
  return (
    <button type="button" className={cls} style={style} onClick={onClick} disabled={disabled} aria-pressed={!!selected} title={`${def.name} — ${def.description}`}>
      {body}
    </button>
  );
}

export function CardBack({ size = "sm", style, className }: { size?: "lg" | "md" | "sm" | "xs"; style?: CSSProperties; className?: string }) {
  return (
    <div className={`gcard gcard--back gcard--${size} ${className ?? ""}`} style={style} aria-hidden>
      <Art className="gcard__backart" src={CARD_BACK} alt="" fallback={<span className="gcard__backmark">◆</span>} />
    </div>
  );
}
