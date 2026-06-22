/**
 * x402 protocol types (spec §5.2; resources.md §6) for the `exact` scheme on
 * `casper:casper-test`. Payment is an EIP-3009 `transfer_with_authorization` over a CEP-18 asset
 * (WCSPR on Testnet — resources.md §6), authorized by an EIP-712 typed-data signature. The
 * hosted facilitator (`x402-facilitator.cspr.cloud`) verifies the signature and pays settlement
 * gas, gated by the CSPR.cloud access token.
 *
 * Shapes follow the x402 spec's `PaymentRequirements` / `PaymentPayload`. The EIP-712 domain +
 * field encoding must byte-match the casper-x402 facilitator's implementation; that equivalence
 * is the one thing only a live `/verify` round-trip can confirm (the examples are Go).
 */

/** One acceptable way to pay, advertised by the resource server in its 402 body. */
export interface PaymentRequirement {
  scheme: 'exact';
  /** CAIP-2-ish network id, e.g. `casper:casper-test`. */
  network: string;
  /** Max amount required, base units (decimal string). */
  maxAmountRequired: string;
  /** The resource URL being paid for. */
  resource: string;
  description: string;
  mimeType: string;
  /** Recipient address (the resource server's account/key). */
  payTo: string;
  maxTimeoutSeconds: number;
  /** Payment asset — the CEP-18 contract/package hash (WCSPR on Testnet). */
  asset: string;
  /** EIP-712 domain hints (token name/version) + any scheme extras. */
  extra?: { name?: string; version?: string; [k: string]: unknown };
}

/** The 402 response body. */
export interface PaymentRequirementsResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
}

/** EIP-3009 authorization the payer signs. `value` and times are decimal strings; nonce is hex. */
export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte random nonce, hex `0x…`. */
  nonce: string;
}

/** The `exact`-scheme payload carried (base64-encoded) in the `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: {
    /** EIP-712 signature over the authorization, hex `0x…`. */
    signature: string;
    authorization: TransferAuthorization;
  };
}

/** Facilitator `/verify` response (fields confirmed live, D-012). */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  /** Human-readable detail accompanying `invalidReason`. */
  invalidMessage?: string;
  payer?: string;
}

/** Facilitator `/settle` response. */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  /** Settlement transaction hash on Testnet. */
  transaction?: string;
  network?: string;
  payer?: string;
}

/** Encode a `PaymentPayload` for the `X-PAYMENT` header (base64 JSON). */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** Decode an `X-PAYMENT` header back to a `PaymentPayload`. */
export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
}
