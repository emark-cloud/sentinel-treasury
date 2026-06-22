/**
 * EIP-712 typed-data hashing + signing for x402 payments on Casper (spec §5.2).
 *
 * x402's `exact` scheme authorizes an EIP-3009 `TransferWithAuthorization` with an EIP-712
 * signature. **This is delegated to the official `@casper-ecosystem/casper-eip-712` package**, the
 * same implementation the cspr.cloud facilitator uses — confirmed on 2026-06-22 (D-012) by
 * reproducing the crate's published `casper_transfer_with_authorization` digest vector
 * byte-for-byte. Rolling our own keccak/encoding here previously diverged from Casper's rules
 * (Casper addresses encode as `keccak256(33-byte public key)`, the domain carries custom
 * `chain_name` + `contract_package_hash` fields, not `verifyingContract`).
 *
 * Signing: the Casper agent key is **ed25519** (public-key prefix `01`), so the digest is signed
 * with ed25519 and tagged `01` (Casper algorithm tag). A secp256k1 signer (tag `02`) is provided
 * for completeness. ⚠️ The facilitator's exact x402 **v2 wire envelope** (the field carrying the
 * signature scheme) is still being mapped — the digest/domain byte-match is proven, the envelope
 * is the remaining live-integration item (D-012).
 */
import { hashTypedData } from '@casper-ecosystem/casper-eip-712';
import type { EIP712Domain, TypeDefinitions, TypedField } from '@casper-ecosystem/casper-eip-712';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { TransferAuthorization } from './types.js';

/** Casper EIP-712 domain (custom `chain_name` + `contract_package_hash`, per casper-eip-712). */
export interface Eip712Domain {
  name: string;
  version: string;
  /** CAIP-2 chain id, e.g. `casper:casper-test`. */
  chainName: string;
  /** The CEP-18 asset's contract **package** hash (32-byte hex, with or without `0x`). */
  contractPackageHash: string;
}

const DOMAIN_TYPES: TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chain_name', type: 'string' },
  { name: 'contract_package_hash', type: 'bytes32' },
];

/** EIP-3009 `TransferWithAuthorization` (EVM-compatible variant — matches the crate vector). */
const TRANSFER_TYPES: TypeDefinitions = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function hex0x(s: string): string {
  return s.startsWith('0x') ? s : `0x${s}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The EIP-712 digest for a `TransferWithAuthorization` message under `domain`. */
export function transferAuthorizationDigest(
  domain: Eip712Domain,
  auth: TransferAuthorization,
): Uint8Array {
  const eipDomain: EIP712Domain = {
    name: domain.name,
    version: domain.version,
    chain_name: domain.chainName,
    contract_package_hash: hex0x(domain.contractPackageHash),
  };
  return hashTypedData(
    eipDomain,
    TRANSFER_TYPES,
    'TransferWithAuthorization',
    {
      from: hex0x(auth.from),
      to: hex0x(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: hex0x(auth.nonce),
    },
    { domainTypes: DOMAIN_TYPES },
  );
}

/** Signs x402 EIP-712 payment authorizations. */
export interface X402Signer {
  /** Casper public key of the payer (`01…`/`02…` hex, with or without `0x`), used as `from`. */
  readonly fromAddress: string;
  signAuthorization(domain: Eip712Domain, auth: TransferAuthorization): Promise<string>;
}

/**
 * ed25519 signer — the scheme for our Casper agent key (public-key prefix `01`). Produces a
 * Casper-tagged signature: `01` ‖ 64-byte ed25519 signature, hex (no `0x`).
 */
export class Ed25519X402Signer implements X402Signer {
  readonly fromAddress: string;
  private readonly seed: Uint8Array;

  /** `seedHex` is the 32-byte ed25519 seed (the agent payment key, held on the execution host). */
  constructor(seedHex: string, fromAddress: string) {
    this.seed = hexToBytes(seedHex);
    this.fromAddress = fromAddress.startsWith('0x') ? fromAddress.slice(2) : fromAddress;
  }

  signAuthorization(domain: Eip712Domain, auth: TransferAuthorization): Promise<string> {
    const digest = transferAuthorizationDigest(domain, auth);
    const sig = ed25519.sign(digest, this.seed);
    return Promise.resolve(`01${bytesToHex(sig)}`);
  }
}

/**
 * secp256k1 signer (Casper key prefix `02`). Produces `02` ‖ 64-byte compact `r‖s` signature.
 * Provided for completeness; our agent key is ed25519.
 */
export class Secp256k1X402Signer implements X402Signer {
  readonly fromAddress: string;
  private readonly privateKey: Uint8Array;

  constructor(privateKeyHex: string, fromAddress: string) {
    this.privateKey = hexToBytes(privateKeyHex);
    this.fromAddress = fromAddress.startsWith('0x') ? fromAddress.slice(2) : fromAddress;
  }

  signAuthorization(domain: Eip712Domain, auth: TransferAuthorization): Promise<string> {
    const digest = transferAuthorizationDigest(domain, auth);
    const sig = secp256k1.sign(digest, this.privateKey);
    return Promise.resolve(`02${bytesToHex(sig.toCompactRawBytes())}`);
  }
}

export const _internal = { hexToBytes, bytesToHex, hex0x, transferAuthorizationDigest };
