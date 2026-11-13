import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, OpponentInfo, PlayMode, QuoteView, ServerConfig, ServerMessage } from "../../../server/src/protocol";
import type { ChainStatus } from "../../../server/src/chain/types";
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
  const challengeWaiter = useRef<((c: { nonce: string; message: string; quote: QuoteView } | null) => void) | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [view, setView] = useState<PlayerView | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [opponent, setOpponent] = useState<OpponentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // welcome received and resume attempted
  const [catalog, setCatalog] = useState<CardDefinition[]>([]);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [mode, setMode] = useState<PlayMode | null>(null); // mode of the current game
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [errorSeq, setErrorSeq] = useState(0);

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
            setConfig(msg.config);
            const token = readToken();
            if (token) ws.send(JSON.stringify({ type: "resume", token } satisfies ClientMessage));
            else setReady(true);
            break;
          }
          case "session":
            writeToken(msg.token);
            setMode(msg.mode);
            if (msg.mode !== "chain") setChain(null);
            break;
          case "chain":
            setChain(msg.status);
            break;
          case "chain-challenge":
            challengeWaiter.current?.({ nonce: msg.nonce, message: msg.message, quote: msg.quote });
            challengeWaiter.current = null;
            break;
          case "no-session":
            writeToken(null);
            setView(null);
            setChain(null);
            setMode(null);
            setReady(true);
            break;
          case "state":
            setView(msg.view);
            setDeadline(msg.deadline);
            setOpponent(msg.opponent ?? null);
            setReady(true);
            break;
          case "error":
            challengeWaiter.current?.(null);
            challengeWaiter.current = null;
            setError(msg.message);
            setErrorSeq((n) => n + 1);
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
    config,
    mode,
    chain,
    errorSeq,
    view,
    deadline,
    opponent,
    error,
    clearError: () => setError(null),
    newMatch: (opts: { mode: PlayMode; model?: string; quoteId?: string; player?: string; nonce?: string; signature?: string } = { mode: "mock" }) =>
      send({ type: "new-match", ...opts }),
    /** Asks the server for a price quote on `model` plus a one-time message to sign for it. */
    requestChallenge: (player: string, model: string) =>
      new Promise<{ nonce: string; message: string; quote: QuoteView } | null>((resolve) => {
        challengeWaiter.current?.(null);
        challengeWaiter.current = resolve;
        send({ type: "chain-challenge", player, model });
        setTimeout(() => {
          if (challengeWaiter.current === resolve) {
            challengeWaiter.current = null;
            resolve(null);
          }
        }, 10_000);
      }),
    chainEntered: () => send({ type: "chain-entered" }),
    chainCancel: () => send({ type: "chain-cancel" }),
    commit: (turn: number, cards: string[]) => send({ type: "commit", turn, cards }),
  };
}
