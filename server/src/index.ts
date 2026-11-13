import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@ritarena/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { ChallengeStore, RateLimiter } from "./chain/auth";
import { loadChainConfig } from "./chain/config";
import { MatchStore } from "./chain/store";
import { MatchVrf, loadVrfIdl } from "./chain/vrf";
import { ProfileStore } from "./ai/profiles";
import { ArenaHouse } from "./chain/house";
import { OnChainMatch } from "./chain/onchainMatch";
import { CARD_CATALOG } from "./engine/cards";
import { MatchSession } from "./session";
import type { ClientMessage, OpponentInfo, PlayMode, ServerConfig, ServerMessage } from "./protocol";
import { ArenaBook } from "./arena/book";
import { llmClient } from "./ai/llm/llmAi";
import { LLM_MODELS, llmVersionOf, modelById, modelByVersion } from "./ai/llm/models";

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/dist");
const SESSION_IDLE_MS = 30 * 60_000;

// Abuse limits for staked matches (each one costs the house SOL for account rent).
const LIMITS = {
  matchesPerIpPerHour: 6,
  matchesPerWalletPerHour: 6,
  maxOpenArenas: 20, // creating / awaiting-entry / starting, across all players
  minHouseSol: 0.05,
  wsMaxPayloadBytes: 16 * 1024,
  wsMessagesPer10s: 40,
  challengesPerConnPerMin: 10,
  terminalSnapshotRetentionMs: 7 * 24 * 3600_000,
  /** Every LLM challenge spends real API credit, even though devnet USDC is free. */
  challengesPerWalletPerDay: 10,
  /** A champion only accepts challenges while the API budget covers this many of its matches. */
  budgetMatchesHeadroom: 3,
};
/** Only trust X-Forwarded-For when explicitly running behind a proxy. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

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
/** MagicBlock VRF seeding for staked matches — only when the cardbattle_vrf program is configured. */
const vrf = (() => {
  if (!house || !chain.vrfProgramId) return null;
  try {
    const idl = loadVrfIdl();
    if ((idl as { address?: string }).address !== chain.vrfProgramId) {
      console.error(`[vrf] IDL address ${(idl as { address?: string }).address} != CARDBATTLE_VRF_PROGRAM_ID ${chain.vrfProgramId} — VRF disabled`);
      return null;
    }
    return new MatchVrf(house.connection, chain.house!, idl);
  } catch (e) {
    console.error(`[vrf] disabled: ${(e as Error).message}`);
    return null;
  }
})();
const serverConfig: ServerConfig = {
  chainEnabled: !!house,
  chainDisabledReason: chain.reason,
  cluster: chain.cluster,
  rpcUrl: chain.rpcUrl,
  house: house?.publicKey.toBase58(),
  programId: PROGRAM_ID.toBase58(),
  vrfProgramId: vrf?.programId.toBase58(),
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

let houseSolCache: { at: number; sol: number } | null = null;
async function houseSol(): Promise<number> {
  if (houseSolCache && Date.now() - houseSolCache.at < 15_000) return houseSolCache.sol;
  const sol = (await house!.balances()).sol;
  houseSolCache = { at: Date.now(), sol };
  return sol;
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
    recentArenas: recent,
  };
  vaultCache = { at: Date.now(), body };
  return body;
}

// --- arena: LLM champions, bounties, prices ---
const book = new ArenaBook();
/** Seed cost estimates from the benchmark script until real human matches replace them. */
(function seedCostsFromBenchmark() {
  const file = join(fileURLToPath(new URL(".", import.meta.url)), "../data/llm-benchmark.json");
  if (!existsSync(file)) return;
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as { model: string; costUsd: number; opponent: string; seed: string; outcome: string }[];
    const n = book.applyBenchmark(rows);
    if (n) console.log(`[arena] folded ${n} seed-benchmark game(s) into Elo`);
    for (const m of LLM_MODELS) {
      if (book.raw(m.id).recentCostUsd.length) continue;
      for (const r of rows.filter((x) => x.model === m.id)) book.addCostSample(m.id, r.costUsd);
    }
  } catch (e) {
    console.error(`[arena] could not read benchmark: ${(e as Error).message}`);
  }
})();

/** Why a champion can't take a challenge right now (null = available). */
function unavailable(model: string): string | null {
  const client = llmClient();
  if (!client) return "No OpenRouter key configured";
  const need = book.card(model).avgCostUsd * LIMITS.budgetMatchesHeadroom;
  if (client.guard.remainingUsd < need) return "Resting — today's API budget is used up";
  return null;
}

function arenaSnapshot() {
  const guard = llmClient()?.guard;
  return {
    models: book.leaderboard().map((c) => ({ ...c, unavailable: unavailable(c.id) })),
    budget: guard ? { spentUsd: guard.spentUsd, remainingUsd: guard.remainingUsd, capUsd: guard.capUsd, dailyCapUsd: guard.dailyCapUsd } : null,
    chainEnabled: !!house,
  };
}

// --- HTTP: API + static web client (production build) ---
const http = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/api/arena") {
    json(res, 200, arenaSnapshot());
    return;
  }
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

const challenges = new ChallengeStore();
const ipLimiter = new RateLimiter(LIMITS.matchesPerIpPerHour, 3600_000);
const walletLimiter = new RateLimiter(LIMITS.matchesPerWalletPerHour, 3600_000);
const walletDailyLimiter = new RateLimiter(LIMITS.challengesPerWalletPerDay, 24 * 3600_000);
const store = house ? new MatchStore() : null;
/** Per-wallet play patterns (revealed plays only) the AI learns across staked matches. */
const profiles = house ? new ProfileStore() : null;

function recordProfile(g: Game) {
  if (!profiles || !g.chain || !g.session.finished) return;
  try {
    profiles.record(g.chain.player.toBase58(), g.session.matchId, g.session.aiObservations());
  } catch (e) {
    console.error(`[profiles] ${(e as Error).message}`);
  }
}

function persist(g: Game) {
  if (!store || !g.chain) return;
  try {
    store.save(g.chain.snapshot());
  } catch (e) {
    console.error(`[store] failed to save ${g.token}: ${(e as Error).message}`);
  }
}

const PRE_PLAY = ["creating", "awaiting-entry", "starting"];
const openStakedMatchFor = (wallet: string) =>
  [...games.values()].find((g) => g.chain && !g.chain.terminal && g.chain.player.toBase58() === wallet);

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(game: Game, msg: ServerMessage) {
  for (const ws of sockets.get(game) ?? []) send(ws, msg);
}
function opponentInfo(s: MatchSession): OpponentInfo {
  const m = modelByVersion(s.versions.ai);
  if (!m) return { model: "bot", name: "House Bot", thinking: false };
  return { model: m.id, name: m.name, thinking: s.aiThinking, thoughts: (s.revealedAiThoughts() as OpponentInfo["thoughts"]) ?? undefined };
}
function stateMsg(game: Game): ServerMessage {
  const { view, deadline } = game.session.humanView();
  return { type: "state", view, deadline, opponent: opponentInfo(game.session) };
}
function pushState(game: Game) {
  broadcast(game, stateMsg(game));
}

/** Books a challenge's result (or releases its reservation) once its chain phase is final. */
function bookkeep(g: Game) {
  if (!g.chain?.status.opponent) return;
  const phase = g.chain.status.phase;
  const id = g.session.matchId;
  if (phase === "cancelled") book.release(id);
  else if (phase === "settled") {
    const o = g.session.outcome.outcome;
    book.settle(id, g.chain.status.winner ?? "HOUSE", o === "HUMAN" ? "PLAYER" : o === "AI" ? "MODEL" : "DRAW", g.session.aiCostUsd());
  }
  // "failed" keeps the reservation: funds may still be in escrow until recovered.
}
const onChainUpdate = (holder: { game?: Game }) => () => {
  if (!holder.game) return;
  pushChain(holder.game);
  persist(holder.game);
  bookkeep(holder.game);
};
function pushChain(game: Game) {
  if (game.chain) broadcast(game, { type: "chain", status: game.chain.status });
}

function attach(ws: WebSocket, game: Game) {
  if (!sockets.has(game)) sockets.set(game, new Set());
  sockets.get(game)!.add(ws);
  send(ws, { type: "session", token: game.token, mode: game.mode });
  if (game.chain) send(ws, { type: "chain", status: game.chain.status });
  send(ws, stateMsg(game));
}

function closeGame(g: Game) {
  g.chain ? g.chain.dispose() : g.session.dispose();
  if (g.chain?.terminal) store?.remove(g.token);
  games.delete(g.token);
  sockets.delete(g);
  gameOfSession.delete(g.session);
}

const onSessionChange = (s: MatchSession) => {
  const g = gameOfSession.get(s);
  if (!g) return;
  pushState(g);
  persist(g); // a resolved turn is recorded before anything else can happen
  if (s.finished) recordProfile(g);
};

function registerGame(g: Game) {
  games.set(g.token, g);
  gameOfSession.set(g.session, g);
}

function chainGame(match: OnChainMatch, holder: { game?: Game }): Game {
  holder.game = { token: match.session.token, mode: "chain", session: match.session, chain: match };
  return holder.game;
}

async function createGame(msg: Extract<ClientMessage, { type: "new-match" }>, ip: string): Promise<Game | string> {
  if (msg.mode !== "chain") {
    const session = new MatchSession(onSessionChange);
    return { token: session.token, mode: "mock", session };
  }
  if (!house) return `On-chain mode is unavailable: ${chain.reason ?? "not configured"}`;
  const model = modelById(String(msg.model));
  if (!model) return "Pick an AI champion to challenge";
  const busy = unavailable(model.id);
  if (busy) return `${model.name}: ${busy}`;
  let player: PublicKey;
  try {
    player = new PublicKey(String(msg.player));
  } catch {
    return "Connect a wallet first";
  }
  if (player.equals(house.publicKey)) return "The house wallet cannot play against itself";
  const quote = book.getQuote(msg.quoteId, player.toBase58());
  if (!quote || quote.model !== model.id) return "Price quote expired — pick the opponent again.";
  const stakeMicro = quote.priceMicro;
  // Proof of wallet ownership (one-time, bound to wallet + price + opponent).
  const auth = challenges.redeem(msg.nonce, player.toBase58(), stakeMicro, msg.signature, model.name);
  if (!auth.ok) return auth.reason;
  const open = openStakedMatchFor(player.toBase58());
  if (open) return `This wallet already has an open staked match (arena #${open.chain!.arenaId ?? "…"}). Finish or cancel it first.`;
  if ([...games.values()].filter((g) => g.chain && PRE_PLAY.includes(g.chain.status.phase)).length >= LIMITS.maxOpenArenas) {
    return "Too many matches are waiting to start right now — try again in a few minutes.";
  }
  if (!ipLimiter.allow(ip) || !walletLimiter.allow(player.toBase58())) return "Too many staked matches started recently — try again later.";
  if (!walletDailyLimiter.allow(player.toBase58())) return `Daily limit reached (${LIMITS.challengesPerWalletPerDay} AI challenges per wallet) — come back tomorrow.`;
  try {
    if ((await houseSol()) < LIMITS.minHouseSol) return "The house wallet is low on SOL for fees — staked matches are paused.";
  } catch {
    return "Could not reach Solana devnet — try again shortly.";
  }
  const holder: { game?: Game } = {};
  const match = new OnChainMatch(
    house,
    player,
    stakeMicro,
    onChainUpdate(holder),
    onSessionChange,
    undefined,
    undefined,
    vrf ?? undefined,
    profiles?.prior(player.toBase58()),
    { model: model.id, name: model.name, aiVersion: llmVersionOf(model), prizeMicro: quote.prizeMicro, topUpMicro: quote.topUpMicro },
  );
  // Nothing has touched the chain yet, so a failed reservation just drops the match.
  const accepted = book.accept(quote.id, player.toBase58(), match.session.matchId);
  if (typeof accepted === "string") {
    match.dispose();
    return accepted;
  }
  const game = chainGame(match, holder);
  void match.begin();
  return game;
}

/** Brings staked matches back after a restart; play resumes from the last recorded turn. */
async function restoreMatches() {
  if (!house || !store) return;
  for (const { snap, file } of store.loadAll()) {
    const terminal = ["settled", "cancelled", "failed"].includes(snap.status.phase);
    if (terminal && Date.now() - snap.savedAt > LIMITS.terminalSnapshotRetentionMs) {
      store.remove(snap.session.token);
      continue;
    }
    try {
      const holder: { game?: Game } = {};
      const match = OnChainMatch.restore(
        house,
        snap,
        onChainUpdate(holder),
        onSessionChange,
        undefined,
        vrf ?? undefined,
      );
      registerGame(chainGame(match, holder));
      console.log(`[restore] arena #${snap.status.arenaId ?? "-"} (${snap.status.phase}, turn ${match.session.humanView().view.turn}) for ${snap.player}`);
      void match.resume();
    } catch (e) {
      console.error(`[restore] could not restore ${file}: ${(e as Error).message}`);
    }
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: LIMITS.wsMaxPayloadBytes });

wss.on("connection", (ws, req) => {
  let game: Game | null = null;
  const ip = clientIp(req);
  const flood = new RateLimiter(LIMITS.wsMessagesPer10s, 10_000);
  const challengeLimit = new RateLimiter(LIMITS.challengesPerConnPerMin, 60_000);
  let creating = false;
  send(ws, { type: "welcome", catalog: Object.values(CARD_CATALOG), config: serverConfig });

  const detach = () => {
    if (game) sockets.get(game)?.delete(ws);
  };

  ws.on("message", async (raw) => {
    if (!flood.allow("x")) {
      send(ws, { type: "error", message: "Slow down" });
      return ws.close(1008, "rate limit");
    }
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
    } else if (msg.type === "chain-challenge") {
      if (!house) return send(ws, { type: "error", message: "On-chain mode is unavailable" });
      if (!challengeLimit.allow("x")) return send(ws, { type: "error", message: "Too many sign-in requests" });
      const model = modelById(String(msg.model));
      if (!model) return send(ws, { type: "error", message: "Unknown AI champion" });
      const busy = unavailable(model.id);
      if (busy) return send(ws, { type: "error", message: `${model.name}: ${busy}` });
      try {
        const player = new PublicKey(String(msg.player)).toBase58();
        const q = book.quote(model.id, player);
        const c = challenges.issue(player, q.priceMicro, model.name);
        send(ws, { type: "chain-challenge", nonce: c.nonce, message: c.message, quote: q });
      } catch {
        send(ws, { type: "error", message: "Invalid wallet address" });
      }
    } else if (msg.type === "new-match") {
      if (creating) return send(ws, { type: "error", message: "A match is already being created" });
      creating = true;
      let created: Game | string;
      try {
        created = await createGame(msg, ip);
      } finally {
        creating = false;
      }
      if (typeof created === "string") return send(ws, { type: "error", message: created });
      detach();
      // Abandon a previous unfinished *mock* match; staked matches keep running so they settle.
      if (game && !game.chain) closeGame(game);
      game = created;
      registerGame(game);
      persist(game);
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

// A stray rejection from an RPC client (e.g. a 429 inside a subscription) must not take
// down the server and every live match with it.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason instanceof Error ? reason.message : reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err.message));

void restoreMatches();

http.listen(PORT, () => {
  console.log(`RitArena Card Battle server on http://localhost:${PORT} (ws: /ws)`);
  console.log(house ? `On-chain mode: ${chain.cluster}, house ${house.publicKey.toBase58()}` : `On-chain mode disabled: ${chain.reason}`);
  if (house) console.log(vrf ? `Randomness: MagicBlock VRF via ${vrf.programId.toBase58()}` : "Randomness: server seed commit-reveal (set CARDBATTLE_VRF_PROGRAM_ID for MagicBlock VRF)");
});
