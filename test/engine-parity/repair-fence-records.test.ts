/**
 * BrainEngine parity — the bookkeeping members of the fence and slug-conflict repairs (engine-sql/fence-repair-records.ts):
 * the fence repair attempt store's compare-and-swap (`insertOpCheckpointIfAbsent`, `replaceOpCheckpointAtVersion`;
 * fence-repair/attempts.ts), the per-source checkpoint listing of uncommitted repairs (`listSourceCheckpointRecords`;
 * fence-repair/uncommitted.ts), the oldest hold each kind's verification reports (`readOldestSyncHoldAt`) and the fence
 * trend writers (`upsertFenceTrendRunRecord`, and `insertOpCheckpointIfAbsent` for a page write's row).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an insert stores a parent only when none exists; a replace swaps the records only while the first record's
 *    `v` is the expected version, and a missing parent or a missing `v` matches nothing; the listing answers the first
 *    record of each parent of the op that names an asked source (every one when no source is asked), in fingerprint byte
 *    order; the oldest hold is the earliest `held_at` of the asked sources' sync holds with the asked code, null when none.
 *    A sync run's trend row is stored, then rewritten with the new total and the day of its first write, so a resumed run counts
 *    once; a page write's trend row is stored once per request and a replay adds nothing.
 *    The attempt store claims a candidate once, the same way, through these members. On every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: the statements were raw SQL in the helpers, so the Rust engine refused a fence repair's attempt claim,
 *    its uncommitted-repair listing and both kinds' verification at `executeRaw`.
 *  - Why existing coverage misses it: test/fence-repair-*.test.ts runs on PGLite only.
 *  - Seam: none. Typed members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { attemptStore, FENCE_REPAIR_ATTEMPT_OP } from '../../src/core/fence-repair/attempts.ts';
import { readTrend, recordPublicationFenceTrend, recordSyncRunTrend } from '../../src/core/fence-repair/census-store.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: the fence repair bookkeeping members', () => {
  parityTest('the attempt store inserts once and replaces only at the expected version', {
    methods: ['insertOpCheckpointIfAbsent', 'replaceOpCheckpointAtVersion', 'readOpCheckpointRecord'],
  }, async (engine) => {
    const op = 'fence-repair-attempt-parity';
    const first = await engine.insertOpCheckpointIfAbsent(op, 'fp-a', [{ v: 1, state: 'claimed' }]);
    const again = await engine.insertOpCheckpointIfAbsent(op, 'fp-a', [{ v: 9, state: 'other' }]);
    const stale = await engine.replaceOpCheckpointAtVersion(op, 'fp-a', [{ v: 2, state: 'dispatched' }], 7);
    const swapped = await engine.replaceOpCheckpointAtVersion(op, 'fp-a', [{ v: 2, state: 'dispatched' }], 1);
    const missing = await engine.replaceOpCheckpointAtVersion(op, 'fp-none', [{ v: 1 }], 0);
    await engine.writeOpCheckpointRecord(op, 'fp-nov', [{ state: 'legacy' }]);
    const noVersion = await engine.replaceOpCheckpointAtVersion(op, 'fp-nov', [{ v: 1 }], 0);
    const stored = (await engine.readOpCheckpointRecord(op, 'fp-a'))?.completed_keys;
    const answers = { first, again, stale, swapped, missing, noVersion, stored };
    expect(answers).toEqual({ first: true, again: false, stale: false, swapped: true, missing: false, noVersion: false, stored: [{ v: 2, state: 'dispatched' }] });
    return answers;
  });

  parityTest('the attempt store claims a candidate once through the members', {
    methods: ['insertOpCheckpointIfAbsent', 'readOpCheckpointRecord', 'listSourceCheckpointRecords'], timeout: 60_000,
  }, async (engine) => {
    const clock = Date.parse('2026-11-21T10:00:00.000Z');
    const store = attemptStore(engine, { now: () => new Date(clock) });
    const candidate = { sourceId: 'default', incarnation: '1', key: 'notes/a.md' };
    const claimed = await store.claim(candidate as never, 'memo-1');
    const second = await store.claim(candidate as never, 'memo-1');
    const keys = (await engine.listSourceCheckpointRecords(FENCE_REPAIR_ATTEMPT_OP, null)).length;
    const answers = { claimed: claimed.ok, second: second.ok ? 'ok' : second.reason, keys };
    expect(answers).toEqual({ claimed: true, second: 'claimed_elsewhere', keys: 1 });
    return answers;
  });

  parityTest('the source checkpoint listing and the oldest sync hold answer the asked sources in order', {
    methods: ['listSourceCheckpointRecords', 'readOldestSyncHoldAt', 'writeOpCheckpointRecord'],
  }, async (engine) => {
    const op = 'fence-uncommitted-parity';
    await engine.writeOpCheckpointRecord(op, 'default:1:b.md', [{ source_id: 'default', path: 'b.md' }]);
    await engine.writeOpCheckpointRecord(op, 'default:1:B.md', [{ source_id: 'default', path: 'B.md' }]);
    await engine.writeOpCheckpointRecord(op, 'side:1:a.md', [{ source_id: 'side', path: 'a.md' }]);
    await engine.writeOpCheckpointRecord(op, 'none', [{ path: 'no-source.md' }]);
    const hold = (fp: string, source: string, code: string, at: string | null) =>
      engine.writeOpCheckpointRecord('sync-hold', fp, [{ source_id: source, code, held_at: at, path: fp }]);
    await hold('h1', 'default', 'invalid_fence', '2026-11-20T10:00:00.000Z');
    await hold('h2', 'default', 'invalid_fence', '2026-11-19T10:00:00.000Z');
    await hold('h3', 'side', 'invalid_fence', '2026-11-01T10:00:00.000Z');
    await hold('h4', 'default', 'frontmatter_slug_conflict', '2026-10-01T10:00:00.000Z');
    await hold('h5', 'default', 'invalid_fence', null);
    const answers = {
      all: await engine.listSourceCheckpointRecords(op, null),
      defaultOnly: await engine.listSourceCheckpointRecords(op, ['default']),
      none: await engine.listSourceCheckpointRecords(op, ['nope']),
      fence: await engine.readOldestSyncHoldAt('invalid_fence', ['default']),
      both: await engine.readOldestSyncHoldAt('invalid_fence', ['default', 'side']),
      slug: await engine.readOldestSyncHoldAt('frontmatter_slug_conflict', ['default']),
      empty: await engine.readOldestSyncHoldAt('invalid_fence', ['nope']),
    };
    expect(answers).toEqual({
      all: [
        { fingerprint: 'default:1:B.md', record: { source_id: 'default', path: 'B.md' } },
        { fingerprint: 'default:1:b.md', record: { source_id: 'default', path: 'b.md' } },
        { fingerprint: 'none', record: { path: 'no-source.md' } },
        { fingerprint: 'side:1:a.md', record: { source_id: 'side', path: 'a.md' } },
      ],
      defaultOnly: [
        { fingerprint: 'default:1:B.md', record: { source_id: 'default', path: 'B.md' } },
        { fingerprint: 'default:1:b.md', record: { source_id: 'default', path: 'b.md' } },
      ],
      none: [],
      fence: '2026-11-19T10:00:00.000Z', both: '2026-11-01T10:00:00.000Z', slug: '2026-10-01T10:00:00.000Z', empty: null,
    });
    return answers;
  });

  parityTest('the fence trend counts a resumed sync run once, keeping its first day, and a replayed page write once', {
    methods: ['upsertFenceTrendRunRecord', 'insertOpCheckpointIfAbsent', 'readFenceTrendRecords'],
  }, async (engine) => {
    await recordSyncRunTrend(engine, { sourceId: 'default', runId: 'run-1', day: '2026-10-05', count: 3, byClass: { close_fence: 3 }, writers: { 'notes/': 3 } });
    await recordSyncRunTrend(engine, { sourceId: 'default', runId: 'run-1', day: '2026-10-06', count: 5, byClass: { close_fence: 4, renumber: 1 }, writers: { 'notes/': 5 } });
    await recordSyncRunTrend(engine, { sourceId: 'default', runId: 'run-2', day: '2026-10-06', count: 0, byClass: {}, writers: {} });
    // The member itself: a new parent is stored as given, and a rewrite keeps the first record's day.
    await engine.upsertFenceTrendRunRecord('fence-trend', 'default:run:run-3', { version: 1, source_id: 'default', day: '2026-10-07', count: 2, by_class: { renumber: 2 }, writers: { 'notes/': 2 } });
    await engine.upsertFenceTrendRunRecord('fence-trend', 'default:run:run-3', { version: 1, source_id: 'default', day: '2026-10-09', count: 4, by_class: { renumber: 4 }, writers: { 'notes/': 4 } });
    const row = { id: 'req-1', source_id: 'default', principal_kind: 'local_cli' };
    const at = new Date('2026-10-06T10:00:00Z');
    await recordPublicationFenceTrend(engine, row, { fences_normalized: { count: 1, by_class: { renumber: 1 } } }, at);
    await recordPublicationFenceTrend(engine, row, { fences_normalized: { count: 1, by_class: { renumber: 1 } } }, at);
    await recordPublicationFenceTrend(engine, { ...row, id: 'req-2' }, { status: 'imported' }, at);
    const answers = {
      trend: (await readTrend(engine, ['default'], '2026-09-30')).get('default'),
      from: (await readTrend(engine, ['default'], '2026-10-06')).get('default')!.map(day => day.day),
      other: [...(await readTrend(engine, ['nope'], '2026-09-30')).keys()],
    };
    expect(answers).toEqual({
      trend: [
        { day: '2026-10-05', count: 5, by_class: { close_fence: 4, renumber: 1 }, writers: { 'notes/': 5 } },
        { day: '2026-10-06', count: 1, by_class: { renumber: 1 }, writers: { local_cli: 1 } },
        { day: '2026-10-07', count: 4, by_class: { renumber: 4 }, writers: { 'notes/': 4 } },
      ],
      from: ['2026-10-06', '2026-10-07'], other: [],
    });
    return answers;
  });
});
