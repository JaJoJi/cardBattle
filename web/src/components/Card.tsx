import type { CardDefinition } from "../../../server/src/engine/types";

const TYPE_LABEL = { ATTACK: "Attack", DEFENSE: "Defense", SPELL: "Spell" } as const;

interface Props {
  def: CardDefinition;
  size?: "full" | "mini";
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function Card({ def, size = "full", selected, disabled, onClick }: Props) {
  const cls = ["card", `card--${def.type.toLowerCase()}`, `card--${size}`, selected && "is-selected", disabled && "is-disabled", onClick && "is-clickable"]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      <span className="card__cost" aria-label={`Cost ${def.cost}`}>{def.cost}</span>
      <span className="card__type">{TYPE_LABEL[def.type]}</span>
      <span className="card__name">{def.name}</span>
      {size === "full" && <span className="card__desc">{def.description}</span>}
    </>
  );
  if (!onClick) return <div className={cls} title={def.description}>{content}</div>;
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-pressed={selected} title={def.description}>
      {content}
    </button>
  );
}

export function CardBack({ count }: { count: number }) {
  return (
    <div className="card-backs" aria-label={`${count} cards in hand`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="card-back" />
      ))}
      {count === 0 && <span className="muted">no cards</span>}
    </div>
  );
}
