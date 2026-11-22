/**
 * BrainEngine parity — the bookkeeping members of the fence and slug-conflict repairs (engine-sql/fence-repair-records.ts):
 * the fence repair attempt store's compare-and-swap (`insertOpCheckpointIfAbsent`, `replaceOpCheckpointAtVersion`;
 * fence-repair/attempts.ts), the per-source checkpoint listing of uncommitted repairs (`listSourceCheckpointRecords`;
 * fence-repair/uncommitted.ts) and the oldest hold each kind's verification reports (`readOldestSyncHoldAt`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an insert stores a parent only when none exists; a replace swaps the records only while the first record's
 *    `v` is the expected version, and a missing parent or a missing `v` matches nothing; the listing answers the first
 *    record of each parent of the op that names an asked source (every one when no source is asked), in fingerprint byte
 *    order; the oldest hold is the earliest `held_at` of the asked sources' sync holds with the asked code, null when none.
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
});
