import { describe, it, expect, beforeEach } from 'vitest';
import type { RebalanceAction } from '@sentinel/shared';
import type { ChainClient, TxStatus } from '../src/execution/chainClient.js';
import type { TxSigner } from '../src/execution/signer.js';
import type { Clock } from '../src/execution/executionService.js';
import { ExecutionService } from '../src/execution/executionService.js';
import { MemoryCycleStore } from '../src/execution/cycleStore.js';
import type { SwapRoutes } from '../src/execution/transaction.js';

const AGENT_PK = '01a4e9a55d4546c2e3d11643b6cdf3192a4c6db36b987704afd6e0d88009309fd6';
const h32 = (b: string) => b.repeat(32);

const routes: SwapRoutes = {
  swapToStable: [h32('aa'), h32('bb'), h32('cc')],
  swapToRisk: [h32('cc'), h32('bb'), h32('aa')],
};

class FakeChain implements ChainClient {
  submitted = 0;
  nextHash = h32('de');
  statuses = new Map<string, TxStatus>();
  dict = new Map<string, Uint8Array>();

  submit(): Promise<string> {
    this.submitted += 1;
    return Promise.resolve(this.nextHash);
  }
  getStatus(txHash: string): Promise<TxStatus | null> {
    return Promise.resolve(this.statuses.get(txHash) ?? null);
  }
  getDictionaryBytes(_c: string, _n: string, key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.dict.get(key) ?? null);
  }
}

const signer: TxSigner = { publicKeyHex: AGENT_PK, sign: () => {} };

function fakeClock(): Clock {
  let t = 1000;
  return { now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()) };
}

function svc(
  chain: FakeChain,
  store = new MemoryCycleStore(),
): { service: ExecutionService; store: MemoryCycleStore } {
  const service = new ExecutionService(
    chain,
    signer,
    store,
    {
      chainName: 'casper-test',
      vaultPackageHash: h32('11'),
      routes,
      paymentMotes: 20_000_000_000,
      pollIntervalMs: 10,
      pollTimeoutMs: 30,
    },
    fakeClock(),
  );
  return { service, store };
}

const swap: RebalanceAction = {
  kind: 'SwapToStable',
  asset: 'sCSPR',
  amount: '1000000000',
  target: h32('aa'),
  minOut: '500',
};

const req = (cycleId: string, action: RebalanceAction = swap) => ({
  cycleId,
  accountHashHex: h32('ac'),
  action,
  regime: 'Stressed' as const,
  perceptionHash: h32('ab'),
  decisionHash: h32('cd'),
});

describe('ExecutionService', () => {
  let chain: FakeChain;
  beforeEach(() => {
    chain = new FakeChain();
  });

  it('builds, submits, and settles a successful rebalance', async () => {
    chain.statuses.set(chain.nextHash, { finalized: true, success: true, gasMotes: '123' });
    const { service, store } = svc(chain);

    const out = await service.execute(req('cycle-1'));
    expect(chain.submitted).toBe(1);
    expect(out.status).toBe('finalized');
    expect(out.result).toBe('Success');
    expect(out.deployHash).toBe(chain.nextHash);
    expect(out.gasMotes).toBe('123');
    expect((await store.get('cycle-1'))?.status).toBe('finalized');
  });

  it('records a revert as failed/Reverted with the error message', async () => {
    chain.statuses.set(chain.nextHash, {
      finalized: true,
      success: false,
      errorMessage: 'User error: 5',
    });
    const { service } = svc(chain);
    const out = await service.execute(req('cycle-2'));
    expect(out.status).toBe('failed');
    expect(out.result).toBe('Reverted');
    expect(out.errorMessage).toBe('User error: 5');
  });

  it('skips NoOp cycles without touching the chain', async () => {
    const { service, store } = svc(chain);
    const noop: RebalanceAction = { kind: 'NoOp', asset: 'CSPR', amount: '0', target: '' };
    const out = await service.execute(req('cycle-3', noop));
    expect(chain.submitted).toBe(0);
    expect(out.status).toBe('skipped');
    expect(out.result).toBe('Skipped');
    expect(out.success).toBe(true);
    expect((await store.get('cycle-3'))?.status).toBe('skipped');
  });

  it('is idempotent: a finalized cycle is not re-submitted', async () => {
    chain.statuses.set(chain.nextHash, { finalized: true, success: true });
    const { service, store } = svc(chain);
    await service.execute(req('cycle-4'));
    const again = await service.execute(req('cycle-4'));
    expect(chain.submitted).toBe(1); // not re-submitted
    expect(again.status).toBe('finalized');
    expect(await store.list()).toHaveLength(1);
  });

  it('leaves a cycle in-flight (Pending) when finality is not observed before timeout', async () => {
    const { service, store } = svc(chain); // no status set ⇒ never finalizes
    const out = await service.execute(req('cycle-5'));
    expect(out.status).toBe('submitted');
    expect(out.result).toBe('Pending');
    expect(out.success).toBe(false);
    expect((await store.get('cycle-5'))?.deployHash).toBe(chain.nextHash);
  });

  it('reconcile() settles in-flight transactions after a restart', async () => {
    const store = new MemoryCycleStore();
    const now = Date.now();
    await store.put({
      cycleId: 'cycle-6',
      status: 'submitted',
      action: swap,
      perceptionHash: h32('ab'),
      decisionHash: h32('cd'),
      deployHash: chain.nextHash,
      createdAt: now,
      updatedAt: now,
    });
    chain.statuses.set(chain.nextHash, { finalized: true, success: true, gasMotes: '99' });

    const { service } = svc(chain, store);
    const settled = await service.reconcile();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('finalized');
    expect(chain.submitted).toBe(0); // reconcile never submits
  });
});
