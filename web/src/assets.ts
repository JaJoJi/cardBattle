// Image paths for art that will be pushed later. Drop files into web/public/ with
// these names; until then every <Art> falls back to a styled placeholder.
export const cardArt = (cardId: string) => `/cards/${cardId}.png`;
export const CARD_BACK = "/cards/back.png";
export const AVATAR = { HUMAN: "/avatars/player.png", AI: "/avatars/ai.png" } as const;
export const VAULT_EMBLEM = "/vault/emblem.png";
