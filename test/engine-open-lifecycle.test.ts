/**
 * Per-engine state an embedding host that opens an engine per request must not leak or share (Wave B1 lifecycle),
 * and the consumer-identity sentinel an engine opened from settings records. Every case here runs on master's
 * modules, so each one is red before the change.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dailySpend, __resetDecideStoreForTests } from '../src/core/ai/decide/store.ts';
import { _resetFeedbackRecordingForTests, drainFeedbackQueue, recordAnswer } from '../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import { hostIdentityMismatches } from '../src/core/persistence/consumer-diagnostics.ts';
import type { LocalHostIdentity } from '../src/core/persistence/identity.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

afterEach(() => {
  __resetDecideStoreForTests();
  _resetFeedbackRecordingForTests();
  _resetFeedbackSettingsCacheForTests();
});

/** A page transaction on `engine`, shaped as the engines build one (an own `_pageTransaction` on a prototype clone). */
function transactionOn<T extends object>(engine: T): T {
  const tx = Object.create(engine) as T;
  Object.defineProperty(tx, '_pageTransaction', { value: true });
  return tx;
}

describe('decide spend cache', () => {
  test('a page transaction reads its engine\'s cached daily figure instead of querying again', async () => {
    let reads = 0;
    const engine = { executeRaw: async () => { reads++; return [{ total: 2, remote: 1 }]; } } as unknown as BrainEngine;
    const now = Date.now();
    expect(await dailySpend(engine, now)).toEqual({ total: 2, remote: 1 });
    expect(await dailySpend(transactionOn(engine), now)).toEqual({ total: 2, remote: 1 });
    expect(reads).toBe(1);
  });
});

describe('feedback queue', () => {
  test('a drained queue does not keep its engine alive', async () => {
    const open = async (): Promise<WeakRef<object>> => {
      const engine = {
        kind: 'pglite',
        getConfig: async (key: string) => (key === 'feedback.enabled' ? 'true' : null),
        executeRaw: async () => [],
      } as unknown as BrainEngine;
      const ctx = { engine, config: {}, remote: false, logger: console } as unknown as OperationContext;
      const meta = await recordAnswer(ctx, { op: 'query', pages: [{ source_id: 'default', slug: 'people/alice-example' }] });
      expect(meta?.feedback.rateable).toBe(true);
      expect(await drainFeedbackQueue(5000)).toEqual({ unfinished: 0 });
      return new WeakRef(engine);
    };
    const held = await open();
    // The settings cache keeps the last engine it read (one slot, by design); the queue is what this case measures.
    _resetFeedbackSettingsCacheForTests();
    for (let i = 0; i < 50 && held.deref(); i++) { Bun.gc(true); await Bun.sleep(20); }
    expect(held.deref()).toBeUndefined();
  });
});

describe('consumer identity sentinel', () => {
  test('an owner whose heartbeat records an identity given at open gets no GBRAIN_HOME fix, never a path read from the sentinel', async () => {
    const owner = randomUUID();
    const me: LocalHostIdentity = { id: randomUUID(), path: '/home/alice-example/.gbrain/persistence/host.json', persistence_home: '/home/alice-example/.gbrain/persistence',
      minted_under: { home: '/home/alice-example', gbrain_home: null, hostname: 'host-a', machine_id: null } };
    const rows = [
      [{ worktree_id: randomUUID(), owner_host_id: owner, local_path: '/srv/brain-example', created_at: '2026-01-01T00:00:00Z', source_ids: ['source-a'] }],
      [{ host_id: owner, host_json_path: `embedded:${owner}`, persistence_home: 'embedded', minted_under: null, renewed_at: '2026-11-01T00:00:00Z' }],
    ];
    const engine = { kind: 'postgres', executeRaw: async () => rows.shift() ?? [] } as unknown as BrainEngine;
    const [mismatch] = await hostIdentityMismatches(engine, me, { exists: () => true, marked: () => true, hostJsonMintedAt: Date.now() });
    expect(mismatch?.owner_host).toMatchObject({ host_id: owner, host_json_path: `embedded:${owner}`, persistence_home: 'embedded' });
    expect(mismatch?.fix_env).toBeNull();
  });
});
