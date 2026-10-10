/**
 * Shared body of the v223 (sync watermark index) and v224 (page_retrievals)
 * migration tests: PGLite in `test/serve-loop-migrations.test.ts`, Postgres in
 * `test/e2e/serve-loop-migrations-postgres.test.ts`.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';
import { MIGRATIONS } from '../../src/core/schema-migrations/registry.generated.ts';

const INDEXES_SQL = `SELECT indexname AS name FROM pg_indexes WHERE indexname IN
  ('persistence_requests_committed_watermark','persistence_requests_sync_watermark','persistence_requests_compactable','pages_last_retrieved_at_idx') ORDER BY indexname`;

/** A fresh install at head has the sync watermark and compactable indexes and page_retrievals, and neither superseded index. */
export async function assertFreshServeLoopSchema(engine: BrainEngine): Promise<void> {
  expect((await engine.executeRaw<{ name: string }>(INDEXES_SQL)).map(r => r.name)).toEqual(['persistence_requests_compactable', 'persistence_requests_sync_watermark']);
  const [table] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('page_retrievals') IS NOT NULL AS present");
  expect(table?.present).toBe(true);
  const triggers = await engine.executeRaw<{ name: string }>("SELECT tgname AS name FROM pg_trigger WHERE tgrelid='pages'::regclass AND tgname='pages_forget_retrievals'");
  expect(triggers).toHaveLength(1);
}

/**
 * An upgraded brain: v222's watermark index and the indexed pages column with
 * timestamps, no page_retrievals. The runner swaps the watermark index, copies
 * every timestamp into page_retrievals, drops the column's index and leaves the
 * column's values alone; a second run changes nothing.
 */
export async function assertUpgradedServeLoopSchema(engine: BrainEngine): Promise<void> {
  const v223 = MIGRATIONS.find(m => m.name === 'persistence_serve_loop_indexes')!;
  expect(MIGRATIONS.find(m => m.name === 'page_retrievals')!.version).toBe(v223.version + 1);
  await engine.executeRaw('DELETE FROM pages');
  const ids = (await engine.executeRaw<{ id: number }>(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, last_retrieved_at)
    SELECT 'people/upgrade-' || g, 'default', 'person', 'Upgrade ' || g, 'body', '', CASE WHEN g % 3 = 0 THEN NULL ELSE now() - g * interval '1 hour' END
      FROM generate_series(1, 9) g RETURNING id`)).map(r => Number(r.id));
  await engine.executeRaw('DROP TRIGGER IF EXISTS pages_forget_retrievals ON pages');
  await engine.executeRaw('DROP FUNCTION IF EXISTS gbrain_forget_page_retrievals()');
  await engine.executeRaw('DROP TABLE IF EXISTS page_retrievals');
  await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_watermark');
  await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_compactable');
  await engine.executeRaw(`CREATE INDEX persistence_requests_committed_watermark ON persistence_requests(worktree_id,completed_at DESC) WHERE state='committed'`);
  await engine.executeRaw('CREATE INDEX pages_last_retrieved_at_idx ON pages (last_retrieved_at)');
  expect((await engine.executeRaw<{ name: string }>(INDEXES_SQL)).map(r => r.name)).toEqual(['pages_last_retrieved_at_idx', 'persistence_requests_committed_watermark']);
  const column = async (): Promise<Array<[number, string | null]>> => (await engine.executeRaw<{ id: number; at: string | null }>(
    'SELECT id, last_retrieved_at::text AS at FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [ids])).map(r => [Number(r.id), r.at]);
  const before = await column();

  for (const run of [1, 2]) {
    await engine.setConfig('version', String(v223.version - 1));
    const result = await runMigrations(engine);
    expect(result.current).toBe(LATEST_VERSION);
    await assertFreshServeLoopSchema(engine);
    const copied = (await engine.executeRaw<{ page_id: number; at: string }>('SELECT page_id, last_retrieved_at::text AS at FROM page_retrievals ORDER BY page_id'))
      .map((r): [number, string | null] => [Number(r.page_id), r.at]);
    expect(copied).toEqual(before.filter(([, at]) => at !== null));
    expect(copied).toHaveLength(6);
    expect(await column()).toEqual(before);
    if (run === 1) await engine.executeRaw(`UPDATE page_retrievals SET last_retrieved_at = last_retrieved_at - interval '1 day'`);
  }
}
