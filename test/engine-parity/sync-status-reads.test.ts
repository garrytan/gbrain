/**
 * BrainEngine parity — the row reads `gbrain sync status` makes (`readSyncStatusSourceRow`, `readSyncStatusCommittedRow`,
 * `readManagedSyncCursorHeader`, `readRetiredManagedSyncCursor`, `readManagedSyncFailureRows`,
 * `readOrphanedManagedSyncFailureRows`, `readSyncHeadRequestRow`, `readSyncRecoveryProbeRow`, `readIdentityDowngradeRows`),
 * which persistence/sync-status.ts, sync-failures.ts, sync-drain.ts and sync-identity-downgrades.ts call instead of raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the source row carries the source's incarnation, last commit, drain lock, pass row, Apple Contacts
 *    identity reviews and held deletes, and admission
 *    probes (null while the stored admission reads as normal; otherwise pinned only while an open pass row holds the
 *    live drain lease) and the Apple Contacts identity reviews and held deletes stored for that source; an archived or
 *    missing source has no row. A brain with no managed write has no committed page,
 *    held push or fence, head request, recovery record, cursor, failure or identity downgrade. A managed-sync cursor
 *    reads with its failure and manifest path, the failed cursor first; an old incarnation's cursor counts as retired.
 *    The source row also carries the source's Apple Contacts identity-review and held-deletion checkpoints, raw.
 *    An identity-downgrade record reads while it is open (no disposition, its old page still soft-deleted at the
 *    recorded `old_deleted_at`, in the record's source), oldest `recorded_at` first, with the live slugs of its source
 *    at its new path (null when none); a malformed `old_deleted_at` refuses as the timestamptz cast does.
 *    `listIdentityDowngrades` offers the restore on a bound source, a connector source and a source with no checkout;
 *    on an unbound source with a checkout only a single-process brain (PGLite or Rust) not activated database-only offers it.
 *  - Regression: an engine that refuses these as raw SQL (the Rust engine did, which failed `gbrain sync status`
 *    outright and turned its oldest-blocker and recovery probes `unknown`), or answers a pinned admission wrongly. The
 *    Rust engine also refused readIdentityDowngradeRows once one record existed, rather than join its pages, and
 *    listIdentityDowngrades's restore probe read `sources` through raw SQL, which the Rust engine refuses.
 *  - Why existing coverage misses it: the sync-status tests run on PGLite and Postgres only, and the pins test checks
 *    statement text, not answers.
 *  - Seam: none. Real engines; the seeded-cursor case writes its rows with writeCheckpointAt (harness SQL on the SQL arms, a
 *    store write on Rust), and the other checkpoint case writes through writeOpCheckpointRecord.
 *    The identity-downgrade records go through the harness fixture `recordIdentityDowngrade`.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { writePassRow } from '../../src/core/persistence/sync-pass-row.ts';
import { readManagedSyncFailures } from '../../src/core/persistence/sync-failures.ts';
import { identityRemedyParts, listIdentityDowngrades, recordIdentityDowngrades } from '../../src/core/sync-identity-downgrades.ts';
import { APPLE_CONTACTS_PENDING_DELETES_OP, APPLE_CONTACTS_REVIEW_OP } from '../../src/core/apple-contacts/review-status.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { DATABASE_ONLY_SOURCES_KEY } from '../../src/core/persistence/unbound-source.ts';
import { createSource, parityArms, recordIdentityDowngrade, writeCheckpointAt } from './harness.ts';
import { seedHostBinding, seedSource, seedSourceBinding, seedWorktree } from './persistence-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST = '00000000-0000-4000-8000-00000000000a';

const incarnationOf = async (engine: BrainEngine, id: string) => String((await engine.readSourceState(id))!.incarnation);

/** The source row minus what differs per arm (random incarnation, clock stamps). */
async function sourceRow(engine: BrainEngine, id: string) {
  const row = await engine.readSyncStatusSourceRow<Record<string, unknown>, unknown, unknown>(id);
  if (!row) return null;
  const { incarnation, pass_updated_at, pass_read_at, last_sync_at, ...rest } = row;
  return { ...rest, incarnation: incarnation === await incarnationOf(engine, id), pass_updated: pass_updated_at !== null, read_at: pass_read_at !== null, synced: last_sync_at !== null };
}

describe('engine parity: sync status reads', () => {
  parityTest('the source row carries the Apple Contacts identity reviews and held deletes stored for that source only',
    { methods: ['readSyncStatusSourceRow', 'writeOpCheckpointKeys'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      await engine.writeOpCheckpointKeys(APPLE_CONTACTS_REVIEW_OP, 'repo', ['people-b']);
      await engine.writeOpCheckpointKeys(APPLE_CONTACTS_PENDING_DELETES_OP, 'repo', ['delete-floor']);
      const pick = (row: Awaited<ReturnType<typeof sourceRow>>) => row && { reviews: row.identity_reviews, held: row.held_deletes };
      const result = { repo: pick(await sourceRow(engine, 'repo')), other: pick(await sourceRow(engine, 'other')) };
      expect(result).toEqual({ repo: { reviews: ['people-b'], held: ['delete-floor'] }, other: { reviews: null, held: null } });
      return result;
    });

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
          identity_reviews: null, held_deletes: null,
          admission_stored: null, admission_row_value: null, admission_set_at: null, admission_pinned: null, admission_destructive: null,
          writeback_failed: null, refresh: null, config: {},
        },
        missing: null,
        committed: { n: 0, git_push_held: false, fence_held: false, last_committed_at: null },
        header: null, retired: null, failures: [], scopedFailures: [], orphaned: [], head: null,
        recovery: { n: 0, request_id: null, slug: null, blocked: null },
        downgrades: [], callers: { failures: [], downgrades: [] },
      });
      return result;
    });

  parityTest('the source row carries the Apple Contacts identity reviews and held deletes recorded for that source only',
    { methods: ['readSyncStatusSourceRow', 'writeOpCheckpointKeys'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      await engine.writeOpCheckpointKeys(APPLE_CONTACTS_REVIEW_OP, 'repo', ['review-a', 'review-b']);
      await engine.writeOpCheckpointKeys(APPLE_CONTACTS_PENDING_DELETES_OP, 'repo', ['delete-a']);
      const pick = (row: Awaited<ReturnType<typeof sourceRow>>) => row && { reviews: row.identity_reviews, held: row.held_deletes };
      const result = { repo: pick(await sourceRow(engine, 'repo')), other: pick(await sourceRow(engine, 'other')) };
      expect(result).toEqual({
        repo: { reviews: ['review-a', 'review-b'], held: ['delete-a'] },
        other: { reviews: null, held: null },
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

  parityTest('managed-sync cursors read with their failure and manifest path, the failed one first (a finished one still heads); an old incarnation\'s cursor is retired',
    { methods: ['readManagedSyncCursorHeader', 'readRetiredManagedSyncCursor', 'readManagedSyncFailureRows', 'readOrphanedManagedSyncFailureRows', 'readOpCheckpointRecord'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      const inc = await incarnationOf(engine, 'repo');
      const cursor = (runId: string, over: Record<string, unknown> = {}) =>
        ({ sourceId: 'repo', incarnation: inc, runId, index: 1, target: 'abc', syncOptions: null, processingOptions: null, ...over });
      const failure = (fingerprint: string) => ({ source_id: 'repo', source_incarnation: inc, path: 'y.md', code: 'import_failed', cursor_key: fingerprint });
      // Written in stamp order: the Rust store stamps each write with its own clock (writeCheckpointAt).
      const seeds: Array<[string, string, unknown[], string]> = [
        ['managed-sync', 'k-old', [cursor('run-old', { incarnation: 'retired-incarnation' })], '2025-12-01T00:00:00.000Z'],
        ['managed-sync', 'k-failed', [cursor('run-failed', { index: -1 })], '2026-01-01T00:00:00.000Z'],
        ['managed-sync-manifest', 'run-failed', [{ path: 'x.md' }, { path: 'y.md' }], '2026-01-01T00:00:00.000Z'],
        ['managed-sync-failure', 'k-failed', [failure('k-failed')], '2026-01-01T00:00:01.000Z'],
        ['managed-sync-failure', 'k-orphan', [failure('k-orphan')], '2026-01-01T00:00:02.000Z'],
        ['managed-sync', 'k-new', [cursor('run-new')], '2026-01-02T00:00:00.000Z'],
        ['managed-sync-manifest', 'run-new', [{ path: 'a.md' }, { path: 'b.md' }], '2026-01-02T00:00:00.000Z'],
        ['managed-sync', 'k-done', [cursor('run-done', { done: true })], '2026-01-03T00:00:00.000Z'],
      ];
      for (const [op, fingerprint, keys, at] of seeds) await writeCheckpointAt(engine, backend, op, fingerprint, keys, at);
      const oldStamp = (await engine.readOpCheckpointRecord('managed-sync', 'k-old'))?.updated_at ?? null;
      const rows = await engine.readManagedSyncFailureRows<Record<string, unknown>, unknown, { cursor_key: string }>(['repo']);
      const result = {
        newest: (await engine.readManagedSyncCursorHeader<{ runId: string }>('repo', inc, ''))?.key,
        failedFirst: (await engine.readManagedSyncCursorHeader<{ runId: string }>('repo', inc, 'k-failed'))?.key,
        retired: await engine.readRetiredManagedSyncCursor('repo', inc).then(r => r && { firstSeenIsTheOldCursorStamp: r.first_seen === oldStamp }),
        rows: rows.map(r => ({ key: r.cursor_key, runId: r.value.runId, index: r.value.index, path: r.path, failure: r.failure?.cursor_key ?? null, receipt: r.receipt }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        orphaned: (await engine.readOrphanedManagedSyncFailureRows<{ cursor_key: string }>(null)).map(r => r.failure.cursor_key),
      };
      expect(result).toEqual({
        newest: 'k-done', failedFirst: 'k-failed', retired: { firstSeenIsTheOldCursorStamp: true },
        rows: [
          { key: 'k-failed', runId: 'run-failed', index: -1, path: 'y.md', failure: 'k-failed', receipt: null },
          { key: 'k-new', runId: 'run-new', index: 1, path: 'b.md', failure: null, receipt: null },
        ],
        orphaned: ['k-orphan'],
      });
      return result;
    });

  parityTest('the source row carries the source\'s identity-review and held-deletion checkpoints, and not another source\'s',
    { methods: ['readSyncStatusSourceRow', 'writeOpCheckpointRecord'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      const put = (op: string, fingerprint: string, keys: unknown[]) => engine.writeOpCheckpointRecord(op, fingerprint, keys);
      const review = [{ slug: 'people/alice-example', candidates: [{ source_id: 'repo', slug: 'people/alice-example' }], decided: null }];
      const held = [{ ids: ['c1'], held: { code: 'apple_contacts_delete_floor', contacts: 3, owned: 4, since: '2026-01-01T00:00:00.000Z' } }];
      await put(APPLE_CONTACTS_REVIEW_OP, 'repo', review);
      await put(APPLE_CONTACTS_PENDING_DELETES_OP, 'repo', held);
      const decode = (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) : raw;
      const row = await engine.readSyncStatusSourceRow('repo');
      const other = await engine.readSyncStatusSourceRow('other');
      const result = {
        repo: { identity_reviews: decode(row!.identity_reviews), held_deletes: decode(row!.held_deletes) },
        other: { identity_reviews: other!.identity_reviews, held_deletes: other!.held_deletes },
      };
      expect(result as unknown).toEqual({ repo: { identity_reviews: review, held_deletes: held }, other: { identity_reviews: null, held_deletes: null } });
      return result;
    });

  parityTest('the topology, freshness and movement reads answer a claimed binding the same when called directly', {
    methods: ['worktreeClaimStore', 'writeOpCheckpointRecord', 'listHostTopologyRows', 'listWorktreeMembers', 'listFreshnessTargets',
      'readSourceMovementRows'],
  }, async (engine, backend) => {
    const host = randomUUID();
    const worktree = await seedWorktree(engine, host);
    const incarnations: Record<string, string> = {};
    for (const id of ['mv-b', 'mv-a']) {
      incarnations[id] = await seedSource(engine, backend, id);
      await seedSourceBinding(engine, id, incarnations[id]!, worktree, id);
    }
    await seedHostBinding(engine, worktree, host, '/var/tmp/gbrain-parity-movement');
    const inc = incarnations['mv-a']!;
    await engine.writeOpCheckpointRecord('sync-hold-summary', `mv-a:${inc}`, [{ source_id: 'mv-a', incarnation: inc, count: 2, stalled: 1, fences: 0, concurrent: 0 }]);
    const topology = (await engine.listHostTopologyRows(host)).map(row => ({ ...row, owner_epoch: String(row.owner_epoch), topology_generation: String(row.topology_generation) }));
    const moved = await engine.readSourceMovementRows({ source_id: 'mv-a', worktree_id: worktree, source_incarnation: inc } as never);
    const mark = moved.watermark;
    const hold = moved.hold;
    const result = {
      topology: topology.map(row => ({ ...row, worktree_id: row.worktree_id === worktree, owner_host_id: row.owner_host_id === host })),
      members: await engine.listWorktreeMembers(worktree),
      targets: await engine.listFreshnessTargets(worktree, inc, 24, 10),
      mark: mark && { last_commit_at: mark.last_commit_at ?? null, admitted: Number(mark.admitted), admitted_since: mark.admitted_since ?? null },
      head: moved.head,
      hold: hold && { count: hold.count, stalled: hold.stalled, fences: hold.fences, concurrent: hold.concurrent, stamped: hold.updated_at !== null },
      noHold: (await engine.readSourceMovementRows({ source_id: 'mv-b', worktree_id: worktree, source_incarnation: incarnations['mv-b']! } as never)).hold,
    };
    expect(result).toEqual({
      topology: [{ worktree_id: true, owner_host_id: true, owner_epoch: '0', state: 'active', topology_generation: '1', local_path: '/var/tmp/gbrain-parity-movement', coordination_path: '/var/tmp/gbrain-parity-movement.lock' }],
      members: [{ source_id: 'mv-a', relative_path: 'mv-a' }, { source_id: 'mv-b', relative_path: 'mv-b' }],
      targets: [],
      mark: { last_commit_at: null, admitted: 0, admitted_since: null },
      head: null,
      hold: { count: 2, stalled: 1, fences: 0, concurrent: 0, stamped: true },
      noHold: null,
    });
    return result;
  });

  parityTest('identity-downgrade records read while open, oldest first, with the live slugs of their source at the new path; a malformed old_deleted_at refuses',
    { methods: ['putPage', 'softDeletePage', 'readPageOrigin', 'readIdentityDowngradeRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      const page = (slug: string, sourceId: string, sourcePath: string) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '', source_path: sourcePath }, { sourceId });
      const gone = async (slug: string, sourceId: string) => { await page(slug, sourceId, `${slug}.md`); await engine.softDeletePage(slug, { sourceId }); };
      for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/f']) await gone(slug, 'default');
      await gone('notes/h', 'other');
      await page('notes/a2', 'default', 'notes/a2.md');
      await page('notes/h2', 'other', 'notes/h2.md');
      await page('notes/h2-default', 'default', 'notes/h2.md');
      const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
      const ids = {
        a: await recordIdentityDowngrade(engine, backend, 'default', 'notes/a', { from: 'notes/a.md', to: 'notes/a2.md', recorded_at: at(2) }),
        b: await recordIdentityDowngrade(engine, backend, 'default', 'notes/b', { from: 'notes/b.md', to: 'notes/never.md', recorded_at: at(1) }),
        h: await recordIdentityDowngrade(engine, backend, 'other', 'notes/h', { from: 'notes/h.md', to: 'notes/h2.md', recorded_at: at(3) }),
      };
      // Closed, stale (deleted at another time), not soft-deleted, or naming another source: none of these reads.
      await recordIdentityDowngrade(engine, backend, 'default', 'notes/c', { from: 'notes/c.md', to: 'notes/a2.md', recorded_at: at(4), disposition: { kind: 'closed', at: at(5) } });
      await recordIdentityDowngrade(engine, backend, 'default', 'notes/d', { from: 'notes/d.md', to: 'notes/a2.md', recorded_at: at(4), old_deleted_at: '2000-01-01 00:00:00+00' });
      await recordIdentityDowngrade(engine, backend, 'default', 'notes/a2', { from: 'notes/x.md', to: 'notes/a2.md', recorded_at: at(4), old_deleted_at: '2000-01-01 00:00:00+00' });
      await recordIdentityDowngrade(engine, backend, 'default', 'notes/f', { from: 'notes/f.md', to: 'notes/a2.md', recorded_at: at(4), source_id: 'other' });
      const view = (rows: Array<{ record: unknown; new_slugs: string[] | null }>) => rows.map(row => {
        const record = (typeof row.record === 'string' ? JSON.parse(row.record) : row.record) as Record<string, unknown>;
        return { old_slug: record.old_slug, source_id: record.source_id, to: record.to, recorded_at: record.recorded_at, new_slugs: row.new_slugs,
          id: Object.entries(ids).find(([, id]) => id === Number(record.old_page_id))?.[0] ?? null };
      });
      const reads = {
        all: view(await engine.readIdentityDowngradeRows(null)),
        def: view(await engine.readIdentityDowngradeRows(['default'])),
        other: view(await engine.readIdentityDowngradeRows(['other', 'missing'])),
        none: view(await engine.readIdentityDowngradeRows([])),
      };
      await gone('notes/m', 'default');
      await recordIdentityDowngrade(engine, backend, 'default', 'notes/m', { from: 'notes/m.md', to: 'notes/a2.md', recorded_at: at(6), old_deleted_at: 'garbage' });
      const malformed = await engine.readIdentityDowngradeRows(null).then(() => 'answered',
        (e: Error) => /invalid input syntax for type timestamp with time zone: "garbage"/.test(e.message) ? 'timestamptz refusal' : e.message);
      const result = { ...reads, malformed };
      const A = { old_slug: 'notes/a', source_id: 'default', to: 'notes/a2.md', recorded_at: at(2), new_slugs: ['notes/a2'], id: 'a' };
      const B = { old_slug: 'notes/b', source_id: 'default', to: 'notes/never.md', recorded_at: at(1), new_slugs: null, id: 'b' };
      const H = { old_slug: 'notes/h', source_id: 'other', to: 'notes/h2.md', recorded_at: at(3), new_slugs: ['notes/h2'], id: 'h' };
      expect(result).toEqual({ all: [B, A, H], def: [B, A], other: [H], none: [], malformed: 'timestamptz refusal' });
      return result;
    });

  parityTest('listIdentityDowngrades offers the restore on a bound, a connector and a checkout-less source; an unbound checkout only on a single-process engine not activated database-only',
    { methods: ['putPage', 'softDeletePage', 'readPageOrigin', 'readIdentityDowngradeRows', 'getSource', 'getWorktreeBinding', 'setConfig', 'worktreeClaimStore'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'bound', {}, '/var/tmp/restore-bound');
      await createSource(engine, backend, 'loose', {}, '/var/tmp/restore-loose');
      await createSource(engine, backend, 'conn', { kind: 'google' }, '/var/tmp/restore-conn');
      await createSource(engine, backend, 'bare', {});
      await claimWorktreeBinding(engine, async store => {
        const source = await store.lockSource('bound');
        const id = randomUUID();
        await store.insertWorktree({ id, ownerHostId: HOST, ownerEpoch: 1, topologyGeneration: 1, state: 'active', manifest: {} });
        await store.insertSourceBinding({ sourceId: 'bound', incarnation: source!.incarnation, worktreeId: id, relativePath: '', topologyGeneration: 1 });
        await store.insertHostBinding({ worktreeId: id, hostId: HOST, localPath: '/var/tmp/restore-bound', coordinationPath: '/var/tmp/restore-coord', gitDurability: 'enabled' });
      });
      const sources = ['bound', 'loose', 'conn', 'bare'];
      for (const [i, sourceId] of sources.entries()) {
        await engine.putPage('notes/old', { type: 'note', title: 'old', compiled_truth: 'Old body.', timeline: '', source_path: 'notes/old.md' }, { sourceId });
        await engine.softDeletePage('notes/old', { sourceId });
        await recordIdentityDowngrade(engine, backend, sourceId, 'notes/old', { from: 'notes/old.md', to: 'notes/new.md', recorded_at: `2026-01-0${i + 1}T00:00:00.000Z` });
      }
      const offered = async () => Object.fromEntries((await listIdentityDowngrades(engine)).map(r => [r.source_id, r.restore_available]));
      const all = await offered();
      const scoped = (await listIdentityDowngrades(engine, ['loose'])).map(r => [r.source_id, r.restore_available]);
      await engine.setConfig(DATABASE_ONLY_SOURCES_KEY, JSON.stringify(['loose']));
      const activated = await offered();
      // The unbound checkout follows decideUnboundWrite: a single-process engine (PGLite and Rust) claims it unless it is
      // activated database-only; Postgres refuses it. Each arm answers whether it gave its engine's rule.
      const pglite = backend !== 'postgres';
      const result: Record<string, unknown> = {
        all: { ...all, loose: all.loose === pglite }, scoped: scoped.map(([id, v]) => [id, v === pglite]),
        activated: { ...activated, loose: activated.loose === false },
      };
      expect(result).toEqual({
        all: { bound: true, loose: true, conn: true, bare: true }, scoped: [['loose', true]],
        activated: { bound: true, loose: true, conn: true, bare: true },
      });
      return result;
    });

  parityTest('recordIdentityDowngrades records a renamed file\'s old page with what it carries, and the remedy binds both pages of the pair', {
    methods: ['putPage', 'addLink', 'insertFact', 'softDeletePage', 'readIdentityDowngradeOldPage', 'countIdentityDowngradeCarry', 'readRenameIdentityRows',
      'writeOpCheckpointRecord', 'readIdentityDowngradeRows', 'readIdentityRemedySide', 'readPersistenceBrainId'],
  }, async (engine) => {
    const page = (slug: string, path: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '', source_path: path });
    await page('notes/old', 'notes/old.md');
    await page('notes/new', 'notes/new.md');
    await page('notes/other', 'notes/other.md');
    await engine.addLink('notes/old', 'notes/other', 'see', 'mentions');
    await engine.addLink('notes/other', 'notes/old', 'back', 'mentions');
    await engine.insertFact({ fact: 'The old note names alice-example', entity_slug: 'notes/old', source: 'mcp:remember', valid_from: new Date('2026-05-01T00:00:00Z') } as never, { source_id: 'default' });
    await engine.softDeletePage('notes/old');
    const pairs = [
      { from: 'notes/old.md', to: 'notes/new.md', similarity: 0.4, reason: 'no_identity_signal' as const },
      // No soft-deleted page recorded this path: nothing to carry, nothing recorded.
      { from: 'notes/never.md', to: 'notes/new.md', similarity: 0.4, reason: 'no_identity_signal' as const },
    ];
    const recorded = await recordIdentityDowngrades(engine, 'default', pairs);
    expect(recorded.length).toBe(1);
    const [record] = recorded;
    expect(record!.old_deleted_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/);
    const listed = await listIdentityDowngrades(engine as never, ['default']);
    const parts = await identityRemedyParts(engine, record!, 'carry');
    const side = (s: { page_id: number; slug: string; revision: string; deleted: boolean } | null) =>
      s && { slug: s.slug, deleted: s.deleted, revision: /^[0-9a-f-]{36}$/.test(s.revision) };
    const result = {
      record: { old_slug: record!.old_slug, new_slug: record!.new_slug, facts: record!.facts, links: record!.links, aliases: record!.aliases,
        recorded_at_is_deleted_at: new Date(record!.recorded_at).getTime() === new Date(record!.old_deleted_at.replace(' ', 'T').replace('+00', 'Z')).getTime() },
      listed: listed.map(r => ({ old_slug: r.old_slug, new_slug: r.new_slug, old_page_id: r.old_page_id === record!.old_page_id })),
      parts: { old: side(parts.old), new: side(parts.new), disposition: parts.disposition, kind: parts.kind },
      direct: {
        oldPage: (await engine.readIdentityDowngradeOldPage('default', 'notes/old.md', 'notes/old'))?.slug ?? null,
        noOldPage: await engine.readIdentityDowngradeOldPage('default', 'notes/new.md', 'notes/new'),
        carry: Object.fromEntries(Object.entries(await engine.countIdentityDowngradeCarry('default', 'notes/old', record!.old_page_id)).map(([k, v]) => [k, Number(v)])),
        sideBySlug: (await engine.readIdentityRemedySide('default', { slug: 'notes/new' }))?.deleted ?? null,
        sideMissing: await engine.readIdentityRemedySide('default', { slug: 'notes/missing' }),
      },
    };
    expect(result).toEqual({
      record: { old_slug: 'notes/old', new_slug: 'notes/new', facts: 1, links: 2, aliases: 0, recorded_at_is_deleted_at: true },
      listed: [{ old_slug: 'notes/old', new_slug: 'notes/new', old_page_id: true }],
      parts: { old: { slug: 'notes/old', deleted: true, revision: true }, new: { slug: 'notes/new', deleted: false, revision: true }, disposition: 'carry', kind: 'rename-identity-v1' },
      direct: { oldPage: 'notes/old', noOldPage: null, carry: { facts: 1, links: 2, aliases: 0 }, sideBySlug: false, sideMissing: null },
    });
    return result;
  });
});
