import type { CardType } from "../../../server/src/engine/types";

const base = { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const SwordIcon = () => (
  <svg {...base}><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="m13 19 6-6" /><path d="m16 16 4 4" /><path d="m19 21 2-2" /></svg>
);
export const ShieldIcon = () => (
  <svg {...base}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
);
export const RuneIcon = () => (
  <svg {...base}><path d="M12 2 4 7v10l8 5 8-5V7z" /><path d="M12 7v10M8.5 9.5l7 5M15.5 9.5l-7 5" /></svg>
);
export const HeartIcon = () => (
  <svg {...base}><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 12 5a5.5 5.5 0 0 0-10 3.5c0 2.3 1.5 4 3 5.5l7 7z" /></svg>
);
export const VaultIcon = () => (
  <svg {...base}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="12" cy="12" r="4" /><path d="M12 8v1M12 15v1M8 12h1M15 12h1M7 20v2M17 20v2" /></svg>
);
export const BotIcon = () => (
  <svg {...base}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></svg>
);
export const UserIcon = () => (
  <svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
export const CheckIcon = () => (
  <svg {...base}><path d="M20 6 9 17l-5-5" /></svg>
);
export const XIcon = () => (
  <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const EqualIcon = () => (
  <svg {...base}><path d="M5 9h14M5 15h14" /></svg>
);
export const LockIcon = () => (
  <svg {...base}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

export const TypeIcon = ({ type }: { type: CardType }) =>
  type === "ATTACK" ? <SwordIcon /> : type === "DEFENSE" ? <ShieldIcon /> : <RuneIcon />;
export const CrownIcon = () => (
  <svg {...base}><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5z" /><path d="M5 19h14" /></svg>
);
export const TrophyIcon = () => (
  <svg {...base}><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /><path d="M12 14v4M8 21h8M9 18h6" /></svg>
);
export const CoinIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5.5" /><path d="M12 9.5v5" /></svg>
);
export const InfoIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><circle cx="12" cy="7.6" r=".6" fill="currentColor" /></svg>
);
export const ChevronIcon = () => (
  <svg {...base}><path d="m6 9 6 6 6-6" /></svg>
);
