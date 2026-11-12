import { useCallback, useEffect, useState } from "react";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";

/** Minimal shape of Phantom's injected provider (window.phantom.solana). */
interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<{ signature: Uint8Array }>;
  on(event: "accountChanged" | "disconnect" | "connect", cb: (arg?: unknown) => void): void;
  off?(event: string, cb: (arg?: unknown) => void): void;
}

export function getPhantom(): PhantomProvider | null {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

/** Anchor-compatible wallet backed by Phantom (signing happens in the Phantom popup). */
export interface BrowserWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  /** Off-chain message signature (no transaction, no fee). */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export function useWallet() {
  const [provider] = useState(getPhantom);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    // Reconnect silently if the user already trusted this site.
    provider.connect({ onlyIfTrusted: true }).then((r) => setAddress(r.publicKey.toString())).catch(() => {});
    const onChange = (pk?: unknown) => setAddress(pk ? String(pk) : null);
    const onDisconnect = () => setAddress(null);
    provider.on("accountChanged", onChange);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.off?.("accountChanged", onChange);
      provider.off?.("disconnect", onDisconnect);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    setError(null);
    if (!provider) {
      window.open("https://phantom.app/", "_blank", "noopener");
      return;
    }
    try {
      const r = await provider.connect();
      setAddress(r.publicKey.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection was rejected");
    }
  }, [provider]);

  const disconnect = useCallback(async () => {
    await provider?.disconnect().catch(() => {});
    setAddress(null);
  }, [provider]);

  const wallet: BrowserWallet | null =
    provider && address
      ? {
          publicKey: new PublicKey(address),
          signTransaction: (tx) => provider.signTransaction(tx),
          signAllTransactions: (txs) => provider.signAllTransactions(txs),
          signMessage: async (msg) => (await provider.signMessage(msg, "utf8")).signature,
        }
      : null;

  return { available: !!provider, address, wallet, connect, disconnect, error };
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
