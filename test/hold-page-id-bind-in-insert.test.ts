/**
 * Quarantine holds follow their page: the bind rides in the page insert (engine-sql/hold-binding.ts).
 *
 * Authoring gate
 *  1. Protects: a hold waiting for its slug is bound to the page first created there by the same statement that inserts
 *     the page, so creating a page costs the statements it cost before holds followed their page (one for the insert
 *     itself, no extra bind statement), on both engines; a revived page does not rebind.
 *  2. Fails when: the bind runs as a statement of its own after the insert (every page insert then costs one more
 *     statement, which the managed import budgets and the #6712 pinned statement list count), or the folded bind stops
 *     binding.
 *  3. Why new: hold-page-id-lifecycle.test.ts pins what a hold is bound to, never how many statements the bind costs.
 *  4. Seams: the PGLite statement counter and the Postgres wire trace (test/helpers/statement-counter.ts); the rows are
 *     read directly only to state what a hold is bound to. The statements are compared by text as well as by number; on
 *     PGLite the WAL checkpoint guard's own probe statements are left out by exact text (CHECKPOINT_GUARD_SQL).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CHECKPOINT_PROBE_REUSE_MS } from '../src/core/pglite-engine/checkpoint-guard.ts';
import { countPgliteStatements, readSqlTrace, type StatementRecord } from './helpers/statement-counter.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { bareBody, HELD, holdFenceRow, ROWS } from './helpers/hold-page-id-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

/** The statements one `putPage` of a new page sends, transaction control included: master's count for the same call. */
const PUT_PAGE_STATEMENTS = 8;
/**
 * Those statements, each by its first three words (the Postgres wire trace cuts long texts, so no more is compared;
 * transaction control by its first word). Asserting
 * the list, not only its length, makes a failure name the statement that differs, including one some other work sent into
 * the counting window.
 */
const PUT_PAGE_SHAPE = ['BEGIN', 'SELECT INCARNATION FROM', 'INSERT INTO PAGE_WRITE_GUARDS(SOURCE_INCARNATION,SLUG)', 'SELECT G.SLUG FROM',
  'SELECT ID FROM', 'SELECT ID, SLUG,', 'WITH INS AS', 'COMMIT'];
const shape = (records: readonly StatementRecord[]) => records.map(r => {
  const words = r.sql.trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase();
  return /^(BEGIN|COMMIT)\b/.exec(words)?.[1] ?? words; // Postgres opens with BEGIN READ WRITE, PGLite with BEGIN
});
/**
 * The statements PGLite's WAL checkpoint guard sends on its own (src/core/pglite-engine/checkpoint-guard.ts): before an
 * outermost write transaction it probes WAL unless its last probe is under CHECKPOINT_PROBE_REUSE_MS (50 ms) old, so a put
 * that starts more than 50 ms after the previous write probes inside the counting window. They are the engine's, not the
 * put's, and are matched by their exact text. Only the PGLite arm sends them.
 */
const CHECKPOINT_GUARD_SQL = new Set([
  `SELECT pg_size_bytes(current_setting('max_wal_size'))::float8 AS max_wal,
          pg_size_bytes(current_setting('wal_segment_size'))::float8 AS segment,
          current_setting('checkpoint_completion_target')::float8 AS target`,
  'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 AS since_redo FROM pg_control_checkpoint()',
  'CHECKPOINT',
]);

const home = mkdtempSync(join(tmpdir(), 'gbrain-hold-bind-'));
const backends = testBackends();
const brains: Array<{ backend: string; engine: BrainEngine; measure: <T>(work: () => Promise<T>) => Promise<StatementRecord[]>; close: () => Promise<void> }> = [];
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    brains.push({
      backend: 'pglite', engine, close: () => engine.disconnect(),
      measure: async work => {
        // Let the guard's last probe age past its reuse window, so the put always probes inside the window and every run
        // takes the path a loaded CI runner took at random.
        await Bun.sleep(CHECKPOINT_PROBE_REUSE_MS + 20);
        const counter = countPgliteStatements(engine);
        try { await work(); } finally { counter.stop(); }
        return counter.records.filter(r => !CHECKPOINT_GUARD_SQL.has(r.sql));
      },
    });
  }
  if (backends.includes('postgres')) {
    const trace = join(home, 'trace.jsonl');
    const pg = await withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'hold-bind' }, () => isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2));
    brains.push({
      backend: 'postgres', engine: pg.engine, close: pg.close,
      measure: async work => {
        const started = performance.timeOrigin + performance.now();
        await work();
        const ended = performance.timeOrigin + performance.now();
        // The trace flushes every second; wait until the write's records have landed (the commit is the last statement of the call).
        for (let i = 0; ; i++) {
          const records = readSqlTrace(trace).filter(r => r.t >= started && r.t <= ended && (r.kind === 'execute' || r.kind === 'simple'));
          if (records.some(r => /^commit/i.test(r.sql)) || i >= 80) return records;
          await Bun.sleep(100);
        }
      },
    });
  }
  for (const b of brains) await warm(b.engine);
}, 180_000);
/** The engine's first write runs its one-time probes (server version, column types): warm it so a measured write is steady-state. */
const warm = async (engine: BrainEngine) => {
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('warm','warm','{}')");
  await engine.putPage('warm/up', { type: 'note', title: 'warm', compiled_truth: bareBody(ROWS), timeline: '' }, { sourceId: 'warm' });
};
afterAll(async () => { for (const b of brains) await b.close(); rmSync(home, { recursive: true, force: true }); });

for (const backend of backends) {
  describe(`hold bind in the page insert (${backend})`, () => {
    const brain = () => brains.find(b => b.backend === backend)!;
    const source = async () => {
      const id = `s${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await brain().engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      return id;
    };
    const put = (sourceId: string, slug: string) => brain().engine.putPage(slug, { type: 'note', title: slug, compiled_truth: bareBody(ROWS), timeline: '' }, { sourceId });
    const holdBinding = async (sourceId: string) => (await brain().engine.executeRaw<{ page_id: string | null }>('SELECT page_id::text AS page_id FROM write_gate_holds WHERE source_id=$1', [sourceId])).map(h => h.page_id === null ? null : Number(h.page_id));
    const pageId = async (sourceId: string, slug: string) => Number((await brain().engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
    const BIND = /UPDATE\s+write_gate_holds/;

    test('a waiting hold is bound by the statement that inserts its page, and the insert costs no extra statement', async () => {
      const sourceId = await source();
      await holdFenceRow(brain().engine, { sourceId, slug: 'people/waiting', claim: HELD, rowNum: 1 });
      expect(await holdBinding(sourceId)).toEqual([null]);
      const records = await brain().measure(() => put(sourceId, 'people/waiting'));
      expect(await holdBinding(sourceId)).toEqual([await pageId(sourceId, 'people/waiting')]);
      const texts = records.map(r => r.sql);
      expect(texts.filter(t => BIND.test(t) && !/INSERT INTO pages/.test(t))).toEqual([]); // the wire trace cuts long texts, so the insert's own text is not asserted
      expect(shape(records)).toEqual(PUT_PAGE_SHAPE);
      expect(records).toHaveLength(PUT_PAGE_STATEMENTS);
    });

    test('a page with no waiting hold costs the same number of statements', async () => {
      const sourceId = await source();
      const records = await brain().measure(() => put(sourceId, 'people/free'));
      expect(await holdBinding(sourceId)).toEqual([]);
      expect(shape(records)).toEqual(PUT_PAGE_SHAPE);
      expect(records).toHaveLength(PUT_PAGE_STATEMENTS);
    });

    test('a revived page does not take a hold that waited for its slug', async () => {
      const sourceId = await source();
      await put(sourceId, 'people/revived');
      const id = await pageId(sourceId, 'people/revived');
      await brain().engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id=$1', [id]);
      await holdFenceRow(brain().engine, { sourceId, slug: 'people/revived', claim: HELD, rowNum: 1 });
      // The writer binds a hold to the page at its slug, even a deleted one: put it back to waiting.
      await brain().engine.executeRaw('UPDATE write_gate_holds SET page_id = NULL WHERE source_id=$1', [sourceId]);
      await put(sourceId, 'people/revived');
      expect(await pageId(sourceId, 'people/revived')).toBe(id);
      expect(await holdBinding(sourceId)).toEqual([null]);
    });
  });
}
