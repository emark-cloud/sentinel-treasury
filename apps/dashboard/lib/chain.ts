/**
 * On-chain registry + explorer links (mirrors CLAUDE.md config registry, casper-test).
 * These are the real deployed/whitelisted hashes; the receipt feed links to them on
 * testnet.cspr.live so the on-chain half of every proof is one click away (design.md §8).
 */
import type { PolicyConfig } from '@sentinel/shared';

export const NETWORK = 'casper-test';

/** Public node RPC the browser submits signed deposit/redeem transactions to (no token needed). */
export const NODE_RPC_URL =
  process.env.NEXT_PUBLIC_NODE_RPC_URL ?? 'https://node.testnet.casper.network/rpc';

/** The vault's share token ticker (ERC-4626-style: 1 share ≈ 1 micro-USD at genesis). */
export const SHARE_SYMBOL = 'stVLT';

/** Gas (motes) for the depositor-facing entry points. */
export const GAS = {
  // deposit_cspr is payable, so it runs through Odra's ~185 KB proxy_caller session WASM (loads the
  // module + two purse transfers + the vault call) — far costlier than a plain call. Tune if a live
  // deposit ever returns "Out of gas".
  deposit: 15_000_000_000, // 15 CSPR (proxy_caller session)
  approve: 1_500_000_000, // 1.5 CSPR
  redeem: 5_000_000_000, // 5 CSPR (three in-kind transfer legs)
} as const;

export const CONTRACTS = {
  vault: '5031341875f4f89629abe7aa748bfa20b0c6ee9c15e9d9910b3047dea9eff7a0',
  auditLog: 'f8898e6a22590a8e32028d97771384fa54d0fc110cf297ed3f3afb2fecce63f3',
  styks: '2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc',
  router: '04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867',
  staking: 'baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3',
  wcspr: '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e',
  wusdt: '287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100',
} as const;

/** The contract whitelist the agent may target (guardrail §11). */
export const WHITELIST: { label: string; hash: string }[] = [
  { label: 'CSPR.trade Router', hash: CONTRACTS.router },
  { label: 'Wise Lending Staking', hash: CONTRACTS.staking },
  { label: 'WUSDT (stable refuge)', hash: CONTRACTS.wusdt },
];

/** Associated-key weights from the agent-account hardening (§4.3). */
export const KEY_WEIGHTS = {
  ownerWeight: 3,
  agentWeight: 1,
  deploymentThreshold: 1,
  keyManagementThreshold: 3,
} as const;

/** Demo policy the dashboard renders (USD caps in micros, 1e6). The authoritative caps live
 * on-chain in the WASM; these drive the demo's action sizing and the Guardrails panel display. */
export const POLICY: PolicyConfig = {
  perActionCapUsd: '5000000000', // $5,000
  dailyCapUsd: '20000000000', // $20,000
  maxSlippageBps: 100, // 1%
  minScsprBps: 2000, // 20%
  maxScsprBps: 6000, // 60%
};

/** x402 machine-payment budget (CSPR) — hourly ceiling shown on the paid-pulls meter. */
export const X402_HOURLY_CAP_CSPR = 10;

const EXPLORER = 'https://testnet.cspr.live';

export function deployUrl(hash: string): string {
  return `${EXPLORER}/deploy/${hash}`;
}
export function contractUrl(hash: string): string {
  return `${EXPLORER}/contract-package/${hash}`;
}
