/**
 * BrainEngine parity: queue health reads (engine-sql/jobs-health.ts), the counts `gbrain doctor`'s queue checks, the
 * advisor's stalled-jobs collector and the submit-time queue probe ask of `minion_jobs`: readQueueHealthSignals,
 * listWaitingByQueue, readQueueDivergence, listQueueWedgeCounts, listPrivateQueueHealth, readWedgeSignals,
 * readOldestWaitingAge and listStuckActiveJobsByName.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read answers the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts). An empty queue answers zero counts, empty lists and null times everywhere
 *    (the Rust arm included); a seeded queue answers the counts master's statements counted: which statuses and names a
 *    count includes, what a 1 h or 24 h cut-off lets in, the limit of five with the full total beside it, the
 *    `prompt_too_long:` match, the dream phase a dead subagent's key names, a delayed job that is due, a lapsed lock
 *    against a live one, and the bytewise order of equal counts.
 *  - Regression: an engine that counts delayed as waiting, a lapsed lock as live, a cancellation outside its prefix or
 *    window, or drops the total behind the five listed would make `gbrain doctor` call a healthy queue wedged (or a
 *    wedged one healthy), and make the advisor and the submit probe misreport it.
 *  - Why existing coverage misses it: test/doctor-*.test.ts and test/supervisor-wedge.test.ts script `executeRaw` or run
 *    PGLite only; nothing compares the engines on one scenario, and a Rust engine has no raw SQL.
 *  - Seam: the seeded case writes `minion_jobs` rows with `executeRaw` (BrainEngine has no typed job writer on this
 *    base), so it declares `requires: 'raw_sql'` and the Rust arm must end on the typed `raw_sql` refusal. The Rust arm
 *    therefore proves the empty-queue answers only; test/n3-sql-move-parity.test.ts proves the seeded rows against
 *    master's statements on both SQL engines. Ages and minutes are checked as a range, ids relative to the first job.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedJobs } from '../helpers/n3-seed.ts';

const { parityTest } = parityArms(testBackends());

const TTL = 'waiting_ttl_expired';

describe('engine parity: queue health reads', () => {
  parityTest('an empty queue answers zero counts, empty lists and null times from every read', { methods: ['readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
    'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName'] }, async (engine) => {
    const signals = await engine.readQueueHealthSignals({ waitingThreshold: 1, oldWaitingHours: 1, windowHours: 24, stalledAfterHours: 1 });
    const divergence = await engine.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: TTL });
    const wedge = await engine.readWedgeSignals('default', ['work']);
    const out = {
      signals, divergence, wedge,
      waiting: await engine.listWaitingByQueue(),
      wedgeCounts: await engine.listQueueWedgeCounts(),
      privateQueues: await engine.listPrivateQueueHealth(),
      oldest: await engine.readOldestWaitingAge('default'),
      stuck: await engine.listStuckActiveJobsByName(),
    };
    expect(out).toEqual({
      signals: { stalled: [], depth: [], rss_kills: 0, prompt_too_long: [], old_embed_backfill: [] },
      divergence: { divergence: [], ttl_cancelled: [] },
      wedge: { stalled: 0, activeHealthy: 0, waiting: 0, waitingClaimable: 0, lastCompleted: null, lastCompletedClaimable: null },
      waiting: [], wedgeCounts: [], privateQueues: [], oldest: null, stuck: [],
    });
    return out;
  });

  parityTest('seeded jobs count by status, name, window and lock the way the queue checks read them', { methods: ['readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
    'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName'], requires: 'raw_sql' }, async (engine) => {
    const recent = (n: number | null) => n !== null && n >= 0 && n < 600;
    const ids = await seedJobs(engine, [
      // Active and stalled for hours: three old, one live-lock, one lapsed lock.
      { name: 'stall-a', status: 'active', started: '-3 hours', created: '-4 hours', lockUntil: '1 hour' },
      { name: 'stall-b', status: 'active', started: '-2 hours', created: '-4 hours', lockUntil: '1 hour' },
      { name: 'fresh', status: 'active', started: '-5 minutes', lockUntil: '1 hour' },
      { name: 'lapsed', status: 'active', started: '-10 minutes', lockUntil: '-5 minutes' },
      { name: 'twice', status: 'active', started: '-10 minutes', lockUntil: '1 hour', stalledCounter: 2 },
      // Waiting depth: 'Zed' and 'alpha' tie at two; a delayed job never counts as waiting.
      { name: 'sync', status: 'waiting' }, { name: 'sync', status: 'waiting' }, { name: 'sync', status: 'waiting' },
      { name: 'Zed', status: 'waiting' }, { name: 'Zed', status: 'waiting' }, { name: 'alpha', status: 'waiting' }, { name: 'alpha', status: 'waiting' },
      { name: 'sync', status: 'delayed', delayUntil: '1 hour' },
      { name: 'embed-backfill', status: 'waiting', queue: 'q-embed', created: '-3 hours' },
      // Watchdog kills inside the day, one outside it, one with other text.
      { name: 'job-a', status: 'dead', finished: '-1 hour', errorText: 'aborted: watchdog' },
      { name: 'job-b', status: 'failed', finished: '-1 hour', errorText: 'aborted: watchdog' },
      { name: 'job-c', status: 'dead', finished: '-30 hours', errorText: 'aborted: watchdog' },
      { name: 'job-d', status: 'failed', finished: '-1 hour', errorText: 'something else' },
      // prompt_too_long by dream phase.
      { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: a', idempotencyKey: 'dream:patterns:one' },
      { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: b', idempotencyKey: 'dream:synthesize:one' },
      { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: c', data: { __released_idempotency_key: 'dream:patterns:kept' } },
      { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: d' },
      { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'promptXtooXlong: wildcard', idempotencyKey: 'dream:patterns:wild' },
      // Completions and cancellations for the divergence read.
      { name: 'alpha', status: 'completed', finished: '-2 hours' },
      { name: 'alpha', status: 'cancelled', finished: '-1 hour', errorText: `${TTL}: waited > 1h in queue` },
      { name: 'alpha', status: 'cancelled', finished: '-40 hours', errorText: `${TTL}: waited > 1h in queue` },
      { name: 'alpha', status: 'cancelled', finished: '-1 hour', errorText: 'cancelled by an operator' },
      // A private dream queue stays out of the wedge counts and in the private health.
      { name: 'dream-work', status: 'waiting', queue: 'dream-inline-one', created: '-2 hours', data: { source_id: 'src-one' } },
      { name: 'dream-work', status: 'paused', queue: 'dream-inline-one', data: { source_id: 'src-one' } },
    ]);
    const base = ids[0]!;

    const signals = await engine.readQueueHealthSignals({ waitingThreshold: 1, oldWaitingHours: 1, windowHours: 24, stalledAfterHours: 1 });
    expect(signals.stalled.map(r => ({ id: r.id - base, name: r.name, total: r.total }))).toEqual([
      { id: 0, name: 'stall-a', total: 2 }, { id: 1, name: 'stall-b', total: 2 },
    ]);
    expect(signals.depth).toEqual([
      { name: 'sync', queue: 'default', depth: 3 }, { name: 'Zed', queue: 'default', depth: 2 }, { name: 'alpha', queue: 'default', depth: 2 },
    ]);
    expect(signals.rss_kills).toBe(2);
    expect(signals.prompt_too_long).toEqual([{ phase: 'other', cnt: 1 }, { phase: 'patterns', cnt: 3 }, { phase: 'synthesize', cnt: 1 }]);
    expect(signals.old_embed_backfill.map(r => ({ name: r.name, queue: r.queue, depth: r.depth, hours: Math.round(r.oldest_age_seconds / 3600) })))
      .toEqual([{ name: 'embed-backfill', queue: 'q-embed', depth: 1, hours: 3 }]);

    const waiting = await engine.listWaitingByQueue();
    expect(waiting.map(r => [r.queue, r.depth])).toEqual([['default', 7], ['q-embed', 1], ['dream-inline-one', 1]].sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]))));

    const divergence = await engine.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: TTL });
    expect(divergence.divergence.find(d => d.name === 'alpha')).toEqual({ name: 'alpha', intake: 6, completed: 1, waiting: 2 });
    expect(divergence.ttl_cancelled).toEqual([{ name: 'alpha', count: 1 }]);

    const wedgeCounts = await engine.listQueueWedgeCounts();
    expect(wedgeCounts.map(r => [r.queue, r.active_healthy, r.waiting])).toEqual([['default', 4, 7], ['q-embed', 0, 1]]);
    expect(wedgeCounts.find(r => r.queue === 'default')!.mins_since_completion).not.toBeNull();

    const priv = await engine.listPrivateQueueHealth();
    expect(priv.map(r => ({ queue: r.queue, source_id: r.source_id, active_healthy: r.active_healthy, waiting: r.waiting, paused: r.paused, aged: (r.oldest_waiting_minutes ?? 0) > 100 })))
      .toEqual([{ queue: 'dream-inline-one', source_id: 'src-one', active_healthy: 0, waiting: 1, paused: 1, aged: true }]);

    const wedge = await engine.readWedgeSignals('default', ['sync', 'alpha']);
    expect({ stalled: wedge.stalled, activeHealthy: wedge.activeHealthy, waiting: wedge.waiting, waitingClaimable: wedge.waitingClaimable })
      .toEqual({ stalled: 1, activeHealthy: 4, waiting: 7, waitingClaimable: 5 });
    expect(wedge.lastCompleted).toBeInstanceOf(Date);
    expect(recent(await engine.readOldestWaitingAge('q-embed'))).toBe(false);
    expect(await engine.readOldestWaitingAge('nowhere')).toBeNull();

    const stuck = await engine.listStuckActiveJobsByName();
    expect(stuck).toEqual([{ name: 'lapsed', n: 1 }, { name: 'twice', n: 1 }]);
    return { signals: { ...signals, stalled: signals.stalled.map(r => r.name) }, stuck };
  });
});
