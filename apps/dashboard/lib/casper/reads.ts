/**
 * Client-side wrappers over the dashboard's read API routes (`app/api/vault`, `app/api/position`).
 * The routes run server-side so the CSPR.cloud access token never reaches the browser; they return
 * the shared `NavSnapshot` / `UserPosition` shapes and a `live` flag (false ⇒ backend not yet
 * configured, the UI falls back to the demo vault).
 */
import type { NavSnapshot, UserPosition } from '@sentinel/shared';

export interface VaultApiResponse {
  live: boolean;
  nav: NavSnapshot;
}

export interface PositionApiResponse {
  live: boolean;
  position: UserPosition | null;
}

export async function fetchVault(): Promise<VaultApiResponse> {
  const res = await fetch('/api/vault', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/vault → ${res.status}`);
  return (await res.json()) as VaultApiResponse;
}

export async function fetchPosition(account: string): Promise<PositionApiResponse> {
  const res = await fetch(`/api/position?account=${encodeURIComponent(account)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/position → ${res.status}`);
  return (await res.json()) as PositionApiResponse;
}
