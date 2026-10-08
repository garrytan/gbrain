/**
 * #6278 R2: the repair busy set. Busy: queued, running and recovering
 * requests, terminal rows with an open recovery, both endpoints of a rename,
 * and the not-yet-admitted entries of every unfinished managed sync cursor
 * of the current incarnation (read from the frozen manifest, from the
 * cursor's index on); a held path in the manifest is not busy. The read
 * fails closed: a thrown query or a cursor whose manifest is missing makes
 * every candidate busy, never an empty set.
 * Fails when: a rename endpoint, a recovery row or a manifest-ahead path
 * stops counting, a held path starts counting, or a failed read comes back
 * as "nothing busy".
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadRepairBusySet, repairBusy, repairBusyError, repairBusyMessage } from '../src/core/persistence/repair-busy.ts';

type Rows = Record<string, unknown>[];
/** An engine whose executeRaw answers by the table the SQL names; `fail` throws for SQL containing it. */
function stub(answers: { pending?: Rows; cursors?: Rows; holds?: Rows; manifests?: Record<string, unknown> }, fail?: string): BrainEngine {
  return { async executeRaw(sql: string, params: unknown[] = []) {
    if (fail && sql.includes(fail)) throw new Error(`boom: ${fail}`);
    if (sql.includes('FROM persistence_requests')) return answers.pending ?? [];
    if (sql.includes("op='managed-sync' ")) return params[1] === INC ? answers.cursors ?? [] : [];
    if (sql.includes("op='managed-sync-manifest'")) { const entries = answers.manifests?.[String(params[0])]; return entries === undefined ? [] : [{ entries }]; }
    if (sql.includes('FROM op_checkpoints') && params[0] === 'sync-hold') return answers.holds ?? [];
    throw new Error(`unexpected SQL: ${sql}`);
  } } as unknown as BrainEngine;
}
const INC = 'inc-1';

describe('loadRepairBusySet', () => {
  test('in-flight requests: slug, path, origin and both rename endpoints; terminal rows with an open recovery count', async () => {
    const busy = await loadRepairBusySet(stub({ pending: [
      { slug: 'people/a', path: 'people/a.md', source_path: 'people/a.md', rename_slug: 'people/old-a', rename_source_path: 'people/old-a.md' },
      { slug: 'people/b', path: null, source_path: null, rename_slug: null, rename_source_path: null }] }), 'src', INC);
    expect(busy.unknown).toBeNull();
    expect([...busy.paths].sort()).toEqual(['people/a.md', 'people/old-a.md']);
    expect([...busy.slugs].sort()).toEqual(['people/a', 'people/b', 'people/old-a']);
    expect(repairBusy(busy, { path: 'people/old-a.md' })).toBe(true);
    expect(repairBusy(busy, { slug: 'people/b' })).toBe(true);
    expect(repairBusy(busy, { path: 'people/c.md', slug: 'people/c' })).toBe(false);
  });

  test('an unfinished cursor adds the manifest entries from its index on, held paths excluded; a finished or other-incarnation cursor adds nothing', async () => {
    const manifest = [
      { path: 'people/done.md', sourcePath: 'people/done.md', action: 'import', slug: 'people/done' },
      { path: 'people/next.md', sourcePath: 'people/next.md', action: 'import', slug: 'people/next' },
      { path: 'people/held.md', sourcePath: 'people/held.md', action: 'import', slug: 'people/held' },
      { path: 'people/moved.md', sourcePath: 'people/moved.md', action: 'import', slug: 'people/moved', renameFrom: { sourcePath: 'people/was.md', slug: 'people/was' } },
    ];
    const busy = await loadRepairBusySet(stub({ cursors: [{ run_id: 'run-1', index: '1' }], manifests: { 'run-1': manifest }, holds: [{ path: 'people/held.md' }] }), 'src', INC);
    expect(busy.unknown).toBeNull();
    expect([...busy.paths].sort()).toEqual(['people/moved.md', 'people/next.md', 'people/was.md']);
    expect([...busy.slugs].sort()).toEqual(['people/moved', 'people/next', 'people/was']);
    expect(repairBusy(busy, { path: 'people/done.md', slug: 'people/done' })).toBe(false);
    expect(repairBusy(busy, { path: 'people/held.md', slug: 'people/held' })).toBe(false);
    expect(repairBusy(busy, { sourcePath: 'people/was.md' })).toBe(true);
    const none = await loadRepairBusySet(stub({ cursors: [], manifests: { 'run-1': manifest } }), 'src', INC);
    expect([none.unknown, none.paths.size, none.slugs.size]).toEqual([null, 0, 0]);
    const other = await loadRepairBusySet(stub({ cursors: [{ run_id: 'run-1', index: '1' }], manifests: { 'run-1': manifest } }), 'src', 'inc-2');
    expect([other.unknown, other.paths.size, other.slugs.size]).toEqual([null, 0, 0]);
  });

  test('fails closed: a thrown query or an unfinished cursor without a readable manifest makes every candidate busy', async () => {
    for (const fail of ['FROM persistence_requests', "op='managed-sync' ", 'sync-hold']) {
      const engine = stub({ cursors: [{ run_id: 'run-1', index: 0 }], manifests: { 'run-1': [] } }, fail === 'sync-hold' ? 'FROM op_checkpoints\n      WHERE op=$1' : fail);
      const busy = await loadRepairBusySet(engine, 'src', INC);
      expect(busy.unknown).toContain('could not be read');
      expect(repairBusy(busy, { path: 'anything.md' })).toBe(true);
      expect(repairBusy(busy, {})).toBe(true);
    }
    const missing = await loadRepairBusySet(stub({ cursors: [{ run_id: 'run-gone', index: 0 }], manifests: {} }), 'src', INC);
    expect(missing.unknown).toContain('run-gone');
    expect(repairBusy(missing, { path: 'anything.md' })).toBe(true);
    const malformed = await loadRepairBusySet(stub({ cursors: [{ run_id: 'run-odd', index: 0 }], manifests: { 'run-odd': { not: 'an array' } } }), 'src', INC);
    expect(repairBusy(malformed, { path: 'anything.md' })).toBe(true);
    expect(repairBusyMessage(missing, 'src', 'people/x.md')).toContain('every candidate of the source is treated as in flight');
    expect(repairBusyError(missing, 'src', 'people/x.md')).toMatchObject({ code: 'sync_in_progress', reason: 'busy_set_unreadable' });
    const named = await loadRepairBusySet(stub({ pending: [{ slug: 'people/x', path: 'people/x.md', source_path: null, rename_slug: null, rename_source_path: null }] }), 'src', INC);
    expect(repairBusyError(named, 'src', 'people/x.md')).toMatchObject({ code: 'sync_in_progress', reason: 'candidate_in_flight', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'src', '--json'] } });
  });
});
