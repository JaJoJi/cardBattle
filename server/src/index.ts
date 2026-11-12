import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { CARD_CATALOG } from "./engine/cards";
import { MatchSession } from "./session";
import type { ClientMessage, ServerMessage } from "./protocol";

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/dist");
const SESSION_IDLE_MS = 30 * 60_000;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// --- static web client (production build) ---
const http = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
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

// --- sessions ---
const sessions = new Map<string, MatchSession>();
const sockets = new Map<MatchSession, Set<WebSocket>>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function pushState(session: MatchSession) {
  const { view, deadline } = session.humanView();
  for (const ws of sockets.get(session) ?? []) send(ws, { type: "state", view, deadline });
}

function attach(ws: WebSocket, session: MatchSession) {
  if (!sockets.has(session)) sockets.set(session, new Set());
  sockets.get(session)!.add(ws);
  send(ws, { type: "session", token: session.token });
  const { view, deadline } = session.humanView();
  send(ws, { type: "state", view, deadline });
}

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (ws) => {
  let session: MatchSession | null = null;
  send(ws, { type: "welcome", catalog: Object.values(CARD_CATALOG) });

  const detach = () => {
    if (session) sockets.get(session)?.delete(ws);
  };

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: "error", message: "Malformed message" });
    }

    if (msg.type === "resume") {
      const found = typeof msg.token === "string" ? sessions.get(msg.token) : undefined;
      if (!found) return send(ws, { type: "no-session" });
      detach();
      session = found;
      attach(ws, session);
    } else if (msg.type === "new-match") {
      detach();
      if (session) closeSession(session);
      session = new MatchSession(pushState);
      sessions.set(session.token, session);
      attach(ws, session);
    } else if (msg.type === "commit") {
      if (!session) return send(ws, { type: "error", message: "No active match" });
      const r = session.commitHuman(msg.turn, msg.cards);
      if (!r.ok) send(ws, { type: "error", message: r.reason });
      else pushState(session);
    } else {
      send(ws, { type: "error", message: "Unknown message" });
    }
  });

  ws.on("close", detach);
});

function closeSession(s: MatchSession) {
  s.dispose();
  sessions.delete(s.token);
  sockets.delete(s);
}

// Drop idle sessions so abandoned matches don't accumulate.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    const connected = (sockets.get(s)?.size ?? 0) > 0;
    if (!connected && now - s.lastActivity > SESSION_IDLE_MS) closeSession(s);
  }
}, 60_000).unref();

http.listen(PORT, () => {
  console.log(`RitArena Card Battle server on http://localhost:${PORT} (ws: /ws)`);
});
