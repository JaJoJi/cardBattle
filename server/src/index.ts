import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@ritarena/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { loadChainConfig } from "./chain/config";
import { ArenaHouse, USDC } from "./chain/house";
import { OnChainMatch } from "./chain/onchainMatch";
import { CARD_CATALOG } from "./engine/cards";
import { MatchSession } from "./session";
import type { ClientMessage, PlayMode, ServerConfig, ServerMessage } from "./protocol";

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/dist");
const SESSION_IDLE_MS = 30 * 60_000;
/** Allowed on-chain stakes (USDC). Must match the tiers shown in the web client. */
const STAKE_TIERS_USDC = [1, 5, 25, 100];

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// --- chain ---
const chain = loadChainConfig();
const house = chain.enabled && chain.house ? new ArenaHouse(new Connection(chain.rpcUrl, "confirmed"), chain.house) : null;
const serverConfig: ServerConfig = {
  chainEnabled: !!house,
  chainDisabledReason: chain.reason,
  cluster: chain.cluster,
  rpcUrl: chain.rpcUrl,
  house: house?.publicKey.toBase58(),
  programId: PROGRAM_ID.toBase58(),
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

let vaultCache: { at: number; body: unknown } | null = null;
async function vaultSnapshot() {
  if (!house) return { enabled: false, reason: chain.reason };
  if (vaultCache && Date.now() - vaultCache.at < 15_000) return vaultCache.body;
  const [balances, recent] = await Promise.all([house.balances(), house.recentArenas().catch(() => [])]);
  const body = {
    enabled: true,
    cluster: chain.cluster,
    house: house.publicKey.toBase58(),
    programId: PROGRAM_ID.toBase58(),
    houseSol: balances.sol,
    houseUsdc: balances.usdc,
    liveMatches: [...games.values()].filter((g) => g.chain && ["awaiting-entry", "starting", "playing", "finalizing"].includes(g.chain.status.phase)).length,
    stakeTiers: STAKE_TIERS_USDC,
    recentArenas: recent,
  };
  vaultCache = { at: Date.now(), body };
  return body;
}

// --- HTTP: API + static web client (production build) ---
const http = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/api/vault") {
    vaultSnapshot()
      .then((b) => json(res, 200, b))
      .catch((e) => json(res, 502, { enabled: true, error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  let file = normalize(join(WEB_DIST, urlPath));
  if (!file.startsWith(WEB_DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Web client not built. Run `npm run build` or use `npm run dev`.");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

// --- games (a mock session, or a session wrapped by an on-chain match) ---
interface Game {
  token: string;
  mode: PlayMode;
  session: MatchSession;
  chain?: OnChainMatch;
}
const games = new Map<string, Game>();
const sockets = new Map<Game, Set<WebSocket>>();
const gameOfSession = new Map<MatchSession, Game>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(game: Game, msg: ServerMessage) {
  for (const ws of sockets.get(game) ?? []) send(ws, msg);
}
function pushState(game: Game) {
  const { view, deadline } = game.session.humanView();
  broadcast(game, { type: "state", view, deadline });
}
function pushChain(game: Game) {
  if (game.chain) broadcast(game, { type: "chain", status: game.chain.status });
}

function attach(ws: WebSocket, game: Game) {
  if (!sockets.has(game)) sockets.set(game, new Set());
  sockets.get(game)!.add(ws);
  send(ws, { type: "session", token: game.token, mode: game.mode });
  if (game.chain) send(ws, { type: "chain", status: game.chain.status });
  const { view, deadline } = game.session.humanView();
  send(ws, { type: "state", view, deadline });
}

function closeGame(g: Game) {
  g.chain ? g.chain.dispose() : g.session.dispose();
  games.delete(g.token);
  sockets.delete(g);
  gameOfSession.delete(g.session);
}

function createGame(msg: Extract<ClientMessage, { type: "new-match" }>): Game | string {
  const onSessionChange = (s: MatchSession) => {
    const g = gameOfSession.get(s);
    if (g) pushState(g);
  };
  if (msg.mode !== "chain") {
    const session = new MatchSession(onSessionChange);
    return { token: session.token, mode: "mock", session };
  }
  if (!house) return `On-chain mode is unavailable: ${chain.reason ?? "not configured"}`;
  if (!STAKE_TIERS_USDC.includes((msg.stakeMicro ?? 0) / USDC)) return "Invalid stake tier";
  let player: PublicKey;
  try {
    player = new PublicKey(String(msg.player));
  } catch {
    return "Connect a wallet first";
  }
  if (player.equals(house.publicKey)) return "The house wallet cannot play against itself";
  const holder: { game?: Game } = {};
  const match = new OnChainMatch(house, player, msg.stakeMicro!, () => holder.game && pushChain(holder.game), onSessionChange);
  holder.game = { token: match.session.token, mode: "chain", session: match.session, chain: match };
  void match.begin();
  return holder.game;
}

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (ws) => {
  let game: Game | null = null;
  send(ws, { type: "welcome", catalog: Object.values(CARD_CATALOG), config: serverConfig });

  const detach = () => {
    if (game) sockets.get(game)?.delete(ws);
  };

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: "error", message: "Malformed message" });
    }

    if (msg.type === "resume") {
      const found = typeof msg.token === "string" ? games.get(msg.token) : undefined;
      if (!found) return send(ws, { type: "no-session" });
      detach();
      game = found;
      attach(ws, game);
    } else if (msg.type === "new-match") {
      const created = createGame(msg);
      if (typeof created === "string") return send(ws, { type: "error", message: created });
      detach();
      // Abandon a previous unfinished *mock* match; staked matches keep running so they settle.
      if (game && !game.chain) closeGame(game);
      game = created;
      games.set(game.token, game);
      gameOfSession.set(game.session, game);
      attach(ws, game);
    } else if (msg.type === "commit") {
      if (!game) return send(ws, { type: "error", message: "No active match" });
      const r = game.session.commitHuman(msg.turn, msg.cards);
      if (!r.ok) send(ws, { type: "error", message: r.reason });
      else pushState(game);
    } else if (msg.type === "chain-entered") {
      void game?.chain?.checkEntry();
    } else if (msg.type === "chain-cancel") {
      void game?.chain?.cancelByPlayer();
    } else {
      send(ws, { type: "error", message: "Unknown message" });
    }
  });

  ws.on("close", detach);
});

// Drop idle games so abandoned matches don't accumulate. Staked matches are kept
// until they reach a terminal chain phase so settlement always completes.
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    const connected = (sockets.get(g)?.size ?? 0) > 0;
    const chainBusy = g.chain && !["settled", "cancelled", "failed"].includes(g.chain.status.phase);
    if (!connected && !chainBusy && now - g.session.lastActivity > SESSION_IDLE_MS) closeGame(g);
  }
}, 60_000).unref();

http.listen(PORT, () => {
  console.log(`RitArena Card Battle server on http://localhost:${PORT} (ws: /ws)`);
  console.log(house ? `On-chain mode: ${chain.cluster}, house ${house.publicKey.toBase58()}` : `On-chain mode disabled: ${chain.reason}`);
});
