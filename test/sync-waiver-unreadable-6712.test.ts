/**
 * GBRA-133 S-68 (#6712 PR 4b lane F): a waiver's working-tree read of a file the freeze would hold `file_unreadable` (a
 * symlink, a FIFO) threw out of the waiver transaction and stopped the run. The entry is now simply not waived, so it goes
 * on to admission like any other entry. Red at ed7e8e017 (the run threw "Sync cannot publish through a symlink." /
 * "Sync target is not a regular file."). The engine is the recording fake of test/sync-waivers-chunk.test.ts; synthetic
 * data only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { UNFINISHED_PAGE_REQUEST_SQL, waiveNoopRun, type WaiverCursor, type WaiverRunEntry } from '../src/core/persistence/sync-waivers.ts';

const root = mkdtempSync(join(tmpdir(), 'waiver-unreadable-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'target.md'), 'synthetic');
symlinkSync('target.md', join(root, 'p1.md'));
execFileSync('mkfifo', [join(root, 'p2.md')]);
const cursor = { sourceId: 's1', incarnation: '1', root, gitRoot: root, slugMode: 'git-root', binding: { worktree_id: '00000000-0000-0000-0000-000000000001' },
  authority: {} as WaiverCursor['authority'], runId: 'run-1', index: 0 } as WaiverCursor;
const deletes = (n: number): WaiverRunEntry[] => Array.from({ length: n }, (_, i) => ({
  pending: { requestId: `r${i}`, slug: `p${i}`, pageId: i + 1, intent: { kind: 'managed_sync_delete', path: `p${i}.md`, sourcePath: `p${i}.md`, expected_revision: '7', ownerEpoch: '3' } as never },
  waived: { kind: 'delete', kernel: [] } }));

const tx = {
  kind: 'pglite',
  lockPageKeys: async () => undefined,
  executeRaw: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('set_config')) return [];
    if (sql.includes('FROM op_checkpoints')) return [{ run_id: 'run-1', index: 0, request_id: null }];
    if (sql.includes('FROM persistence_source_bindings')) return [{ owner_epoch: '3' }];
    if (sql.startsWith('SELECT id,slug,deleted_at')) return (params[1] as string[]).map(slug => ({ id: Number(slug.slice(1)) + 1, slug, deleted: true, knowledge_revision: '7' }));
    if (sql === UNFINISHED_PAGE_REQUEST_SQL) return [];
    if (sql.startsWith('SELECT id,slug,source_path,deleted_at FROM pages')) { const path = (params[1] as string[])[0]!; const i = Number(/p(\d+)\.md/.exec(path)![1]); return [{ id: i + 1, slug: `p${i}`, source_path: path }]; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  },
};
const engine = { kind: 'pglite', transaction: async <T>(fn: (t: BrainEngine) => Promise<T>) => fn(tx as unknown as BrainEngine) } as unknown as BrainEngine;
const waive = (run: WaiverRunEntry[]) => waiveNoopRun(engine, cursor, run, 'key', async (_tx, prefix) => ({ ...cursor, index: prefix.length }), async () => cursor);

describe('GBRA-133 S-68: an unreadable working-tree file is not waived and never stops the run', () => {
  test('a delete whose path is now a symlink ends the waived prefix before it', async () => {
    expect(await waive(deletes(3))).toMatchObject({ waived: 1, next: { slug: 'p1' } });
  });

  test('a delete whose path is now a FIFO is not waived', async () => {
    expect(await waive(deletes(3).slice(2))).toBeNull();
  });
});
