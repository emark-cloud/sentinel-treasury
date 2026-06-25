/**
 * Wallet connection (the front door of the depositor flow).
 *
 * Real path: the Casper Wallet browser extension injects `window.CasperWalletProvider`. We connect,
 * read the active public key, and hand the provider to the tx layer (`lib/casper/tx.ts`) to sign a
 * `TransactionV1` for `deposit_cspr` / `deposit_token` / `redeem`.
 *
 * Demo path: when the extension is absent we still let the user "connect" a labelled demo account so
 * the whole onboarding UX — deposit, position, in-kind withdraw — is exercisable on stage without an
 * installed wallet. Demo connections are tagged `demo` and route to the in-memory depositor source;
 * nothing touches the chain (mirrors the spec §15.3 honesty seam). `isReal` distinguishes the two.
 */
'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** Minimal slice of the Casper Wallet provider API we use (docs.cspr.click §8). */
export interface CasperWalletProvider {
  requestConnection(): Promise<boolean>;
  disconnectFromSite(): Promise<boolean>;
  getActivePublicKey(): Promise<string>;
  sign(deployJson: string, signingPublicKeyHex: string): Promise<{ cancelled: boolean; signatureHex?: string }>;
}

declare global {
  interface Window {
    CasperWalletProvider?: () => CasperWalletProvider;
  }
}

export interface WalletState {
  connected: boolean;
  /** Active public key hex (real) or a synthetic `demo-…` key (demo). */
  activeKey: string | null;
  /** True when backed by the Casper Wallet extension; false for a demo connection. */
  isReal: boolean;
  connecting: boolean;
  error: string | null;
}

export interface WalletApi extends WalletState {
  /** Connect the real extension; falls back to a demo account if it is not installed. */
  connect: () => Promise<void>;
  /** Force a demo connection regardless of the extension (the scenario seam). */
  connectDemo: () => void;
  disconnect: () => void;
  /** The live provider when `isReal`, else null (the tx layer guards on this). */
  provider: CasperWalletProvider | null;
}

const WalletContext = createContext<WalletApi | null>(null);

function randomDemoKey(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 'demo-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getExtensionProvider(): CasperWalletProvider | null {
  if (typeof window === 'undefined' || typeof window.CasperWalletProvider !== 'function') return null;
  try {
    return window.CasperWalletProvider();
  } catch {
    return null;
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({
    connected: false,
    activeKey: null,
    isReal: false,
    connecting: false,
    error: null,
  });
  const [provider, setProvider] = useState<CasperWalletProvider | null>(null);

  const connectDemo = useCallback(() => {
    setProvider(null);
    setState({ connected: true, activeKey: randomDemoKey(), isReal: false, connecting: false, error: null });
  }, []);

  const connect = useCallback(async () => {
    const ext = getExtensionProvider();
    if (!ext) {
      // No extension — drop into the demo seam rather than dead-ending the user.
      connectDemo();
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const ok = await ext.requestConnection();
      if (!ok) {
        setState((s) => ({ ...s, connecting: false, error: 'Connection rejected in wallet' }));
        return;
      }
      const key = await ext.getActivePublicKey();
      setProvider(ext);
      setState({ connected: true, activeKey: key, isReal: true, connecting: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, connecting: false, error: e instanceof Error ? e.message : 'Connect failed' }));
    }
  }, [connectDemo]);

  const disconnect = useCallback(() => {
    if (provider) void provider.disconnectFromSite().catch(() => {});
    setProvider(null);
    setState({ connected: false, activeKey: null, isReal: false, connecting: false, error: null });
  }, [provider]);

  // Reflect external account switches from the extension.
  useEffect(() => {
    if (!provider) return;
    const refresh = () => {
      provider
        .getActivePublicKey()
        .then((key) => setState((s) => ({ ...s, activeKey: key })))
        .catch(() => {});
    };
    window.addEventListener('casper-wallet:activeKeyChanged', refresh);
    return () => window.removeEventListener('casper-wallet:activeKeyChanged', refresh);
  }, [provider]);

  const api = useMemo<WalletApi>(
    () => ({ ...state, connect, connectDemo, disconnect, provider }),
    [state, connect, connectDemo, disconnect, provider],
  );
  return <WalletContext.Provider value={api}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within <WalletProvider>');
  return ctx;
}
