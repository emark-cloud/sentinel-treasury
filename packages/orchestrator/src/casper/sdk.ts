/**
 * casper-js-sdk loader shim.
 *
 * `casper-js-sdk@5.0.12` ships a UMD/CJS bundle with **no `import` condition** in its
 * `exports` map, so under our ESM (`"type":"module"`, NodeNext) package a normal
 * `import { RpcClient } from 'casper-js-sdk'` resolves the named bindings to `undefined`
 * (the same breakage `tools/cspr-trade-mcp` patches with an ESM wrapper). Rather than patch
 * `node_modules`, we load the CJS bundle once via `createRequire` and re-export the values we
 * use. Type-only re-exports (`export type`) are erased at compile time, so they don't trigger
 * the broken runtime resolution.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('casper-js-sdk') as typeof import('casper-js-sdk');

export const {
  RpcClient,
  HttpHandler,
  CLValue,
  CLValueParser,
  CLValueUInt256,
  CLValueUInt512,
  CLValueString,
  Args,
  PublicKey,
  Key,
  ContractHash,
  Conversions,
} = sdk;

export type {
  RpcClient as RpcClientT,
  HttpHandler as HttpHandlerT,
  StoredValue,
  CLValue as CLValueT,
} from 'casper-js-sdk';
