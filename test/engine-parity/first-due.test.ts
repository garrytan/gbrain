/**
 * BrainEngine parity — the persisted first-due clock of the oldest unsynced commit: readNotifierFirstDue
 * (engine-sql/notifier.ts), read through its real caller readFirstDue (sync-pending.ts; doctor managed_sync_latency and
 * source-health.ts lag). Three arms: PGLite always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every existing source of the request has an entry (archived included, a missing id has none). The clock
 *    is the earlier of the notifier row's first_due_at while its state is not idle and the oldest freshness marker
 *    whose wanted_head is null or differs from last_commit; an idle row and a pull marker set no clock. The observed
 *    head is the notifier row's, null without one. An empty request reads nothing.
 *  - Regression: readFirstDue ran raw SQL that the Rust engine refuses, and it rethrew the refusal, so on a Rust brain
 *    doctor's latency check and the source lag read failed or fell back to "no clock" for every source.
 *  - Why existing coverage misses it: test/sync-pending*.test.ts run PGLite or Postgres only.
 *  - Seam: none. Real engines, the real notifier store writes and the real readFirstDue. Each clock is compared with
 *    the first_due_at the same engine stored for the row or marker it must come from, never with a fixed value.
 */
import { describe, expect } from 'bun:test';
import { readNotifierSources, readMarkers, upsertMarker, writeCoverage, writeState } from '../../src/core/notifier/store.ts';
import { readFirstDue } from '../../src/core/sync-pending.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

describe('engine parity: the first-due clock of the oldest unsynced commit', () => {
  parityTest('readFirstDue takes the earlier of a busy notifier row and a due freshness marker, per existing source', {
    methods: ['readFirstDue'],
  }, async (engine, backend) => {
    for (const id of ['alpha', 'beta', 'gamma', 'delta', 'eps', 'gone']) await createSource(engine, backend, id, {}, `/srv/brain/${id}`);
    await archiveSource(engine, backend, 'gone');
    // beta: a due row first, then a freshness marker; the row's clock is the earlier one.
    await writeState(engine, 'beta', { state: 'due', reason: 'commit', firstDue: 'keep' });
    await writeCoverage(engine, 'beta', { head: 'b'.repeat(40), mode: 'poll', ownerHostId: 'host-b', ownerKind: 'serve', ownerPid: 1 });
    await Bun.sleep(5);
    await upsertMarker(engine, { sourceId: 'beta', intent: 'freshness', wantedHead: null, requestedBy: 'lock_busy' });
    // gamma: an idle row with a head and a freshness marker that names a head; the marker sets the clock.
    await writeCoverage(engine, 'gamma', { head: 'c'.repeat(40), mode: 'watch', ownerHostId: 'host-c', ownerKind: 'serve', ownerPid: 2 });
    await upsertMarker(engine, { sourceId: 'gamma', intent: 'freshness', wantedHead: 'c'.repeat(40), requestedBy: 'notifier' });
    // delta: an idle row set by a cleared state and a pull marker only; no clock.
    await writeState(engine, 'delta', { state: 'idle', firstDue: 'clear' });
    await upsertMarker(engine, { sourceId: 'delta', intent: 'pull', wantedHead: null, requestedBy: 'sync_trigger' });
    // gone: archived, with a due row; still read.
    await writeState(engine, 'gone', { state: 'retry', reason: 'sync_failed', firstDue: 'keep' });
    const rows = new Map((await readNotifierSources(engine)).map(r => [r.source_id, r]));
    const markers = await readMarkers(engine);
    const marker = (id: string) => markers.find(m => m.source_id === id && m.intent === 'freshness');
    const stored = { beta: ms(rows.get('beta')?.first_due_at), gamma: ms(marker('gamma')?.first_due_at), gone: ms(rows.get('gone')?.first_due_at) };
    const due = await readFirstDue(engine, ['alpha', 'beta', 'gamma', 'delta', 'eps', 'gone', 'missing', 'beta']);
    const empty = await readFirstDue(engine, []);
    const entry = (id: string) => due.get(id) ?? 'absent';
    const observed = {
      ids: [...due.keys()].sort(),
      storedClocks: Object.values(stored).every(v => typeof v === 'number' && Number.isFinite(v)),
      alpha: entry('alpha'),
      betaFromRow: due.get('beta')?.firstDueAt === ms(rows.get('beta')?.first_due_at),
      betaRowEarlier: (ms(rows.get('beta')?.first_due_at) ?? Infinity) < (ms(marker('beta')?.first_due_at) ?? -Infinity),
      betaHead: due.get('beta')?.observedHead,
      gammaFromMarker: due.get('gamma')?.firstDueAt === ms(marker('gamma')?.first_due_at),
      gammaHead: due.get('gamma')?.observedHead,
      delta: entry('delta'),
      eps: entry('eps'),
      goneFromRow: due.get('gone')?.firstDueAt === ms(rows.get('gone')?.first_due_at),
      missing: entry('missing'),
      empty: empty.size,
    };
    expect(observed).toEqual({
      ids: ['alpha', 'beta', 'delta', 'eps', 'gamma', 'gone'],
      storedClocks: true,
      alpha: { firstDueAt: null, observedHead: null },
      betaFromRow: true,
      betaRowEarlier: true,
      betaHead: 'b'.repeat(40),
      gammaFromMarker: true,
      gammaHead: 'c'.repeat(40),
      delta: { firstDueAt: null, observedHead: null },
      eps: { firstDueAt: null, observedHead: null },
      goneFromRow: true,
      missing: 'absent',
      empty: 0,
    });
    return observed;
  });
});
