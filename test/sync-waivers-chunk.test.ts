/**
 * #6423 (P2.2, mitigation, not the hang reproduction): `waiveNoopRun` used to pipeline every entry's checks in one round
 * trip (two calls per entry, 128 for a 64-entry run of deletes). It now sends them in chunks of at most
 * WAIVER_PIPELINE_MAX calls, and sends a chunk only while every entry before it validated, so the contiguous-prefix result
 * is unchanged. The engine here is a recording fake that reports `kind: 'postgres'` (so `pipelined` really issues a chunk
 * at once) and counts the statements outstanding at the same time. The #6423 forced probe is the `no_admission` governor
 * test in test/sync-drain-no-admission.test.ts. Synthetic data only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { UNFINISHED_PAGE_REQUEST_SQL, WAIVER_PIPELINE_MAX, waiveNoopRun, type WaiverCursor, type WaiverRunEntry } from '../src/core/persistence/sync-waivers.ts';

const root = mkdtempSync(join(tmpdir(), 'waiver-chunk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cursor = { sourceId: 's1', incarnation: '1', root, gitRoot: root, slugMode: 'git-root', binding: { worktree_id: '00000000-0000-0000-0000-000000000001' },
  authority: {} as WaiverCursor['authority'], runId: 'run-1', index: 0 } as WaiverCursor;
const entries = (n: number): WaiverRunEntry[] => Array.from({ length: n }, (_, i) => ({
  pending: { requestId: `r${i}`, slug: `p${i}`, pageId: i + 1, intent: { kind: 'managed_sync_delete', path: `p${i}.md`, sourcePath: `p${i}.md`, expected_revision: '7', ownerEpoch: '3' } as never },
  waived: { kind: 'delete', kernel: [] } }));

function fakeEngine(opts: { busySlugs?: Set<string> } = {}) {
  let outstanding = 0, peak = 0, unfinishedReads = 0;
  const statement = <T>(value: T): Promise<T> => {
    outstanding++; peak = Math.max(peak, outstanding);
    return new Promise(resolve => setTimeout(() => { outstanding--; resolve(value); }, 1));
  };
  const tx = {
    kind: 'postgres',
    lockPageKeys: async () => undefined,
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('set_config')) return [];
      if (sql.includes('FROM op_checkpoints')) return [{ run_id: 'run-1', index: 0, request_id: null }];
      if (sql.includes('FROM persistence_source_bindings')) return [{ owner_epoch: '3' }];
      if (sql.startsWith('SELECT id,slug,deleted_at')) return (params[1] as string[]).map(slug => ({ id: Number(slug.slice(1)) + 1, slug, deleted: true, knowledge_revision: '7' }));
      if (sql === UNFINISHED_PAGE_REQUEST_SQL) { unfinishedReads++; return statement(opts.busySlugs?.has(String(params[3])) ? [{ id: 'busy' }] : []); }
      if (sql.startsWith('SELECT id,slug,source_path FROM pages')) { const path = (params[1] as string[])[0]!; const i = Number(/p(\d+)\.md/.exec(path)![1]); return statement([{ id: i + 1, slug: `p${i}`, source_path: path }]); }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
  const engine = { kind: 'postgres', transaction: async <T>(fn: (t: BrainEngine) => Promise<T>) => fn(tx as unknown as BrainEngine) } as unknown as BrainEngine;
  return { engine, peak: () => peak, unfinishedReads: () => unfinishedReads };
}

describe('waiveNoopRun pipeline chunks (#6423 mitigation)', () => {
  test('64 delete entries: no round trip carries more than WAIVER_PIPELINE_MAX statements, and all 64 are waived', async () => {
    const fake = fakeEngine();
    let advanced = 0;
    const done = await waiveNoopRun(fake.engine, cursor, entries(64), 'key', async (_tx, prefix) => { advanced = prefix.length; return { ...cursor, index: prefix.length }; }, async () => cursor);
    expect(WAIVER_PIPELINE_MAX).toBe(64);
    expect(fake.peak()).toBeGreaterThan(1);
    expect(fake.peak()).toBeLessThanOrEqual(WAIVER_PIPELINE_MAX);
    expect(done).toMatchObject({ waived: 64 });
    expect(done!.next).toBeUndefined();
    expect(advanced).toBe(64);
  });

  test('the prefix stops at the first entry that fails, and no chunk after it is sent', async () => {
    const fake = fakeEngine({ busySlugs: new Set(['p5']) });
    const done = await waiveNoopRun(fake.engine, cursor, entries(64), 'key', async (_tx, prefix) => ({ ...cursor, index: prefix.length }), async () => cursor);
    expect(done).toMatchObject({ waived: 5 });
    expect(done!.next?.slug).toBe('p5');
    expect(fake.unfinishedReads()).toBe(WAIVER_PIPELINE_MAX / 2);
  });

  test('a failure in a later chunk keeps every entry before it', async () => {
    const fake = fakeEngine({ busySlugs: new Set(['p40']) });
    const done = await waiveNoopRun(fake.engine, cursor, entries(64), 'key', async (_tx, prefix) => ({ ...cursor, index: prefix.length }), async () => cursor);
    expect(done).toMatchObject({ waived: 40 });
    expect(done!.next?.slug).toBe('p40');
  });
});
