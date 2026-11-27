/**
 * The three writer-status reads (stalled catch-ups, parked groups, source movement) read through typed engine members
 * on every engine, an engine without raw SQL (the Rust engine) included: no statement runs and nothing refuses.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readStalledCatchups, readParkedGroups and readSourceMovement call listStalledCatchupRows,
 *    listParkedGroupRows and listSourceBindingsForMovement with the source scope (null for every source), never
 *    executeRaw, and shape the rows they answer.
 *  - Regression: a read that goes back to raw SQL, or a named refusal left in front of it, stops `gbrain sources writer
 *    status` and the doctor's parked-effects check on a Rust brain.
 *  - Why existing coverage misses it: the engine parity cases (doctor-persistence, writer-status) compare the answers on
 *    real engines; they do not show that no raw statement ran on the way.
 *  - Seam: a fake engine with only the typed members and an executeRaw that fails the test.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readStalledCatchups } from '../src/core/persistence/effect-catchup.ts';
import { readParkedGroups } from '../src/core/persistence/parked-groups.ts';
import { readSourceMovement } from '../src/core/persistence/sync-movement.ts';

function fake() {
  const calls: Array<[string, unknown[]]> = [];
  const engine = {
    capabilities: new Set(['pages']),
    executeRaw: async (statement: string) => { throw new Error(`raw statement ran: ${statement.slice(0, 40)}`); },
    listStalledCatchupRows: async (...args: unknown[]) => {
      calls.push(['listStalledCatchupRows', args]);
      return [{ source_id: 'a-c', stalled: 0, busy: 1, since: '2999-01-01T00:00:00.000Z', retries: 0 },
        { source_id: 'work', stalled: 2, busy: 3, since: new Date('2026-01-01T00:00:00Z'), retries: 4 }];
    },
    listParkedGroupRows: async (...args: unknown[]) => {
      calls.push(['listParkedGroupRows', args]);
      return [{ source_id: 'work', code: 'held_by_rule', former: null, effects: 1, targets: 2, rule: 'r-0', worktree_ids: ['w'],
        current_worktree_id: 'w', requests: ['b0000000-0000-4000-8000-0000000000b2'] }];
    },
    listSourceBindingsForMovement: async (...args: unknown[]) => { calls.push(['listSourceBindingsForMovement', args]); return []; },
  } as unknown as BrainEngine;
  return { engine, calls };
}

describe('writer-status reads through typed members', () => {
  test('stalled catch-ups list the stalled sources only, with the busy streak, and run no raw statement', async () => {
    const { engine, calls } = fake();
    const rows = await readStalledCatchups(engine, ['work'], 60_000);
    expect(rows.map(({ fix, ...row }) => ({ ...row, fix: fix.argv }))).toEqual([{ source_id: 'work', stalled_effects: 2, busy_effects: 3,
      busy_since: '2026-01-01T00:00:00.000Z', busy_retries: 4, fix: ['gbrain', 'sources', 'writer', 'status', '--source', 'work', '--json'] }]);
    expect(calls).toEqual([['listStalledCatchupRows', [['work'], 60_000]]]);
  });

  test('parked groups name the bulk retry of each group, and run no raw statement', async () => {
    const { engine, calls } = fake();
    const groups = await readParkedGroups(engine);
    expect(groups.map(g => ({ source_id: g.source_id, code: g.code, targets: g.targets, rule: g.rule, command: g.command }))).toEqual([{
      source_id: 'work', code: 'held_by_rule', targets: 2, rule: 'r-0',
      command: ['gbrain', 'sources', 'writer', 'retry-effects', 'work', '--parked-code', 'held_by_rule', '--dry-run'] }]);
    expect(calls).toEqual([['listParkedGroupRows', [null]]]);
  });

  test('source movement with no binding is empty, and runs no raw statement', async () => {
    const { engine, calls } = fake();
    expect(await readSourceMovement(engine, { sourceIds: ['work'] })).toEqual([]);
    expect(calls).toEqual([['listSourceBindingsForMovement', [['work']]]]);
  });
});
