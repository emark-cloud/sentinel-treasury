/**
 * cspr.live deep links (spec §9.2 step 4) — open the executed transaction in the Testnet explorer
 * to confirm the on-chain effect (token movements) matches the receipt's `postAllocBps`.
 */
const TESTNET_EXPLORER = 'https://testnet.cspr.live';

/** Casper 2.x `TransactionV1` page (our `execute_rebalance` deploys). */
export function transactionUrl(txHash: string, base = TESTNET_EXPLORER): string {
  return `${base}/transaction/${txHash}`;
}

/** Legacy Deploy page (kept for 1.x-style deploy hashes). */
export function deployUrl(deployHash: string, base = TESTNET_EXPLORER): string {
  return `${base}/deploy/${deployHash}`;
}

export function contractUrl(contractHash: string, base = TESTNET_EXPLORER): string {
  return `${base}/contract/${contractHash}`;
}

export function accountUrl(publicKeyHex: string, base = TESTNET_EXPLORER): string {
  return `${base}/account/${publicKeyHex}`;
}
