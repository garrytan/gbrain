/**
 * #7083: gbrain's ANALYZEs never cancel an autovacuum. ANALYZE takes SHARE UPDATE EXCLUSIVE, which a running
 * autovacuum holds, and Postgres cancels a (non-wraparound) autovacuum once another session has waited
 * deadlock_timeout (1 s) for it. The chunk refresh after every embed drain waited up to its 2 s lock timeout, so on a
 * 10M-chunk content_chunks every autovacuum of the table was cancelled before it finished.
 *
 * Runs in a dedicated database. It makes autovacuum vacuum content_chunks slowly (cost delay 100 ms per page, naptime
 * 1 s for the duration of the test, restored in afterAll), then, while that autovacuum holds the table, runs every
 * ANALYZE path gbrain owns on Postgres: each returns at once without waiting, and the same autovacuum is still
 * vacuuming content_chunks after deadlock_timeout has passed. Before the fix the first refresh cancelled it.
 * It also pins the drain rate limit (a small drain on a sampled table leaves the statistics alone) and doctor's
 * starved-autovacuum signal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { refreshChunkStatistics, refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { readVacuumStarvation, repairPlannerTable } from '../../src/core/planner-stats.ts';
import { analyzeDeferred } from '../../src/core/analyze-lock.ts';
import { analyzeAfterIndexBuild, analyzeYieldingToVacuum } from '../../src/core/schema-migrations/helpers.ts';
import { plannerStatsEntry } from '../../src/commands/doctor/checks/planner-stats.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const PAGES = 3_000;
const CHUNKS_PER_PAGE = 40;
const adminUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL ?? '';
const dbName = `gbrain_test_analyze_yield_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine;
let naptime: string | undefined;

let chunksOid = 0;

/** The transactions that wrote content_chunks' pg_statistic rows: they change exactly when an ANALYZE samples the table. */
async function chunkStatisticsXmin(): Promise<string> {
  const [row] = await engine.executeRaw<{ x: string }>(`SELECT string_agg(xmin::text, ',' ORDER BY staattnum) AS x FROM pg_statistic WHERE starelid = 'content_chunks'::regclass`);
  return String(row?.x);
}

/** The autovacuum worker vacuuming content_chunks in this database, if any (the test role is a superuser, so it sees relid). */
async function vacuumingPid(): Promise<number | null> {
  const [row] = await admin!.unsafe(`SELECT p.pid FROM pg_stat_progress_vacuum p JOIN pg_stat_activity a ON a.pid = p.pid
    WHERE p.datname = $1 AND a.backend_type = 'autovacuum worker' AND p.relid = $2::oid`, [dbName, chunksOid]);
  return row ? Number(row.pid) : null;
}

(hasDatabase() ? describe : describe.skip)('ANALYZE yields to a running autovacuum (Postgres, #7083)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 3 });
    await engine.initSchema();
    for (const table of ['content_chunks', 'pages']) await engine.executeRaw(`ALTER TABLE ${table} SET (autovacuum_enabled = off, toast.autovacuum_enabled = off)`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'notes/yield-' || i, 'default', 'note', 'Yield ' || i, 'fixture', '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(1, ${PAGES}) i`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash)
      SELECT p.id, c, 'chunk ' || p.id || '/' || c, 'compiled_truth', 'openai:text-embedding-3-small', md5('chunk ' || p.id || '/' || c)
      FROM pages p CROSS JOIN generate_series(0, ${CHUNKS_PER_PAGE - 1}) c`);
    const [oid] = await engine.executeRaw<{ oid: number }>(`SELECT 'content_chunks'::regclass::oid::int8 AS oid`);
    chunksOid = Number(oid!.oid);
    const [setting] = await admin.unsafe(`SELECT setting FROM pg_settings WHERE name = 'autovacuum_naptime'`);
    naptime = String(setting!.setting);
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect();
    resetGateway();
    if (admin) {
      await admin.unsafe('ALTER SYSTEM RESET autovacuum_naptime').catch(() => undefined);
      await admin.unsafe('SELECT pg_reload_conf()').catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  test('an embed drain that changed few chunks of a sampled table leaves the chunk statistics alone', async () => {
    expect(await refreshProjectionStatistics(engine)).toBe(true);
    const sampled = await chunkStatisticsXmin();
    expect(sampled).not.toBe('undefined');
    expect(await refreshChunkStatistics(engine, 10)).toBe(true);
    expect(await chunkStatisticsXmin()).toBe(sampled);
    expect(await refreshChunkStatistics(engine, 50 + 0.1 * PAGES * CHUNKS_PER_PAGE)).toBe(true);
    expect(await chunkStatisticsXmin()).not.toBe(sampled);
  }, 60_000);

  test('a small drain under a model the sample has never seen still refreshes (a partial model switch)', async () => {
    const sampled = await chunkStatisticsXmin();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    try {
      await engine.executeRaw(`UPDATE content_chunks SET model = 'openai:text-embedding-3-large' WHERE page_id <= 10`);
      expect(await refreshChunkStatistics(engine, 10 * CHUNKS_PER_PAGE)).toBe(true);
      expect(await chunkStatisticsXmin()).not.toBe(sampled);
    } finally {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    }
  }, 60_000);

  test('doctor reports a hot table whose autovacuum never completes', async () => {
    await engine.executeRaw(`DELETE FROM content_chunks WHERE chunk_index >= ${CHUNKS_PER_PAGE - 12}`);
    let starved = await readVacuumStarvation(engine);
    for (let i = 0; i < 40 && !starved.length; i++) { await Bun.sleep(250); starved = await readVacuumStarvation(engine); }
    expect(starved.map(s => s.table)).toEqual(['content_chunks']);
    expect(starved[0]!.vacuumed_at).toBeNull();
    expect(starved[0]!.dead_rows).toBeGreaterThan(starved[0]!.threshold);
    const [check] = await plannerStatsEntry.run({ engine, progress: { heartbeat: () => {} } } as unknown as DoctorContext) as Check[];
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('Autovacuum is starved: content_chunks');
  }, 60_000);

  test('every ANALYZE gbrain runs defers at once while an autovacuum holds content_chunks, and the autovacuum is not cancelled', async () => {
    const [deadlock] = await admin!.unsafe(`SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`);
    const deadlockMs = Number(deadlock!.ms);
    // A slow autovacuum of content_chunks only: 100 ms per page visited, no analyze.
    await engine.executeRaw(`ALTER TABLE content_chunks SET (autovacuum_enabled = on, autovacuum_vacuum_threshold = 0, autovacuum_vacuum_scale_factor = 0,
      autovacuum_vacuum_insert_threshold = -1, autovacuum_analyze_threshold = 2000000000, autovacuum_vacuum_cost_delay = 100, autovacuum_vacuum_cost_limit = 1)`);
    await admin!.unsafe(`ALTER SYSTEM SET autovacuum_naptime = '1s'`);
    await admin!.unsafe('SELECT pg_reload_conf()');
    let pid: number | null = null;
    for (let i = 0; i < 240 && pid === null; i++) { await Bun.sleep(250); pid = await vacuumingPid(); }
    expect(pid, `precondition: autovacuum never started on content_chunks (naptime was ${naptime})`).not.toBeNull();
    expect((await readVacuumStarvation(engine))[0]?.vacuum_running).toBe(true);

    const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const out = await run(); return [out, performance.now() - t]; };
    const [chunks, chunkMs] = await timed(() => refreshChunkStatistics(engine));
    expect(chunks).toBe(false);
    // The page step still refreshes; only the chunk step behind its savepoint is deferred.
    const [projection, projectionMs] = await timed(() => refreshProjectionStatistics(engine));
    expect(projection).toBe(true);
    const [repair, repairMs] = await timed(() => repairPlannerTable(engine, 'content_chunks').then(() => null, (error: unknown) => error));
    expect(analyzeDeferred(repair)).toBe(true);
    const [migration, migrationMs] = await timed(() => analyzeYieldingToVacuum(engine, 'content_chunks', 'body_generation'));
    expect(migration).toBe(false);
    const [index, indexMs] = await timed(() => analyzeAfterIndexBuild(engine, { name: 'idx_fixture', table: 'content_chunks' }));
    expect(index).toBe(false);
    for (const ms of [chunkMs, projectionMs, repairMs, migrationMs, indexMs]) expect(ms).toBeLessThan(deadlockMs);

    // Past deadlock_timeout, the same autovacuum is still vacuuming the table: nothing waited on it, so nothing cancelled it.
    await Bun.sleep(deadlockMs * 2);
    expect(await vacuumingPid()).toBe(pid);
  }, 180_000);
});
