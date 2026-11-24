/**
 * BrainEngine parity — a source's last_commit: advanceSourceCommit (engine-sql/sources.ts), written through its real
 * caller writeSyncAnchor (sync-anchor.ts), and every notifier read that compares with it: readSourceFreshness
 * (notifier/status.ts), readDueWantedMarkers, pruneSatisfiedWantedMarkers, settleFreshnessMarker, readNotifierStatusRows
 * and readNotifierFirstDue (sync-pending.ts readFirstDue), plus getSource and listSourceRecords. Three arms: PGLite
 * always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a last_commit advance stamps last_commit and last_sync_at; given a newest-commit time it also stamps
 *    newest_content_at (null clears it), and without one it keeps the stored value. A watched source whose observed head
 *    equals last_commit reads current, another head reads behind. A freshness marker that names the head last_commit
 *    holds is not due, is not counted by the status rows and sets no first-due clock; the prune deletes the freshness and
 *    pull markers that name that head and keeps the others; the settle deletes a freshness marker naming another head
 *    only when the checkout head the drainer saw equals last_commit.
 *  - Regression: the Rust brain refused the sync anchor's raw UPDATE and kept no last_commit, so after a sync a watched
 *    source on a Rust brain read behind for ever, a marker for the synced head stayed due, and the prune and the
 *    settle left satisfied markers in place.
 *  - Why existing coverage misses it: test/sync-anchor*.test.ts run PGLite or Postgres only, and
 *    test/engine-parity/wanted-markers.test.ts keeps every source's last_commit null.
 *  - Seam: none. Real engines, the real writeSyncAnchor, the real notifier store and readSourceFreshness. Timestamps are
 *    compared as "set", or with the value the caller passed, never with the clock. The PGLite arm has no lease (the
 *    owner is live when its pid runs on this host), so the coverage names this host and the parent process's pid.
 */
import { describe, expect } from 'bun:test';
import type { WantedMarker } from '../../src/core/engine-sql/notifier.ts';
import { pruneSatisfiedMarkers, readDueMarkers, readMarkers, upsertMarker, writeCoverage } from '../../src/core/notifier/store.ts';
import { readSourceFreshness } from '../../src/core/notifier/status.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { writeSyncAnchor } from '../../src/core/sync-anchor.ts';
import { readFirstDue } from '../../src/core/sync-pending.ts';
import { SYNC_ON_COMMIT_KEY } from '../../src/core/sync-config-keys.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SYNCED = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const NEWEST_MS = Date.parse('2026-01-02T03:04:05.678Z');
const order = (rows: WantedMarker[]) => rows.map(m => `${m.source_id}/${m.intent}/${m.wanted_head === SYNCED ? 'synced' : m.wanted_head === OTHER ? 'other' : m.wanted_head}`);
const isoOf = (v: unknown) => (v === null || v === undefined ? null : new Date(v instanceof Date ? v : String(v)).toISOString());

describe('engine parity: a source keeps the last_commit its sync anchor advanced', () => {
  parityTest('a last_commit advance stamps the source, and freshness, the markers and the first-due clock read it', {
    methods: ['advanceSourceCommit', 'getSource', 'listSourceRecords', 'readNotifierStatusRows', 'readDueWantedMarkers',
      'pruneSatisfiedWantedMarkers', 'settleFreshnessMarker', 'readFirstDue'],
  }, async (engine, backend) => {
    const host = hostIdFor(engine);
    for (const id of ['alpha', 'beta', 'gamma']) await createSource(engine, backend, id, {}, `/srv/brain/${id}`);
    const before = await engine.getSource('alpha');
    await writeSyncAnchor(engine, 'alpha', 'last_commit', SYNCED);
    await writeSyncAnchor(engine, 'beta', 'last_commit', OTHER, NEWEST_MS);
    await writeSyncAnchor(engine, 'beta', 'last_commit', SYNCED);
    await writeSyncAnchor(engine, 'gamma', 'last_commit', SYNCED, NEWEST_MS);
    await writeSyncAnchor(engine, 'gamma', 'last_commit', SYNCED, null);
    const after = await engine.getSource('alpha');
    const records = (await engine.listSourceRecords()).filter(r => ['alpha', 'beta', 'gamma'].includes(r.id))
      .map(r => ({ id: r.id, last_commit: r.last_commit, last_sync_at: r.last_sync_at !== null, newest_content_at: isoOf(r.newest_content_at) }));

    await engine.setConfig(SYNC_ON_COMMIT_KEY, 'true');
    await engine.claimNotifierLease({ hostId: host, ownerId: 'owner-a', kind: 'serve', pid: process.ppid, leaseMs: 60_000 });
    await writeCoverage(engine, 'alpha', { head: SYNCED, mode: 'watch', ownerHostId: host, ownerKind: 'serve', ownerPid: process.ppid });
    await writeCoverage(engine, 'beta', { head: OTHER, mode: 'poll', ownerHostId: host, ownerKind: 'serve', ownerPid: process.ppid });
    const freshness = (await readSourceFreshness(engine, { sourceIds: ['alpha', 'beta'] })).map(f => [f.source_id, f.state, f.observed_head === SYNCED]);

    await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: SYNCED, requestedBy: 'notifier' });
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: SYNCED, requestedBy: 'webhook' });
    await upsertMarker(engine, { sourceId: 'beta', intent: 'freshness', wantedHead: OTHER, requestedBy: 'notifier' });
    await upsertMarker(engine, { sourceId: 'beta', intent: 'pull', wantedHead: OTHER, requestedBy: 'webhook' });
    const due = order(await readDueMarkers(engine)).sort();
    const counted = (await engine.readNotifierStatusRows(['alpha', 'beta'])).map(r => [r.id, r.last_commit === SYNCED, r.due_markers]);
    const clock = await readFirstDue(engine, ['alpha', 'beta']);
    const betaFresh = (await readMarkers(engine)).find(m => m.source_id === 'beta' && m.intent === 'freshness');
    const clocks = { alpha: clock.get('alpha')?.firstDueAt ?? null, betaFromMarker: clock.get('beta')?.firstDueAt === Date.parse(betaFresh!.first_due_at) };

    await pruneSatisfiedMarkers(engine, ['alpha', 'beta']);
    const pruned = order(await readMarkers(engine)).sort();
    await engine.settleFreshnessMarker('beta', betaFresh!.generation, OTHER);
    const settleOther = order(await readMarkers(engine)).sort();
    await engine.settleFreshnessMarker('beta', betaFresh!.generation, SYNCED);
    const settleSynced = order(await readMarkers(engine)).sort();

    const observed = {
      before: { last_commit: before?.last_commit ?? null, last_sync_at: before?.last_sync_at ?? null },
      after: { last_commit: after?.last_commit === SYNCED, last_sync_at: after?.last_sync_at !== null },
      records, freshness, due, counted, clocks, pruned, settleOther, settleSynced,
    };
    expect(observed).toEqual({
      before: { last_commit: null, last_sync_at: null },
      after: { last_commit: true, last_sync_at: true },
      records: [
        { id: 'alpha', last_commit: SYNCED, last_sync_at: true, newest_content_at: null },
        { id: 'beta', last_commit: SYNCED, last_sync_at: true, newest_content_at: new Date(NEWEST_MS).toISOString() },
        { id: 'gamma', last_commit: SYNCED, last_sync_at: true, newest_content_at: null },
      ],
      freshness: [['alpha', 'current', true], ['beta', 'behind', false]],
      due: ['alpha/pull/synced', 'beta/freshness/other', 'beta/pull/other'],
      counted: [['alpha', true, 1], ['beta', true, 2]],
      clocks: { alpha: null, betaFromMarker: true },
      pruned: ['beta/freshness/other', 'beta/pull/other'],
      settleOther: ['beta/freshness/other', 'beta/pull/other'],
      settleSynced: ['beta/pull/other'],
    });
    return observed;
  });
});
