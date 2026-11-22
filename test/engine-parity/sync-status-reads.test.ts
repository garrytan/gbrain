/**
 * BrainEngine parity — the row reads `gbrain sync status` makes (`readSyncStatusSourceRow`, `readSyncStatusCommittedRow`,
 * `readManagedSyncCursorHeader`, `readRetiredManagedSyncCursor`, `readManagedSyncFailureRows`,
 * `readOrphanedManagedSyncFailureRows`, `readSyncHeadRequestRow`, `readSyncRecoveryProbeRow`, `readIdentityDowngradeRows`),
 * which persistence/sync-status.ts, sync-failures.ts, sync-drain.ts and sync-identity-downgrades.ts call instead of raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the source row carries the source's incarnation, last commit, drain lock, pass row and admission
 *    probes (null while the stored admission reads as normal; otherwise pinned only while an open pass row holds the
 *    live drain lease); an archived or missing source has no row. A brain with no managed write has no committed page,
 *    held push or fence, head request, recovery record, cursor, failure or identity downgrade. A managed-sync cursor
 *    reads with its failure and manifest path, the failed cursor first; an old incarnation's cursor counts as retired.
 *  - Regression: an engine that refuses these as raw SQL (the Rust engine did, which failed `gbrain sync status`
 *    outright and turned its oldest-blocker and recovery probes `unknown`), or answers a pinned admission wrongly.
 *  - Why existing coverage misses it: the sync-status tests run on PGLite and Postgres only, and the pins test checks
 *    statement text, not answers.
 *  - Seam: none. Real engines; the seeded-cursor case writes its rows with `executeRaw`, so a Rust brain stops there.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { writePassRow } from '../../src/core/persistence/sync-pass-row.ts';
import { readManagedSyncFailures } from '../../src/core/persistence/sync-failures.ts';
import { listIdentityDowngrades } from '../../src/core/sync-identity-downgrades.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const incarnationOf = async (engine: BrainEngine, id: string) => String((await engine.readSourceState(id))!.incarnation);

/** The source row minus what differs per arm (random incarnation, clock stamps). */
async function sourceRow(engine: BrainEngine, id: string) {
  const row = await engine.readSyncStatusSourceRow<Record<string, unknown>, unknown, unknown>(id);
  if (!row) return null;
  const { incarnation, pass_updated_at, pass_read_at, last_sync_at, ...rest } = row;
  return { ...rest, incarnation: incarnation === await incarnationOf(engine, id), pass_updated: pass_updated_at !== null, read_at: pass_read_at !== null, synced: last_sync_at !== null };
}

describe('engine parity: sync status reads', () => {
  parityTest('a brain with no managed write: the source row, nothing committed, held, pending, failed or downgraded',
    { methods: ['readSyncStatusSourceRow', 'readSyncStatusCommittedRow', 'readManagedSyncCursorHeader', 'readRetiredManagedSyncCursor', 'readManagedSyncFailureRows',
      'readOrphanedManagedSyncFailureRows', 'readSyncHeadRequestRow', 'readSyncRecoveryProbeRow', 'readIdentityDowngradeRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      const inc = await incarnationOf(engine, 'repo');
      const committed = await engine.readSyncStatusCommittedRow('repo');
      const result = {
        source: await sourceRow(engine, 'repo'),
        missing: await engine.readSyncStatusSourceRow('missing'),
        committed: { ...committed, n: Number(committed.n) },
        header: await engine.readManagedSyncCursorHeader('repo', inc, ''),
        retired: await engine.readRetiredManagedSyncCursor('repo', inc),
        failures: await engine.readManagedSyncFailureRows(null),
        scopedFailures: await engine.readManagedSyncFailureRows(['repo']),
        orphaned: await engine.readOrphanedManagedSyncFailureRows(null),
        head: await engine.readSyncHeadRequestRow('repo', { timeoutMs: 2_000 }),
        recovery: await engine.readSyncRecoveryProbeRow('repo', { timeoutMs: 2_000 }).then(row => ({ ...row, n: Number(row.n) })),
        downgrades: await engine.readIdentityDowngradeRows(['repo']),
        callers: { failures: await readManagedSyncFailures(engine, ['repo']), downgrades: await listIdentityDowngrades(engine, ['repo']) },
      };
      expect(result as unknown).toEqual({
        source: {
          incarnation: true, last_commit: null, drain_lock: false, pass_value: null, pass_updated: false, read_at: true, withheld: null, synced: false,
          identity_reviews: null, held_deletes: null, config: {},
          admission_stored: null, admission_row_value: null, admission_set_at: null, admission_pinned: null, admission_destructive: null,
          writeback_failed: null, refresh: null,
        },
        missing: null,
        committed: { n: 0, git_push_held: false, fence_held: false, last_committed_at: null },
        header: null, retired: null, failures: [], scopedFailures: [], orphaned: [], head: null,
        recovery: { n: 0, request_id: null, slug: null, blocked: null },
        downgrades: [], callers: { failures: [], downgrades: [] },
      });
      return result;
    });

  parityTest('a restricted admission is pinned only while an open pass row holds the live drain lease',
    { methods: ['readSyncStatusSourceRow', 'writeSyncPassRow', 'acquireCycleLock', 'setConfig'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      const inc = await incarnationOf(engine, 'repo');
      const token = randomUUID();
      await engine.setConfig('sync.admission', ' paused ');
      const unpinned = await sourceRow(engine, 'repo');
      await engine.acquireCycleLock(syncLockId('repo'), { holderPid: 4242, holderHost: 'parity-host', acquisitionToken: token, ttlMinutes: 30, stealGraceSeconds: 0 });
      const lockedNoPass = await sourceRow(engine, 'repo');
      await writePassRow(engine, { source_id: 'repo', incarnation: inc, lease_token: token, step: 1, telemetry: { outcome: 'open', started_at: '2000-01-01T00:00:00.000Z' } } as never, { pin: true });
      const pinned = await sourceRow(engine, 'repo');
      await writePassRow(engine, { source_id: 'repo', incarnation: inc, lease_token: token, step: 2, telemetry: { outcome: 'synced', started_at: '2000-01-01T00:00:00.000Z' } } as never);
      const closed = await sourceRow(engine, 'repo');
      await engine.setConfig('sync.admission', 'normal');
      const normal = await sourceRow(engine, 'repo');
      const probes = (row: Awaited<ReturnType<typeof sourceRow>>) =>
        row && { stored: row.admission_stored, pinned: row.admission_pinned, destructive: row.admission_destructive, lock: row.drain_lock };
      const result = {
        unpinned: probes(unpinned), lockedNoPass: probes(lockedNoPass), pinned: probes(pinned), closed: probes(closed), normal: probes(normal),
        other: probes(await sourceRow(engine, 'other')),
      };
      expect(result).toEqual({
        unpinned: { stored: ' paused ', pinned: false, destructive: false, lock: false },
        lockedNoPass: { stored: ' paused ', pinned: false, destructive: false, lock: true },
        pinned: { stored: ' paused ', pinned: true, destructive: false, lock: true },
        closed: { stored: ' paused ', pinned: false, destructive: false, lock: true },
        normal: { stored: 'normal', pinned: null, destructive: null, lock: true },
        other: { stored: 'normal', pinned: null, destructive: null, lock: false },
      });
      return result;
    });

  parityTest('managed-sync cursors read with their failure and manifest path, the failed one first (a finished one still heads); an old incarnation\'s cursor is retired (a managed sync writes them, so a Rust brain stops at the write)',
    { methods: ['readManagedSyncCursorHeader', 'readRetiredManagedSyncCursor', 'readManagedSyncFailureRows', 'readOrphanedManagedSyncFailureRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      const inc = await incarnationOf(engine, 'repo');
      const put = (op: string, fingerprint: string, keys: unknown[], at: string) => engine.executeRaw(
        'INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, $4::timestamptz)', [op, fingerprint, JSON.stringify(keys), at]);
      const cursor = (runId: string, over: Record<string, unknown> = {}) =>
        ({ sourceId: 'repo', incarnation: inc, runId, index: 1, target: 'abc', syncOptions: null, processingOptions: null, ...over });
      await put('managed-sync', 'k-new', [cursor('run-new')], '2026-01-02T00:00:00.000Z');
      await put('managed-sync', 'k-failed', [cursor('run-failed', { index: -1 })], '2026-01-01T00:00:00.000Z');
      await put('managed-sync', 'k-done', [cursor('run-done', { done: true })], '2026-01-03T00:00:00.000Z');
      await put('managed-sync', 'k-old', [cursor('run-old', { incarnation: 'retired-incarnation' })], '2025-12-01T00:00:00.000Z');
      await put('managed-sync-manifest', 'run-new', [{ path: 'a.md' }, { path: 'b.md' }], '2026-01-02T00:00:00.000Z');
      await put('managed-sync-manifest', 'run-failed', [{ path: 'x.md' }, { path: 'y.md' }], '2026-01-01T00:00:00.000Z');
      const failure = (fingerprint: string) => ({ source_id: 'repo', source_incarnation: inc, path: 'y.md', code: 'import_failed', cursor_key: fingerprint });
      await put('managed-sync-failure', 'k-failed', [failure('k-failed')], '2026-01-01T00:00:01.000Z');
      await put('managed-sync-failure', 'k-orphan', [failure('k-orphan')], '2026-01-01T00:00:02.000Z');
      const rows = await engine.readManagedSyncFailureRows<Record<string, unknown>, unknown, { cursor_key: string }>(['repo']);
      const result = {
        newest: (await engine.readManagedSyncCursorHeader<{ runId: string }>('repo', inc, ''))?.key,
        failedFirst: (await engine.readManagedSyncCursorHeader<{ runId: string }>('repo', inc, 'k-failed'))?.key,
        retired: await engine.readRetiredManagedSyncCursor('repo', inc),
        rows: rows.map(r => ({ key: r.cursor_key, runId: r.value.runId, index: r.value.index, path: r.path, failure: r.failure?.cursor_key ?? null, receipt: r.receipt }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        orphaned: (await engine.readOrphanedManagedSyncFailureRows<{ cursor_key: string }>(null)).map(r => r.failure.cursor_key),
      };
      expect(result).toEqual({
        newest: 'k-done', failedFirst: 'k-failed', retired: { first_seen: '2025-12-01T00:00:00.000Z' },
        rows: [
          { key: 'k-failed', runId: 'run-failed', index: -1, path: 'y.md', failure: 'k-failed', receipt: null },
          { key: 'k-new', runId: 'run-new', index: 1, path: 'b.md', failure: null, receipt: null },
        ],
        orphaned: ['k-orphan'],
      });
      return result;
    });
});
