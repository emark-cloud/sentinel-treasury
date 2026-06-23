/**
 * Transaction signer (spec §8.1) — keys never leave the execution host. The bounded **agent
 * key** (weight 1) signs `execute_rebalance`; the **owner key** (weight 3) signs the circuit
 * breaker's `pause(true)`. Both are loaded from host-local PEM files referenced by env only
 * (`AGENT_SECRET_KEY_PATH` / `OWNER_SECRET_KEY_PATH`); nothing here is ever committed.
 */
import { readFileSync } from 'node:fs';
import { PrivateKey, KeyAlgorithm } from '../casper/sdk.js';
import type { PrivateKeyT, TransactionT } from '../casper/sdk.js';

/** The signing surface the execution layer depends on (injectable for tests). */
export interface TxSigner {
  /** Public key hex (with the 1-byte algorithm tag), used as the transaction initiator. */
  readonly publicKeyHex: string;
  /** Sign the transaction in place, appending this key's approval. */
  sign(tx: TransactionT): void;
}

/** Map a Casper public-key hex prefix to its key algorithm (`01…` ed25519, `02…` secp256k1). */
export function algorithmFromPublicKeyHex(publicKeyHex: string): number {
  const prefix = publicKeyHex.slice(0, 2).toLowerCase();
  if (prefix === '01') return KeyAlgorithm.ED25519;
  if (prefix === '02') return KeyAlgorithm.SECP256K1;
  throw new Error(`unrecognized public-key algorithm prefix: ${prefix}`);
}

/** A PEM-file-backed signer. The algorithm is inferred from the matching public-key hex. */
export class PemFileSigner implements TxSigner {
  private readonly key: InstanceType<typeof PrivateKey>;
  constructor(
    pemPath: string,
    public readonly publicKeyHex: string,
  ) {
    const pem = readFileSync(pemPath, 'utf8');
    this.key = PrivateKey.fromPem(pem, algorithmFromPublicKeyHex(publicKeyHex));
  }

  sign(tx: TransactionT): void {
    tx.sign(this.key as PrivateKeyT);
  }
}
