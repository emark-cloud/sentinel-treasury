/**
 * Build, sign, and submit the depositor `TransactionV1`s (the real on-chain path).
 *
 * The vault is called **by package hash** (so contract upgrades don't break the target), mirroring
 * the orchestrator's execution layer (`packages/orchestrator/src/execution/transaction.ts`). We
 * build the transaction with casper-js-sdk, hand it to the Casper Wallet extension to sign, then
 * submit it to the public node RPC and report progress through the phase callback.
 *
 * Native-CSPR deposit note: `deposit_cspr` is a `#[odra(payable)]` entry point — it reads
 * `self.env().attached_value()`. There is **no** native "transferred value" on a Casper 2.x stored
 * contract call: Odra funds a payable call by running its **`proxy_caller` session WASM** in the
 * caller's account context, which creates a cargo purse, moves the CSPR into it from the account's
 * main purse, and forwards the call with a `cargo_purse` arg the contract drains. So a deposit is a
 * *session* transaction (module bytes + `package_hash`/`entry_point`/`args`/`amount` args), not a
 * plain contract call. Withdraw and `redeem` are not payable, so they stay direct contract calls.
 *
 * This module is only exercised in live mode (a real Casper Wallet connection); the demo path in
 * `lib/depositor.ts` never calls it. The end-to-end live walkthrough is a manual verification step
 * (needs the redeployed share-vault + a funded wallet) — see the plan's verification section.
 */
import {
  ContractCallBuilder,
  SessionBuilder,
  Args,
  CLValue,
  CLTypeUInt8,
  PublicKey,
  RpcClient,
  HttpHandler,
} from 'casper-js-sdk';
import { CONTRACTS, NETWORK, GAS } from '../chain';
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

/**
 * Casper approval signatures are algorithm-tagged: a leading `0x01` (ed25519) / `0x02` (secp256k1)
 * byte precedes the 64 raw signature bytes. The Casper Wallet returns the **raw 64-byte** signature,
 * and `Transaction.setSignature` stores whatever bytes we hand it verbatim (it does not add the tag).
 * Pass a bare 64-byte signature and the node rejects the whole transaction as malformed params
 * (JSON-RPC -32602). So prepend the tag, derived from the signer key's own leading byte (a Casper
 * public-key hex starts with the same `01`/`02` algorithm tag). Idempotent: a 65-byte signature that
 * already carries a matching tag is returned unchanged.
 */
function tagSignature(rawSigHex: string, signerKeyHex: string): Uint8Array {
  const sig = hexToBytes(rawSigHex);
  const tag = parseInt(signerKeyHex.slice(0, 2), 16); // 0x01 ed25519 / 0x02 secp256k1
  if (sig.length === 65 && sig[0] === tag) return sig;
  const out = new Uint8Array(sig.length + 1);
  out[0] = tag;
  out.set(sig, 1);
  return out;
}

// Submit through the same-origin server proxy (`app/api/rpc`), not the node directly: the public
// Testnet node sends no CORS headers, so a browser fetch straight to it fails with "Failed to fetch".
function rpc(): RpcClient {
  return new RpcClient(new HttpHandler('/api/rpc', 'fetch'));
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
    tx.setSignature(tagSignature(signed.signatureHex, signerKeyHex), PublicKey.fromHex(signerKeyHex));
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

/** Encode raw bytes as an Odra `Bytes` arg — CLType `List<U8>` (length-prefixed), not `ByteArray`. */
function clBytes(u8: Uint8Array) {
  return CLValue.newCLList(
    CLTypeUInt8,
    Array.from(u8, (b) => CLValue.newCLUint8(b)),
  );
}

/** The Odra payable-call shim, fetched once from `public/` and cached for the session. */
let proxyWasm: Promise<Uint8Array> | null = null;
function loadProxyCaller(): Promise<Uint8Array> {
  if (!proxyWasm) {
    proxyWasm = fetch('/proxy_caller.wasm')
      .then((r) => {
        if (!r.ok) throw new Error(`proxy_caller.wasm ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((e) => {
        proxyWasm = null; // let a later attempt retry the fetch
        throw e;
      });
  }
  return proxyWasm;
}

/**
 * Deposit native CSPR into the caller's ledger slice via the payable `deposit_cspr`.
 *
 * Routed through Odra's `proxy_caller` session WASM (see the module header): the session runs in the
 * depositor's account context, funds a cargo purse with `amount` motes from their main purse, and
 * forwards the call to the vault package. `args` carries the (empty) inner runtime args of
 * `deposit_cspr`; `attached_value` and `amount` both carry the deposit in motes (Odra reads both).
 */
export async function submitDeposit(
  provider: CasperWalletProvider,
  signerKeyHex: string,
  amountCspr: number,
  onPhase: Phase,
): Promise<string> {
  onPhase('building');
  const motes = BigInt(Math.round(amountCspr * CSPR));
  const wasm = await loadProxyCaller();
  const innerArgs = Args.fromMap({}).toBytes(); // deposit_cspr takes no inner args
  const args = Args.fromMap({
    package_hash: CLValue.newCLByteArray(hexToBytes(CONTRACTS.vault)),
    entry_point: CLValue.newCLString('deposit_cspr'),
    args: clBytes(innerArgs),
    attached_value: CLValue.newCLUInt512(motes),
    amount: CLValue.newCLUInt512(motes),
  });
  const tx = new SessionBuilder()
    .from(PublicKey.fromHex(signerKeyHex))
    .wasm(wasm)
    .runtimeArgs(args)
    .chainName(NETWORK)
    .payment(GAS.deposit)
    .build();
  return signAndSubmit(tx as never, provider, signerKeyHex, onPhase);
}

/** Asset enum index for the vault's `withdraw(asset, amount)` (Rust `enum Asset { Cspr, Scspr, Csprusd }`). */
const ASSET_INDEX: Record<'CSPR' | 'sCSPR' | 'csprUSD', number> = { CSPR: 0, sCSPR: 1, csprUSD: 2 };

/** Withdraw `amountBase` base units of one asset from the caller's own ledger slice (in-kind). */
export async function submitWithdraw(
  provider: CasperWalletProvider,
  signerKeyHex: string,
  asset: 'CSPR' | 'sCSPR' | 'csprUSD',
  amountBase: string,
  onPhase: Phase,
): Promise<string> {
  onPhase('building');
  // Odra unit enum → a single u8 variant index, read as the arg's raw value bytes (CLAny).
  const assetClv = CLValue.newCLAny(Buffer.from(Uint8Array.of(ASSET_INDEX[asset])));
  const args = Args.fromMap({ asset: assetClv, amount: CLValue.newCLUInt256(BigInt(amountBase)) });
  const tx = vaultCall(signerKeyHex, 'withdraw', args, GAS.redeem);
  return signAndSubmit(tx as never, provider, signerKeyHex, onPhase);
}

/** Full exit: burn nothing — pay out the caller's entire in-kind ledger slice and zero it. */
export async function submitRedeem(
  provider: CasperWalletProvider,
  signerKeyHex: string,
  onPhase: Phase,
): Promise<string> {
  onPhase('building');
  const tx = vaultCall(signerKeyHex, 'redeem', Args.fromMap({}), GAS.redeem);
  return signAndSubmit(tx as never, provider, signerKeyHex, onPhase);
}
