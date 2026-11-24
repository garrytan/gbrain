/**
 * The proactive brief ranks open loops (proactive-brief.ts compareBriefLoops): overdue, soonest due, newest activity,
 * highest confidence, then a final tie-break. The final tie-break must agree with the activity order, newest first, as
 * listOpenLoops orders its rows (`last_activity_at DESC, id DESC`): otherwise two loops recorded in the same
 * millisecond rank oldest first while two recorded a millisecond apart rank newest first, and the brief's order turns on
 * clock resolution (engine-parity brief-reads failed that way on the Rust arm in CI).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the brief lists tied loops in one deterministic order on every engine, newest loop first.
 * 2. Fails when: the last tie-break runs in the opposite direction from the activity order (id ascending).
 * 3. Existing coverage: test/engine-parity/brief-reads.test.ts compares arms but cannot force a timestamp tie.
 * 4. Seams: none; a pure comparator.
 */
import { describe, expect, test } from 'bun:test';
import { compareBriefLoops } from '../src/core/context/proactive-brief.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const loop = (id: number, at: string) => ({ id, due_at: null, last_activity_at: at, confidence: 0.9 });

describe('brief loop rank', () => {
  test('a later loop ranks first whether or not its activity time ties an earlier loop', () => {
    const rank = (rows: ReturnType<typeof loop>[]) => [...rows].sort((a, b) => compareBriefLoops(a, b, NOW)).map(l => l.id);
    // A millisecond apart: newest activity first.
    expect(rank([loop(1, '2026-11-22T10:00:00.000Z'), loop(2, '2026-11-22T10:00:00.001Z')])).toEqual([2, 1]);
    // The same instant: the same order, in either input order.
    expect(rank([loop(1, '2026-11-22T10:00:00.000Z'), loop(2, '2026-11-22T10:00:00.000Z')])).toEqual([2, 1]);
    expect(rank([loop(2, '2026-11-22T10:00:00.000Z'), loop(1, '2026-11-22T10:00:00.000Z')])).toEqual([2, 1]);
  });
});
