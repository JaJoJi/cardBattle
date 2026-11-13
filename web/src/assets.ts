// Image paths for art that will be pushed later. Drop files into web/public/ with
// these names; until then every <Art> falls back to a styled placeholder.
export const cardArt = (cardId: string) => `/cards/${cardId}.png`;
export const CARD_BACK = "/cards/back.png";
export const AVATAR = { HUMAN: "/avatars/player.png", AI: "/avatars/ai.png" } as const;
export const VAULT_EMBLEM = "/vault/emblem.png";

/** LLM champion logos by OpenRouter model id (files in public/logos). */
export const LLM_LOGOS: Record<string, string> = {
  "deepseek/deepseek-v4.1-flash-1017": "/logos/deepseek.png",
  "tencent/hy4": "/logos/tencent.png",
  "z-ai/glm-5.3-flash": "/logos/zai.png",
  "openai/gpt-6-luna": "/logos/openai.png",
  "anthropic/claude-opus-5.5": "/logos/anthropic.png",
};
