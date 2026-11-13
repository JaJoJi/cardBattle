// Formatting helpers (the mock vault and stake tiers were replaced by the LLM champion arena).
export const usdc = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
