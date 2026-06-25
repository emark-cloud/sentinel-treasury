/**
 * Build, sign, and submit the depositor `TransactionV1`s (the real on-chain path).
 *
 * The vault is called **by package hash** (so contract upgrades don't break the target), mirroring
 * the orchestrator's execution layer (`packages/orchestrator/src/execution/transaction.ts`). We
 * build the transaction with casper-js-sdk, hand it to the Casper Wallet extension to sign, then
 * submit it to the public node RPC and report progress through the phase callback.
 *
 * Native-CSPR deposit note: `deposit_cspr` is a `#[odra(payable)]` entry point — the deposited CSPR
 * rides on the transaction's transferred value (Casper 2.x). casper-js-sdk 5.0.12 surfaces this on
 * the built transaction's session target; `attachValue` centralizes that so the integration point is
 * obvious. Token deposits (`approve` + `deposit_token`) and `redeem` are plain calls with no value.
 *
 * This module is only exercised in live mode (a real Casper Wallet connection); the demo path in
 * `lib/depositor.ts` never calls it. The end-to-end live walkthrough is a manual verification step
 * (needs the redeployed share-vault + a funded wallet) — see the plan's verification section.
 */
import { ContractCallBuilder, Args, CLValue, PublicKey, RpcClient, HttpHandler } from 'casper-js-sdk';
import { CONTRACTS, NETWORK, NODE_RPC_URL, GAS } from '../chain';
import type { CasperWalletProvider } from '../wallet';
import type { TxPhase } from '../depositor';

type Phase = (p: TxPhase) => void;

const CSPR = 1_000_000_000;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function rpc(): RpcClient {
  return new RpcClient(new HttpHandler(NODE_RPC_URL, 'fetch'));
}

/** Sign a built transaction with the wallet and submit it; returns the transaction hash hex. */
async function signAndSubmit(
  // casper-js-sdk's Transaction type; kept loose to avoid coupling to its internal shape.
  tx: { toJSON: () => unknown; setSignature?: (sig: Uint8Array, key: PublicKey) => void },
  provider: CasperWalletProvider,
  signerKeyHex: string,
  onPhase: Phase,
): Promise<string> {
  onPhase('signing');
  const json = JSON.stringify(tx.toJSON());
  const signed = await provider.sign(json, signerKeyHex);
  if (signed.cancelled || !signed.signatureHex) {
    throw new Error('Signature rejected in wallet');
  }
  if (typeof tx.setSignature === 'function') {
    tx.setSignature(hexToBytes(signed.signatureHex), PublicKey.fromHex(signerKeyHex));
  }
  onPhase('submitted');
  const res = await rpc().putTransaction(tx as never);
  const hash =
    (res as { transactionHash?: { toHex?: () => string } }).transactionHash?.toHex?.() ?? '';
  onPhase('finalized');
  return hash;
}

/** Common builder: a vault entry-point call by package hash, from the connected account. */
function vaultCall(signerKeyHex: string, entryPoint: string, args: ReturnType<typeof Args.fromMap>, paymentMotes: number) {
  return new ContractCallBuilder()
    .from(PublicKey.fromHex(signerKeyHex))
    .byPackageHash(CONTRACTS.vault)
    .entryPoint(entryPoint)
    .runtimeArgs(args)
    .chainName(NETWORK)
    .payment(paymentMotes)
    .build();
}

/**
 * Attach native CSPR (deposit amount) as the transaction's transferred value for the payable
 * `deposit_cspr` entry point. Centralized so the Casper 2.x transferred-value wiring is one place.
 */
function attachValue(tx: unknown, motes: bigint): void {
  const t = tx as { transferredValue?: bigint; setTransferredValue?: (v: bigint) => void };
  if (typeof t.setTransferredValue === 'function') t.setTransferredValue(motes);
  else t.transferredValue = motes;
}

/** Deposit native CSPR → mint vault shares to the depositor. */
export async function submitDeposit(
  provider: CasperWalletProvider,
  signerKeyHex: string,
  amountCspr: number,
  onPhase: Phase,
): Promise<string> {
  onPhase('building');
  const motes = BigInt(Math.round(amountCspr * CSPR));
  const tx = vaultCall(signerKeyHex, 'deposit_cspr', Args.fromMap({}), GAS.deposit);
  attachValue(tx, motes);
  return signAndSubmit(tx as never, provider, signerKeyHex, onPhase);
}

/** Redeem `shares` → burn shares and receive the in-kind pro-rata payout. */
export async function submitRedeem(
  provider: CasperWalletProvider,
  signerKeyHex: string,
  shares: string,
  onPhase: Phase,
): Promise<string> {
  onPhase('building');
  const args = Args.fromMap({ shares_amount: CLValue.newCLUInt256(BigInt(shares)) });
  const tx = vaultCall(signerKeyHex, 'redeem', args, GAS.redeem);
  return signAndSubmit(tx as never, provider, signerKeyHex, onPhase);
}
