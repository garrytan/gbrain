/**
 * PGLite HNSW builds fit the WASM heap (GBRA-75 wave 8). pglite.wasm caps its
 * heap at 2 GiB. Three things broke a 50k-page build (248,802 1024-dim
 * chunks): PGLite planned parallel maintenance workers it cannot start, so
 * pgvector reserved all of maintenance_work_mem up front (out of memory at
 * 1 GB); the build WAL-logged its 1.9 GB index in one statement, past the
 * 539 MB automatic checkpoint trigger, which wedges PGLite; and the 64 MB
 * default sent every element past about 14k to hours of on-disk inserts.
 * In-memory PGLite ($0).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { PGLITE_HNSW_GRAPH_BUDGET_BYTES, hnswBuildMemoryMb, withHnswBuildMemory } from '../src/core/vector-index.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.executeRaw('CREATE EXTENSION IF NOT EXISTS vector');
});
afterAll(async () => { await engine.disconnect(); });

test('PGLite starts with no parallel maintenance workers and the checkpoint trigger above any buildable index', async () => {
  const rows = await engine.executeRaw<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings WHERE name IN ('max_parallel_maintenance_workers', 'max_wal_size') ORDER BY name`);
  expect(rows).toEqual([
    { name: 'max_parallel_maintenance_workers', setting: '0' },
    { name: 'max_wal_size', setting: '8192' },
  ]);
  // The index is about 1.7x its graph on disk and its build WAL-logs the whole index; the trigger is max_wal_size / 1.9.
  expect(8192 * 1024 * 1024 / 1.9).toBeGreaterThan(PGLITE_HNSW_GRAPH_BUDGET_BYTES * 1.7);
});

test('the graph estimate covers the measured 50k build and keeps the PGLite default as its floor', () => {
  // Measured: 248,802 vector(1024) elements need 4,669 B each; a 1,300 MB build fit, 1,400 MB of parallel reserve did not.
  const mb = hnswBuildMemoryMb(248_802, 8 + 1024 * 4);
  expect(mb * 1024 * 1024).toBeGreaterThan(248_802 * 4_669);
  expect(mb * 1024 * 1024).toBeLessThanOrEqual(PGLITE_HNSW_GRAPH_BUDGET_BYTES);
  expect(hnswBuildMemoryMb(10, 8 + 1024 * 4)).toBe(64);
});

test('a PGLite build runs with maintenance_work_mem sized to its graph, then the session setting is restored', async () => {
  await engine.executeRaw('CREATE TABLE hx (id int, embedding vector(1))');
  await engine.executeRaw('INSERT INTO hx SELECT g, ARRAY[(g % 97) + 1]::vector FROM generate_series(1, 100000) g');
  const expected = hnswBuildMemoryMb(100_000, 8 + 4);
  expect(expected).toBeGreaterThan(64);
  const during = await withHnswBuildMemory(engine, 'hx', 'embedding', async () => {
    const [row] = await engine.executeRaw<{ maintenance_work_mem: string }>('SHOW maintenance_work_mem');
    await engine.executeRaw('CREATE INDEX hx_hnsw ON hx USING hnsw (embedding vector_l2_ops) WHERE id <= 500');
    return row!.maintenance_work_mem;
  });
  expect(during).toBe(`${expected}MB`);
  const [after] = await engine.executeRaw<{ maintenance_work_mem: string }>('SHOW maintenance_work_mem');
  expect(after!.maintenance_work_mem).toBe('64MB');
  const [built] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'hx_hnsw'`);
  expect(built!.n).toBe(1);
}, 30_000);

test('a graph past the heap budget is refused before the build with a read-only next step', async () => {
  let built = false;
  const big = { kind: 'pglite' as const, executeRaw: async () => [{ rows: 400_000, type: 'vector', dims: 1024 }] as never[] };
  const error = await withHnswBuildMemory(big, 'content_chunks', 'embedding', async () => { built = true; })
    .then(() => null, (e: unknown) => e);
  expect(built).toBe(false);
  expect(error).toBeInstanceOf(OperationError);
  const envelope = toAgentError(error, { transport: 'cli', command: 'reindex', render: cliRenderContext() });
  expect(envelope.code).toBe('pglite_vector_index_too_large');
  expect(envelope.fix?.argv).toEqual(['gbrain', 'migrate', '--to', 'postgres', '--plan', '--json']);
  expect(envelope.fix?.next).toBe('run');
  expect(envelope.fix?.verify).toBeDefined();
});

test('Postgres builds run unchanged, with no sizing query', async () => {
  let queried = false;
  const pg = { kind: 'postgres' as const, executeRaw: async () => { queried = true; return [] as never[]; } };
  expect(await withHnswBuildMemory(pg, 'content_chunks', 'embedding', async () => 'built')).toBe('built');
  expect(queried).toBe(false);
});
