/**
 * On-chain registry + explorer links (mirrors CLAUDE.md config registry, casper-test).
 * These are the real deployed/whitelisted hashes; the receipt feed links to them on
 * testnet.cspr.live so the on-chain half of every proof is one click away (design.md §8).
 */
import type { PolicyConfig } from '@sentinel/shared';

export const NETWORK = 'casper-test';

export const CONTRACTS = {
  vault: '949a9c359d12bf02a9f630c8eaeb1459348da6880e563d4ac278077a2f446f20',
  auditLog: '95dd52c4fc07bb42ce8648f2cf74a8839244410de31b68045b96cb95cf004712',
  styks: '2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc',
  router: '04a11a367e708c52557930c4e9c1301f4465100d1b1b6d0a62b48d3e32402867',
  staking: 'baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3',
  wcspr: '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e',
  wusdt: '287873e640fc0dbf3b7bc828a30e1d8ea857649a401b5b5f1ba29ab8bb741100',
} as const;

/** The contract whitelist the agent may target (guardrail §11). */
export const WHITELIST: { label: string; hash: string }[] = [
  { label: 'CSPR.trade Router', hash: CONTRACTS.router },
  { label: 'Wise Lending (sCSPR)', hash: CONTRACTS.staking },
  { label: 'WUSDT (stable)', hash: CONTRACTS.wusdt },
  { label: 'Styks price feed', hash: CONTRACTS.styks },
];

/** Associated-key weights from the agent-account hardening (§4.3). */
export const KEY_WEIGHTS = {
  ownerWeight: 3,
  agentWeight: 1,
  deploymentThreshold: 1,
  keyManagementThreshold: 3,
} as const;

/** Conservative demo policy the vault was init'd with (USD caps in micros, 1e6). */
export const POLICY: PolicyConfig = {
  perActionCapUsd: '500000000', // $500
  dailyCapUsd: '2000000000', // $2,000
  maxSlippageBps: 150, // 1.5%
  minScsprBps: 1500, // 15%
  maxScsprBps: 7000, // 70%
};

const EXPLORER = 'https://testnet.cspr.live';

export function deployUrl(hash: string): string {
  return `${EXPLORER}/deploy/${hash}`;
}
export function contractUrl(hash: string): string {
  return `${EXPLORER}/contract-package/${hash}`;
}
