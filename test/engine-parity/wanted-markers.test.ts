/**
 * BrainEngine parity — the commit notifier's wanted markers (engine-sql/notifier.ts): upsertWantedMarker,
 * attachWantedMarkerJob, readWantedMarkers, readDueWantedMarkers, pruneSatisfiedWantedMarkers, clearWantedMarker and
 * settleFreshnessMarker (notifier/store.ts upsertMarker, attachMarkerJob, readMarkers, readDueMarkers,
 * pruneSatisfiedMarkers, clearMarker and settleMarkers) and listSourceWantedMarkers (notifier/status.ts
 * readNotifierBlock). Three arms: PGLite always, Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an upsert inserts generation 1 and a re-record bumps the generation, takes the new head and requester,
 *    keeps first_due_at and keeps the old job id when no new one is given; a missing source records nothing (the
 *    member answers null and upsertMarker throws). Each intent is its own row. Reads order by first_due_at, then source,
 *    then intent, and filter by source. With no last_commit every marker is due, the prune deletes nothing, and the
 *    settle clears only a freshness marker that names no head; attach and clear act only at the generation read. The
 *    status rows count the due markers, and the sync status notifier block lists the source's markers.
 *  - Regression: the Rust brain refused every marker member, so a webhook, a sync trigger or a notifier commit on a
 *    Rust brain recorded no sync request and `gbrain sync status` showed no pending markers. An engine that resets
 *    first_due_at on a re-record, drops the job id, records a marker for a missing source, or clears a marker at a
 *    stale generation would lose or duplicate sync requests.
 *  - Why existing coverage misses it: the notifier's marker tests run PGLite or Postgres only, or the in-memory store
 *    (test/helpers/notifier-memory-store.ts); test/rust-engine-store.test.ts pinned the refusal on Rust.
 *  - Seam: none. Real engines, typed members and the real readNotifierBlock. Timestamps are compared as "set" and
 *    "ordered", never by value. The first cases keep last_commit null; the last stores one through advanceSourceCommit,
 *    which the Rust store once ignored here (every marker read as due, the prune deleted nothing), and reads
 *    readFirstDue, which `gbrain sources status` needs.
 */
import { describe, expect } from 'bun:test';
import type { WantedMarker } from '../../src/core/engine-sql/notifier.ts';
import {
  attachMarkerJob, clearMarker, pruneSatisfiedMarkers, readDueMarkers, readMarkers, settleMarkers, upsertMarker,
} from '../../src/core/notifier/store.ts';
import { readNotifierBlock } from '../../src/core/notifier/status.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** A marker without its timestamps. */
const shape = (m: WantedMarker | null) => m && [m.source_id, m.intent, m.wanted_head, m.generation, m.requested_by, m.job_id];
const order = (rows: WantedMarker[]) => rows.map(m => `${m.source_id}/${m.intent}`);
/** Lets the clock move so first_due_at orders the markers the same way on every engine. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('engine parity: commit notifier wanted markers', () => {
  parityTest('an upsert inserts generation 1, a re-record bumps it keeping first_due_at and the job, a missing source records nothing', {
    methods: ['upsertWantedMarker', 'readWantedMarkers'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    const first = await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'h1', requestedBy: 'webhook', jobId: 7 });
    await tick();
    const again = await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: null, requestedBy: 'notifier' });
    const third = await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'h3', requestedBy: 'sync_trigger', jobId: 9 });
    const pull = await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: null, requestedBy: 'webhook' });
    const missing = await engine.upsertWantedMarker({ sourceId: 'missing', intent: 'pull', wantedHead: null, requestedBy: 'webhook' });
    const thrown = await upsertMarker(engine, { sourceId: 'missing', intent: 'pull', wantedHead: null, requestedBy: 'webhook' })
      .then(() => null, (e: Error) => e.message);
    const observed = {
      first: shape(first), again: shape(again), third: shape(third), pull: shape(pull), missing, thrown,
      firstDueKept: again.first_due_at === first.first_due_at && third.first_due_at === first.first_due_at,
      updatedMoved: Date.parse(again.updated_at) > Date.parse(first.updated_at),
      stored: (await readMarkers(engine)).map(shape),
    };
    expect(observed).toEqual({
      first: ['alpha', 'freshness', 'h1', 1, 'webhook', 7],
      again: ['alpha', 'freshness', null, 2, 'notifier', 7],
      third: ['alpha', 'freshness', 'h3', 3, 'sync_trigger', 9],
      pull: ['alpha', 'pull', null, 1, 'webhook', null],
      missing: null,
      thrown: 'source missing does not exist; no wanted marker recorded',
      firstDueKept: true, updatedMoved: true,
      stored: [['alpha', 'freshness', 'h3', 3, 'sync_trigger', 9], ['alpha', 'pull', null, 1, 'webhook', null]],
    });
    return observed;
  });

  parityTest('reads order by first_due_at, source and intent, filter by source, and the status rows and block count the markers', {
    methods: ['upsertWantedMarker', 'readWantedMarkers', 'readDueWantedMarkers', 'listSourceWantedMarkers', 'readNotifierStatusRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await upsertMarker(engine, { sourceId: 'beta', intent: 'pull', wantedHead: null, requestedBy: 'webhook' });
    await tick();
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'full', wantedHead: null, requestedBy: 'sync_trigger' });
    await tick();
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'abc123', requestedBy: 'notifier' });
    const listed = await engine.listSourceWantedMarkers('alpha');
    const block = await readNotifierBlock(engine, 'alpha');
    const observed = {
      all: order(await readMarkers(engine)),
      alpha: order(await readMarkers(engine, ['alpha', 'nobody'])),
      due: order(await readDueMarkers(engine)),
      dueBeta: order(await readDueMarkers(engine, ['beta'])),
      listed: listed.map(m => ({ ...m, first_due_at: typeof m.first_due_at === 'string' && !Number.isNaN(Date.parse(m.first_due_at)) })),
      nobody: await engine.listSourceWantedMarkers('nobody'),
      blockMarkers: block?.pending_markers.map(m => [m.intent, m.wanted_head, m.requested_by]) ?? null,
      statusDue: (await engine.readNotifierStatusRows(['alpha', 'beta'])).map(r => [r.id, r.due_markers]),
    };
    expect(observed).toEqual({
      all: ['beta/pull', 'alpha/full', 'alpha/freshness'],
      alpha: ['alpha/full', 'alpha/freshness'],
      due: ['beta/pull', 'alpha/full', 'alpha/freshness'],
      dueBeta: ['beta/pull'],
      listed: [
        { intent: 'full', wanted_head: null, first_due_at: true, requested_by: 'sync_trigger' },
        { intent: 'freshness', wanted_head: 'abc123', first_due_at: true, requested_by: 'notifier' },
      ],
      nobody: [],
      blockMarkers: [['full', null, 'sync_trigger'], ['freshness', 'abc123', 'notifier']],
      statusDue: [['alpha', 2], ['beta', 1]],
    });
    return observed;
  });

  parityTest('attach, clear and settle act only at the generation read; with no last_commit the prune deletes nothing', {
    methods: ['upsertWantedMarker', 'attachWantedMarkerJob', 'clearWantedMarker', 'settleFreshnessMarker', 'pruneSatisfiedWantedMarkers', 'readDueWantedMarkers'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: null, requestedBy: 'webhook' });
    const pull = await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: null, requestedBy: 'webhook' });
    await attachMarkerJob(engine, 'alpha', 'pull', 1, 11);
    const staleAttach = (await readMarkers(engine))[0]?.job_id;
    await attachMarkerJob(engine, 'alpha', 'pull', pull.generation, 12);
    const attached = (await readMarkers(engine))[0]?.job_id;
    const clears = [
      await clearMarker(engine, 'alpha', 'pull', 1),
      await clearMarker(engine, 'alpha', 'full', 2),
      await clearMarker(engine, 'alpha', 'pull', 2),
      await clearMarker(engine, 'alpha', 'pull', 2),
    ];
    // A freshness marker that names no head settles at its own generation only.
    const fresh = await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: null, requestedBy: 'notifier' });
    await engine.settleFreshnessMarker('alpha', fresh.generation + 1, null);
    const staleSettle = order(await readMarkers(engine));
    await engine.settleFreshnessMarker('alpha', fresh.generation, 'abc123');
    const settled = order(await readMarkers(engine));
    // One that names a head stays due (no last_commit holds it), and settleMarkers clears the pull and full markers a
    // run satisfied while returning what is still due.
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'abc123', requestedBy: 'notifier' });
    await tick();
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: 'abc123', requestedBy: 'webhook' });
    await tick();
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'full', wantedHead: null, requestedBy: 'sync_trigger' });
    await pruneSatisfiedMarkers(engine, ['alpha']);
    const afterPrune = order(await readMarkers(engine));
    const read = await readMarkers(engine, ['alpha']);
    const left = order(await settleMarkers(engine, 'alpha', read, { pulled: true, full: false, checkoutHead: 'abc123' }));
    const observed = { staleAttach, attached, clears, staleSettle, settled, afterPrune, left };
    expect(observed).toEqual({
      staleAttach: null, attached: 12, clears: [false, false, true, false],
      staleSettle: ['alpha/freshness'], settled: [],
      afterPrune: ['alpha/freshness', 'alpha/pull', 'alpha/full'],
      left: ['alpha/freshness', 'alpha/full'],
    });
    return observed;
  });

  parityTest('with a stored last_commit a marker naming it is not due, the prune and settle clear it, and readFirstDue reads the earlier due time', {
    methods: ['advanceSourceCommit', 'upsertWantedMarker', 'readDueWantedMarkers', 'pruneSatisfiedWantedMarkers', 'settleFreshnessMarker',
      'readNotifierStatusRows', 'listNotifierHostSourceRows', 'writeNotifierState', 'writeNotifierCoverage', 'readNotifierSources', 'readFirstDue'],
  }, async (engine, backend) => {
    for (const id of ['alpha', 'beta', 'gamma']) await createSource(engine, backend, id, {}, `/srv/brain/${id}`);
    await engine.advanceSourceCommit('alpha', 'c1', null);
    const ms = (v: unknown) => v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))).getTime();
    // alpha: a due notifier row with an observed head, and a freshness marker naming the reached commit (not due).
    await engine.writeNotifierState('alpha', { state: 'due', firstDue: 'keep' });
    await engine.writeNotifierCoverage('alpha', { head: 'c2', mode: 'poll', ownerHostId: 'host-a', ownerKind: 'serve', ownerPid: 1 });
    await tick();
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'c1', requestedBy: 'notifier' });
    // beta: an idle notifier row (its due time does not count) and a freshness marker naming no head (due).
    await engine.writeNotifierState('beta', { state: 'idle', firstDue: 'clear' });
    const betaMarker = await upsertMarker(engine, { sourceId: 'beta', intent: 'freshness', wantedHead: null, requestedBy: 'notifier' });
    const alphaRow = (await engine.readNotifierSources(['alpha']))[0]!;
    const due = new Map((await engine.readFirstDue(['gamma', 'alpha', 'beta', 'missing'])).map(r => [r.source_id, r]));
    // Each time is compared with this backend's own row or marker time, so the arms compare which time was read, not clocks.
    const own: Record<string, number | null> = { alpha: ms(alphaRow.first_due_at), beta: ms(betaMarker.first_due_at), gamma: null };
    const firstDue = Object.fromEntries([...due.keys()].sort().map(id => [id, { observed_head: due.get(id)!.observed_head, first_due_at: ms(due.get(id)!.first_due_at) === own[id] ? 'expected' : ms(due.get(id)!.first_due_at) }]));
    const dueMarkers = order(await engine.readDueWantedMarkers(['alpha', 'beta']));
    const status = (await engine.readNotifierStatusRows(['alpha'])).map(r => [r.id, r.last_commit, Number(r.due_markers)]);
    const host = (await engine.listNotifierHostSourceRows()).map(r => [r.id, r.last_commit]);
    // The prune deletes the freshness and pull markers that name the reached commit; a full marker stays.
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'pull', wantedHead: 'c1', requestedBy: 'webhook' });
    await upsertMarker(engine, { sourceId: 'alpha', intent: 'full', wantedHead: 'c1', requestedBy: 'sync_trigger' });
    await engine.pruneSatisfiedWantedMarkers(['alpha']);
    const afterPrune = order(await readMarkers(engine, ['alpha']));
    // A freshness marker naming another head settles when the source reached the checkout head the drainer saw.
    await tick();
    const other = await upsertMarker(engine, { sourceId: 'alpha', intent: 'freshness', wantedHead: 'c9', requestedBy: 'notifier' });
    await engine.settleFreshnessMarker('alpha', other.generation, 'c8');
    const unsettled = order(await readMarkers(engine, ['alpha']));
    await engine.settleFreshnessMarker('alpha', other.generation, 'c1');
    const settled = order(await readMarkers(engine, ['alpha']));
    const observed = { firstDue, dueMarkers, status, host, afterPrune, unsettled, settled };
    expect(observed).toEqual({
      firstDue: {
        alpha: { observed_head: 'c2', first_due_at: 'expected' },
        beta: { observed_head: null, first_due_at: 'expected' },
        gamma: { observed_head: null, first_due_at: 'expected' },
      },
      dueMarkers: ['beta/freshness'],
      status: [['alpha', 'c1', 0]],
      host: [['alpha', 'c1'], ['beta', null], ['default', null], ['gamma', null]],
      afterPrune: ['alpha/full'],
      unsettled: ['alpha/full', 'alpha/freshness'],
      settled: ['alpha/full'],
    });
    return observed;
  });
});
