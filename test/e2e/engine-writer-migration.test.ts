/**
 * Migration v332 (engine_writer_observations) on a populated Postgres brain.
 *
 * Protects: the migration is idempotent and cheap on a large brain. Run again on a brain that has it, it changes
 * nothing; run for the first time, it takes relation locks only on the objects it creates (never on pages, config or
 * any other existing table), copies and rewrites no rows, and adds no trigger. Regression it catches: a backfill, an
 * ALTER or an index build on an existing table, a CREATE that stops being IF NOT EXISTS / OR REPLACE, or a trigger
 * created before `shadow start`. Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { v332 } from '../../src/core/schema-migrations/v332-engine-writer-observations.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';

const d = hasDatabase() ? describe : describe.skip;
const NEW_RELATIONS = [
  'engine_writer_observations', 'engine_writer_sessions', 'engine_writer_coverage_gaps',
  'engine_writer_observations_pkey', 'idx_engine_writer_sessions_key',
  'idx_engine_writer_observations_last_seen', 'idx_engine_writer_sessions_last_seen', 'idx_engine_writer_coverage_gaps_time',
];

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
const sockets: Array<ReturnType<typeof postgres>> = [];

function connection(): ReturnType<typeof postgres> {
  const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
  const sql = postgres(url, { max: 1, onnotice: () => undefined, prepare: false });
  sockets.push(sql);
  return sql;
}

/** What the migration owns, as the catalog shows it: names, columns, function text and settings, row counts of every brain table. */
async function snapshot(): Promise<string> {
  const rows = await engine.executeRaw<{ s: string }>(`
    SELECT concat_ws(E'\\n',
      (SELECT string_agg(c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity::text || ':' || c.relnatts::text, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND (c.relname LIKE 'engine_writer%' OR c.relname LIKE 'idx_engine_writer%')),
      (SELECT string_agg(a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attrelid::regclass::text, a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid::regclass::text LIKE 'engine_writer%' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(p.oid::text || ':' || md5(pg_get_functiondef(p.oid)), ',') FROM pg_proc p WHERE p.proname = 'gbrain_note_writer'),
      (SELECT count(*)::text FROM pg_trigger WHERE tgname = 'gbrain_writer_note'),
      (SELECT count(*)::text FROM pages), (SELECT count(*)::text FROM config)) AS s`);
  return rows[0]!.s;
}

d('migration v332 on a populated Postgres brain', () => {
  beforeAll(async () => { assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => {
    ({ engine, close } = await template.clone());
    // Populate: the brain the migration runs on is not empty.
    await engine.executeRaw(`INSERT INTO config (key, value) SELECT 'bulk-' || g, 'x' FROM generate_series(1, 2000) g ON CONFLICT (key) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth) SELECT 'bulk/p' || g, 'note', 'p' || g, 'body ' || g FROM generate_series(1, 500) g ON CONFLICT DO NOTHING`);
  }, 120_000);
  afterEach(async () => {
    for (const s of sockets.splice(0)) await s.end({ timeout: 5 }).catch(() => undefined);
    await close();
  });

  /** Runs the migration SQL in one transaction and returns the relation locks that transaction held at the end. */
  async function runInTransaction(sql: ReturnType<typeof postgres>, extra = ''): Promise<string[]> {
    let locks: string[] = [];
    await sql.begin(async (t) => {
      await t.unsafe(v332.sql + extra);
      locks = (await t`SELECT DISTINCT c.relname::text AS name FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relnamespace = current_schema()::regnamespace`).map(r => String(r.name));
    });
    return locks;
  }

  test('run again on a brain that has it: nothing changes, and no existing table is locked', async () => {
    const before = await snapshot();
    const locks = await runInTransaction(connection());
    expect(locks.filter(n => !NEW_RELATIONS.includes(n))).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(await runInTransaction(connection())).toEqual(locks);
    expect(await snapshot()).toBe(before);
  }, 120_000);

  test('the lock probe can find a positive: the same SQL plus a statement that touches pages shows a lock on pages', async () => {
    const locks = await runInTransaction(connection(), '\nCREATE INDEX IF NOT EXISTS idx_probe_pages_slug ON pages (slug);\n');
    expect(locks).toContain('pages');
  }, 120_000);

  test('first run, on a brain that lacks the objects: relation locks only on the new objects, no backfill, no trigger', async () => {
    for (const t of ['engine_writer_observations', 'engine_writer_sessions', 'engine_writer_coverage_gaps']) await engine.executeRaw(`DROP TABLE ${t}`);
    await engine.executeRaw('DROP FUNCTION gbrain_note_writer()');
    const [pagesBefore] = await engine.executeRaw<{ xmin: string; n: number }>(`SELECT max(xmin::text)::text AS xmin, count(*)::int AS n FROM pages`);
    const locks = await runInTransaction(connection());
    expect(locks.filter(n => !NEW_RELATIONS.includes(n))).toEqual([]);
    expect(locks.some(n => n === 'engine_writer_sessions')).toBe(true);
    const [pagesAfter] = await engine.executeRaw<{ xmin: string; n: number }>(`SELECT max(xmin::text)::text AS xmin, count(*)::int AS n FROM pages`);
    expect(pagesAfter).toEqual(pagesBefore!);
    for (const t of ['engine_writer_observations', 'engine_writer_sessions', 'engine_writer_coverage_gaps']) {
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n).toBe(0);
    }
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'gbrain_writer_note'`))[0]!.n).toBe(0);
    // And a second run after the first changes nothing.
    const after = await snapshot();
    await runInTransaction(connection());
    expect(await snapshot()).toBe(after);
  }, 120_000);
});
