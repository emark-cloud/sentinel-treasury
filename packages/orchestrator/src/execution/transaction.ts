/**
 * Build the `TransactionV1`s the execution layer submits (spec §8.1):
 *  - the agent's `execute_rebalance(params)` on the upgradable vault package, and
 *  - the owner's `pause(paused)` kill switch the circuit breaker trips (spec §11).
 *
 * The vault is called **by package hash** (not contract hash) so upgrades don't break the call
 * target. Swap routes are derived here from the configured token packages — the route is an
 * execution concern, never lifted from the LLM (the off-chain `RebalanceAction` carries no path).
 */
import type { ActionKind, RebalanceAction, Regime } from '@sentinel/shared';
import { ContractCallBuilder, Args, CLValue, PublicKey } from '../casper/sdk.js';
import type { TransactionT } from '../casper/sdk.js';
import { rebalanceParamsCLValue } from './serialize.js';

/** Token-package routes per swap kind (`path[0]` is the input token the vault approves). */
export interface SwapRoutes {
  /** sCSPR → stable (the fast de-risk path; spec §1.4). */
  swapToStable: readonly string[];
  /** stable → CSPR/sCSPR (re-risk). */
  swapToRisk: readonly string[];
}

/** Token packages used to derive routes (CLAUDE.md registry). */
export interface RouteTokens {
  scspr: string;
  wcspr: string;
  stable: string;
}

/**
 * Default multi-hop routes via WCSPR (abi-spike.md: de-risk proven on `[sCSPR, WCSPR, WUSDT]`).
 * The Router routes around shallow direct pairs (D-003), so the WCSPR hop is the reliable path.
 */
export function defaultRoutes(t: RouteTokens): SwapRoutes {
  return {
    swapToStable: [t.scspr, t.wcspr, t.stable],
    swapToRisk: [t.stable, t.wcspr, t.scspr],
  };
}

/** The route for an action kind; empty for stake/unstake/noop (no swap path). */
export function routeForKind(kind: ActionKind, routes: SwapRoutes): readonly string[] {
  switch (kind) {
    case 'SwapToStable':
      return routes.swapToStable;
    case 'SwapToRisk':
      return routes.swapToRisk;
    default:
      return [];
  }
}

export interface ExecuteRebalanceTxParams {
  agentPublicKeyHex: string;
  vaultPackageHash: string;
  chainName: string;
  /** Gas payment in motes (cross-contract swaps are the costly case). */
  paymentMotes: number;
  action: RebalanceAction;
  regime: Regime;
  perceptionHash: string;
  decisionHash: string;
  routes: SwapRoutes;
  ttlMs?: number;
}

/** Build the unsigned `execute_rebalance` transaction for the agent to sign. */
export function buildExecuteRebalanceTx(p: ExecuteRebalanceTxParams): TransactionT {
  const params = rebalanceParamsCLValue({
    action: p.action,
    regime: p.regime,
    perceptionHash: p.perceptionHash,
    decisionHash: p.decisionHash,
    path: routeForKind(p.action.kind, p.routes),
  });

  let builder = new ContractCallBuilder()
    .from(PublicKey.fromHex(p.agentPublicKeyHex))
    .byPackageHash(p.vaultPackageHash)
    .entryPoint('execute_rebalance')
    .runtimeArgs(Args.fromMap({ params }))
    .chainName(p.chainName)
    .payment(p.paymentMotes);
  if (p.ttlMs !== undefined) builder = builder.ttl(p.ttlMs);
  return builder.build();
}

export interface PauseTxParams {
  ownerPublicKeyHex: string;
  vaultPackageHash: string;
  chainName: string;
  paymentMotes: number;
  paused: boolean;
}

/** Build the owner's `pause(paused)` transaction (circuit-breaker kill switch). */
export function buildPauseTx(p: PauseTxParams): TransactionT {
  return new ContractCallBuilder()
    .from(PublicKey.fromHex(p.ownerPublicKeyHex))
    .byPackageHash(p.vaultPackageHash)
    .entryPoint('pause')
    .runtimeArgs(Args.fromMap({ paused: CLValue.newCLValueBool(p.paused) }))
    .chainName(p.chainName)
    .payment(p.paymentMotes)
    .build();
}
