/**
 * The sync reads that caught every error now let an engine capability refusal through (refusal-swallow triage,
 * owner lane 11): a refused read is not an empty answer.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read surfaces `engine_capability_missing` from the engine it reads, and keeps its fail-open
 *    answer for any other failure (an old schema, a vanished row).
 *  - Regression: the catch blocks returned an empty answer for the refusal too, so an engine that cannot serve the
 *    read looked like a brain with nothing to report.
 *  - Why existing coverage misses it: the callers' tests run on PGLite or Postgres, where the reads never refuse.
 *  - Seam: a fake engine whose read throws the refusal the Rust engine throws (rust-engine/errors.ts
 *    capabilityMissing); each read under test is called directly.
 */
import { describe, expect, test } from 'bun:test';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { olderLiveSyncDrainer, queuedSyncDisabled, sourceIdForRepoPath } from '../src/core/minions/handlers/sync.ts';
import { startSyncQueueWake } from '../src/core/minions/sync-queue-wake.ts';
import { countQueuedBackfills } from '../src/core/sync-cost-gate.ts';
import { identityRemedyParts } from '../src/core/sync-identity-downgrades.ts';
import { loadActivationPendingSourceIds } from '../src/core/sync-policy.ts';
import { resolveSlugsForRemovedPaths } from '../src/core/sync-git.ts';
import { __resetDelegatedSyncForTests, deferredEmbedDecisions, maybeDrainDeferredEmbeds, scheduleDeferredSyncEmbeds } from '../src/core/serve-sync-runner.ts';

const refused = () => { throw capabilityMissing('raw_sql', 'executeRaw'); };
const broken = () => { throw new Error('relation does not exist'); };
const code = (run: () => Promise<unknown>) => run().then(() => 'resolved', (error: { code?: string }) => error.code ?? 'error');

describe('a refused sync read surfaces instead of reading as empty', () => {
  test('olderLiveSyncDrainer (handlers/sync.ts): a refusal surfaces, another failure reads as no drainer', async () => {
    expect(await code(() => olderLiveSyncDrainer({ executeRaw: async () => refused() } as never, 1, 'default', -1, null))).toBe('engine_capability_missing');
    expect(await olderLiveSyncDrainer({ executeRaw: async () => broken() } as never, 1, 'default', -1, null)).toBeNull();
  });

  test('sourceIdForRepoPath and queuedSyncDisabled (handlers/sync.ts): a refusal surfaces, another failure falls back', async () => {
    expect(await code(() => sourceIdForRepoPath({ listAllSources: async () => refused() } as never, '/r'))).toBe('engine_capability_missing');
    expect(await sourceIdForRepoPath({ listAllSources: async () => broken() } as never, '/r')).toBeUndefined();
    expect(await code(() => queuedSyncDisabled({ getSource: async () => refused() } as never, 's'))).toBe('engine_capability_missing');
    expect(await queuedSyncDisabled({ getSource: async () => broken() } as never, 's')).toBe(false);
  });

  test('countQueuedBackfills (sync-cost-gate.ts): a refusal surfaces, another failure counts none', async () => {
    expect(await code(() => countQueuedBackfills({ countJobsByStatus: async () => refused() } as never))).toBe('engine_capability_missing');
    expect(await countQueuedBackfills({ countJobsByStatus: async () => broken() } as never)).toBe(0);
  });

  test('loadActivationPendingSourceIds (sync-policy.ts): a refused binding read surfaces, an unreadable table marks none', async () => {
    // The mode read and the binding read are both typed members (readManagedModeRows, writerReleaseStore().boundSourceIds),
    // so the refusal is injected at the member the code calls, never at a statement's text.
    const engine = (boundSourceIds: () => Promise<string[]>) =>
      ({ kind: 'rust', readManagedModeRows: async () => [{ enabled: false }], writerReleaseStore: async () => ({ boundSourceIds }) }) as never;
    expect(await code(() => loadActivationPendingSourceIds(engine(async () => refused())))).toBe('engine_capability_missing');
    expect(await loadActivationPendingSourceIds(engine(async () => broken()))).toEqual(new Set());
    expect(await loadActivationPendingSourceIds(engine(async () => ['b', 'a']))).toEqual(new Set(['a', 'b']));
  });

  test('identityRemedyParts (sync-identity-downgrades.ts) binds the brain id the typed read returns, and a refused read surfaces', async () => {
    const record = { source_id: 's', from: 'a.md', to: 'b.md', recorded_at: 'x', old_page_id: 1, new_slug: null } as never;
    const parts = await identityRemedyParts({ readPersistenceBrainId: async () => 'brain-1', readIdentityRemedySide: async () => null } as never, record, 'close');
    expect(parts.brain_id).toBe('brain-1');
    expect(await code(() => identityRemedyParts({ readPersistenceBrainId: async () => refused(), readIdentityRemedySide: async () => null } as never, record, 'close')))
      .toBe('engine_capability_missing');
  });

  test('startSyncQueueWake (sync-queue-wake.ts): a refused LISTEN probe surfaces; a failed LISTEN still polls', async () => {
    const listenSql = { listen: async () => ({ unlisten: async () => {} }) };
    const engine = (executeRaw: () => Promise<unknown>) => ({ kind: 'postgres', connectionManager: { isDualPoolActive: () => true, ddl: async () => listenSql }, executeRaw }) as never;
    const waiter = { wake() {}, idle: async () => {} } as never;
    const opts = { queue: 'default', env: {}, log: () => {} };
    expect(await code(() => startSyncQueueWake(engine(async () => refused()), waiter, opts))).toBe('engine_capability_missing');
    const wake = await startSyncQueueWake(engine(async () => broken()), waiter, opts);
    expect([wake.mode, wake.reason]).toEqual(['poll', 'listen_unverified']);
    await wake.stop();
  });

  test('maybeDrainDeferredEmbeds (serve-sync-runner.ts): a refused source read is recorded as refused, not logged as a failed pass', async () => {
    __resetDelegatedSyncForTests();
    try {
      const engine = { listAllSources: async () => refused(), registerBeforeDisconnect: () => () => {} } as never;
      scheduleDeferredSyncEmbeds(engine);
      await maybeDrainDeferredEmbeds(engine);
      expect(deferredEmbedDecisions.map(entry => entry.decision)).toEqual(['refused']);
    } finally { __resetDelegatedSyncForTests(); }
  });

  test('resolveSlugsForRemovedPaths (sync-git.ts): a refused live-page read surfaces instead of deleting on unverified evidence', async () => {
    const engine = (read: () => Promise<unknown>) => ({ resolveSlugsByPaths: async () => new Map(), readFirstLiveSlugAtPath: read, listPathTwinSlugs: read, listLiveSlugOrigins: read }) as never;
    expect(await code(() => resolveSlugsForRemovedPaths(engine(async () => refused()), ['notes/a.md'], 's'))).toBe('engine_capability_missing');
    expect(await code(() => resolveSlugsForRemovedPaths(engine(async () => refused()), ['notes/a.md'], undefined))).toBe('engine_capability_missing');
    // Another failure keeps the legacy fallback: the path-derived slug.
    expect([...(await resolveSlugsForRemovedPaths(engine(async () => broken()), ['notes/a.md'], 's')).slugs]).toEqual([['notes/a.md', 'notes/a']]);
  });
});
