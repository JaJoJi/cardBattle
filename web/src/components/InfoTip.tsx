import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InfoIcon } from "./icons";

/**
 * A small ⓘ button that reveals details on click (and hover on desktop). Keeps long
 * explanations off the page until someone asks. Closes on outside click or Escape.
 */
export function InfoTip({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className={`infotip ${open ? "is-open" : ""}`} ref={ref}>
      <button type="button" className="infotip__btn" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <InfoIcon />
      </button>
      <span id={id} role="tooltip" className={`infotip__pop infotip__pop--${align}`}>
        {children}
      </span>
    </span>
  );
}
