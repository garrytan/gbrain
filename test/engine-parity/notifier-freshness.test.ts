/**
 * BrainEngine parity — the commit notifier's per-source state and coverage rows and the freshness status rows
 * (engine-sql/notifier.ts): readNotifierSources, writeNotifierState, writeNotifierCoverage, recordNotifierSyncerHost
 * (notifier/store.ts) and readNotifierStatusRows, hasNotifierCoverage (notifier/status.ts readSourceFreshness and
 * readNotifierBlock). Three arms: PGLite always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a state write inserts the row (idle defaults, first_due_at only for 'keep', the error with its time) and
 *    a later write keeps first_due_at, attempts and the last error unless the patch names them, and 'clear' empties
 *    first_due_at; a write for a source that does not exist writes nothing. Coverage records the head, the mode and the
 *    owner. The syncer write records the host and changes nothing when the host is the same. The status rows list every
 *    source that is not archived, in id order, with its row and whether the owner host's lease is live. With
 *    `sync.on_commit` off and no coverage the search freshness notice is empty; with a resident's coverage and its live
 *    lease the notice reads the source as current (no head) or behind (a head the source has not reached), and a source
 *    with no coverage reads not_monitored.
 *  - Regression: the Rust brain answered no freshness at all (status.ts returned [] for it) and its resident could not
 *    record state or coverage, so search on a Rust brain never said a source was behind. An engine that drops the kept
 *    first_due_at, rewrites the error on a patch that omits it, writes a row for a missing source, or lists an archived
 *    source would show the wrong notifier state in sync status and search.
 *  - Why existing coverage misses it: the notifier's own tests run PGLite or Postgres only, or the in-memory store
 *    (test/helpers/notifier-memory-store.ts); test/rust-engine-store.test.ts pinned the empty answer on Rust.
 *  - Seam: none. Real engines, typed members and the real readSourceFreshness. Timestamps are compared as "set" and
 *    "ordered", never by value. The PGLite arm has no lease (the owner is live when its pid runs on this host), so the
 *    coverage names this host and the parent process's pid.
 */
import { describe, expect } from 'bun:test';
import type { NotifierSourceRow } from '../../src/core/engine-sql/notifier.ts';
import { readNotifierSources, recordSyncerHost, writeCoverage, writeState } from '../../src/core/notifier/store.ts';
import { readSourceFreshness } from '../../src/core/notifier/status.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { SYNC_ON_COMMIT_KEY } from '../../src/core/sync-config-keys.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** A row with each timestamp replaced by whether it is set. */
function shape(row: NotifierSourceRow | undefined): unknown {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = k.endsWith('_at') ? v !== null : v;
  return out;
}

describe('engine parity: commit notifier state, coverage and freshness', () => {
  parityTest('the notifier store writes state, coverage and the syncer host, and only for a source that exists', {
    methods: ['readNotifierSources', 'writeNotifierState', 'writeNotifierCoverage', 'recordNotifierSyncerHost'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    const read = async (id: string) => (await readNotifierSources(engine, [id]))[0];
    await writeState(engine, 'alpha', { state: 'retry', reason: 'sync_failed', firstDue: 'keep', attempts: 2, nextRetryInMs: 60_000,
      error: { code: 'E_SYNC', message: 'x'.repeat(2100), tracePath: '/srv/trace/alpha.jsonl' } });
    const inserted = await read('alpha');
    await writeState(engine, 'alpha', { state: 'running', firstDue: 'keep', progress: true });
    const kept = await read('alpha');
    await writeState(engine, 'alpha', { state: 'idle', firstDue: 'clear', attempts: 0, error: null });
    const cleared = await read('alpha');
    await writeState(engine, 'missing', { state: 'due', firstDue: 'keep' });
    await writeCoverage(engine, 'beta', { head: 'abc123', mode: 'poll', ownerHostId: 'host-b', ownerKind: 'serve', ownerPid: 4242 });
    const covered = await read('beta');
    await recordSyncerHost(engine, 'beta', 'host-s');
    const syncer = await read('beta');
    await recordSyncerHost(engine, 'beta', 'host-s');
    const same = await read('beta');
    const all = (await readNotifierSources(engine)).map(r => r.source_id);
    const observed = {
      inserted: shape(inserted), errorLength: inserted?.last_error?.length, kept: shape(kept),
      firstDueKept: kept?.first_due_at === inserted?.first_due_at, cleared: shape(cleared),
      covered: shape(covered), syncer: shape(syncer), sameUnchanged: JSON.stringify(same) === JSON.stringify(syncer), all,
      missingRows: (await readNotifierSources(engine, ['missing'])).length,
    };
    const none = { syncer_host_id: null, observed_head: null, observed_at: false, detection_mode: null, owner_host_id: null, owner_kind: null, owner_pid: null, owner_seen_at: false };
    expect(observed).toEqual({
      inserted: { source_id: 'alpha', ...none, state: 'retry', reason: 'sync_failed', first_due_at: true, attempts: 2, next_retry_at: true,
        last_progress_at: false, last_error_code: 'E_SYNC', last_error: 'x'.repeat(2000), last_error_at: true, trace_path: '/srv/trace/alpha.jsonl' },
      errorLength: 2000,
      kept: { source_id: 'alpha', ...none, state: 'running', reason: null, first_due_at: true, attempts: 2, next_retry_at: false,
        last_progress_at: true, last_error_code: 'E_SYNC', last_error: 'x'.repeat(2000), last_error_at: true, trace_path: '/srv/trace/alpha.jsonl' },
      firstDueKept: true,
      cleared: { source_id: 'alpha', ...none, state: 'idle', reason: null, first_due_at: false, attempts: 0, next_retry_at: false,
        last_progress_at: true, last_error_code: null, last_error: null, last_error_at: false, trace_path: null },
      covered: { source_id: 'beta', state: 'idle', reason: null, first_due_at: false, attempts: 0, next_retry_at: false, last_progress_at: false,
        last_error_code: null, last_error: null, last_error_at: false, trace_path: null, syncer_host_id: null,
        observed_head: 'abc123', observed_at: true, detection_mode: 'poll', owner_host_id: 'host-b', owner_kind: 'serve', owner_pid: 4242, owner_seen_at: true },
      syncer: { source_id: 'beta', state: 'idle', reason: null, first_due_at: false, attempts: 0, next_retry_at: false, last_progress_at: false,
        last_error_code: null, last_error: null, last_error_at: false, trace_path: null, syncer_host_id: 'host-s',
        observed_head: 'abc123', observed_at: true, detection_mode: 'poll', owner_host_id: 'host-b', owner_kind: 'serve', owner_pid: 4242, owner_seen_at: true },
      sameUnchanged: true,
      all: ['alpha', 'beta'],
      missingRows: 0,
    });
    return observed;
  });

  parityTest('readNotifierStatusRows joins each live source to its row and its owner lease', {
    methods: ['claimNotifierLease', 'writeNotifierCoverage', 'writeNotifierState', 'readNotifierStatusRows', 'hasNotifierCoverage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await createSource(engine, backend, 'gone', {}, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const before = await engine.hasNotifierCoverage();
    await writeState(engine, 'alpha', { state: 'due', reason: 'commit', firstDue: 'keep' });
    const stateOnly = await engine.hasNotifierCoverage();
    await engine.claimNotifierLease({ hostId: 'host-live', ownerId: 'owner-a', kind: 'serve', pid: 101, leaseMs: 60_000 });
    await writeCoverage(engine, 'alpha', { head: null, mode: 'watch', ownerHostId: 'host-live', ownerKind: 'serve', ownerPid: 101 });
    await writeCoverage(engine, 'gone', { head: null, mode: 'watch', ownerHostId: 'host-live', ownerKind: 'serve', ownerPid: 101 });
    await writeCoverage(engine, 'beta', { head: 'abc123', mode: 'poll', ownerHostId: 'host-none', ownerKind: 'jobs-worker', ownerPid: 202 });
    const rows = (await engine.readNotifierStatusRows(null)).filter(r => r.id !== 'default');
    const one = await engine.readNotifierStatusRows(['beta', 'gone']);
    const observed = {
      before, stateOnly, after: await engine.hasNotifierCoverage(),
      rows: rows.map(r => ({ ...r, first_due_at: r.first_due_at !== null, observed_at: r.observed_at !== null, owner_seen_at: r.owner_seen_at !== null,
        lease_expires_at: r.lease_expires_at !== null && Date.parse(r.lease_expires_at) > Date.now() })),
      one: one.map(r => r.id),
    };
    const blank = { reason: null, attempts: 0, next_retry_at: null, last_error_code: null, last_error: null, last_error_at: null, trace_path: null, last_commit: null, due_markers: 0 };
    expect(observed).toEqual({
      before: false, stateOnly: false, after: true,
      rows: [
        { id: 'alpha', ...blank, state: 'due', reason: 'commit', first_due_at: true, observed_head: null, observed_at: true, detection_mode: 'watch',
          owner_host_id: 'host-live', owner_kind: 'serve', owner_pid: 101, owner_seen_at: true, lease_live: true, lease_expires_at: true },
        { id: 'beta', ...blank, state: 'idle', first_due_at: false, observed_head: 'abc123', observed_at: true, detection_mode: 'poll',
          owner_host_id: 'host-none', owner_kind: 'jobs-worker', owner_pid: 202, owner_seen_at: true, lease_live: false, lease_expires_at: false },
      ],
      one: ['beta'],
    });
    return observed;
  });

  parityTest('search freshness: off until opted in, then current, behind or not monitored per source', {
    methods: ['claimNotifierLease', 'writeNotifierCoverage', 'readNotifierStatusRows', 'hasNotifierCoverage'],
  }, async (engine, backend) => {
    const host = hostIdFor(engine);
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await createSource(engine, backend, 'quiet', {}, '/srv/brain/quiet');
    const scope = { sourceIds: ['alpha', 'beta', 'quiet'] };
    const off = await readSourceFreshness(engine, scope);
    await engine.setConfig(SYNC_ON_COMMIT_KEY, 'true');
    const optedIn = await readSourceFreshness(engine, scope);
    // The owner: this host's lease on Postgres and Rust; on PGLite a running pid on this host (the parent process).
    await engine.claimNotifierLease({ hostId: host, ownerId: 'owner-a', kind: 'serve', pid: process.ppid, leaseMs: 60_000 });
    await writeCoverage(engine, 'alpha', { head: null, mode: 'watch', ownerHostId: host, ownerKind: 'serve', ownerPid: process.ppid });
    await writeCoverage(engine, 'beta', { head: 'abc123', mode: 'poll', ownerHostId: host, ownerKind: 'serve', ownerPid: process.ppid });
    const watched = await readSourceFreshness(engine, scope, [{ source_id: 'beta', missing: 1, stale: 2 }]);
    const strip = (list: typeof watched) => list.map(f => ({ ...f, observed_at: f.observed_at !== null }));
    const observed = { off, optedIn: strip(optedIn), watched: strip(watched) };
    const quiet = { source_id: 'quiet', state: 'not_monitored' as const, observed_head: null, observed_at: false, mode: null, held_count: 0 };
    expect(observed).toEqual({
      off: [],
      optedIn: [
        { source_id: 'alpha', state: 'not_monitored' as const, observed_head: null, observed_at: false, mode: null, held_count: 0 },
        { source_id: 'beta', state: 'not_monitored' as const, observed_head: null, observed_at: false, mode: null, held_count: 0 },
        quiet,
      ],
      watched: [
        { source_id: 'alpha', state: 'current' as const, observed_head: null, observed_at: true, mode: 'watch', held_count: 0 },
        { source_id: 'beta', state: 'behind' as const, observed_head: 'abc123', observed_at: true, mode: 'poll', held_count: 3 },
        quiet,
      ],
    });
    return observed;
  });
});
