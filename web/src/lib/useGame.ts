import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../../server/src/protocol";
import type { CardDefinition, PlayerView } from "../../../server/src/engine/types";

const TOKEN_KEY = "ritarena-cardbattle-token";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — resume just won't work */
  }
}

export type Connection = "connecting" | "open" | "closed";

export function useGame() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [view, setView] = useState<PlayerView | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // welcome received and resume attempted
  const [catalog, setCatalog] = useState<CardDefinition[]>([]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => setConnection("open");
      ws.onclose = () => {
        setConnection("closed");
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (evt) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "welcome": {
            setCatalog(msg.catalog);
            const token = readToken();
            if (token) ws.send(JSON.stringify({ type: "resume", token } satisfies ClientMessage));
            else setReady(true);
            break;
          }
          case "session":
            writeToken(msg.token);
            break;
          case "no-session":
            writeToken(null);
            setView(null);
            setReady(true);
            break;
          case "state":
            setView(msg.view);
            setDeadline(msg.deadline);
            setReady(true);
            break;
          case "error":
            setError(msg.message);
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else setError("Not connected to the server");
  }, []);

  return {
    connection,
    ready,
    catalog,
    view,
    deadline,
    error,
    clearError: () => setError(null),
    newMatch: () => send({ type: "new-match" }),
    commit: (turn: number, cards: string[]) => send({ type: "commit", turn, cards }),
  };
}
