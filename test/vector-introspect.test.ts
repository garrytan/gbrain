/**
 * Regression suite for the SQL-layer guard against pgvector's
 * 2000-dim HNSW cap (upstream gbrain #1141 / #1189).
 *
 * Covers two layers:
 *   1. `resolveSchemaDims` — pure decision function, no I/O.
 *   2. `getLiveVectorColumnDims` against a real PGLite engine where we
 *      manually pre-seed a `content_chunks` table at a non-default dim
 *      and then assert the helper returns that dim. End-to-end proof
 *      that `format_type()` round-trips on PGLite for the wide-dim case
 *      that triggers the bug.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  getLiveVectorColumnDims,
  resolveSchemaDims,
  PGVECTOR_HNSW_VECTOR_MAX_DIMS,
  type VectorIntrospectQuery,
} from '../src/core/vector-introspect.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('resolveSchemaDims — HNSW boundary override decision', () => {
  test('no override when live dim is null (column absent / fresh install)', () => {
    const r = resolveSchemaDims(1536, null);
    expect(r.dims).toBe(1536);
    expect(r.overridden).toBe(false);
  });

  test('no override when live dim matches gateway dim', () => {
    const r = resolveSchemaDims(1536, 1536);
    expect(r.dims).toBe(1536);
    expect(r.overridden).toBe(false);
  });

  test('no override when both sides are below the cap (drift but no policy flip)', () => {
    // Gateway thinks 1024, live is 1536. Both <= 2000, both want HNSW.
    // The override would mask genuine config drift without preventing a
    // policy mistake; leave it alone.
    const r = resolveSchemaDims(1024, 1536);
    expect(r.dims).toBe(1024);
    expect(r.overridden).toBe(false);
  });

  test('no override when both sides are above the cap (drift but no policy flip)', () => {
    // Gateway thinks 3072, live is 2560. Both > 2000, both skip HNSW.
    // Same logic — drift exists but the cap policy is unaffected.
    const r = resolveSchemaDims(3072, 2560);
    expect(r.dims).toBe(3072);
    expect(r.overridden).toBe(false);
  });

  test('OVERRIDE: gateway under cap, live over cap (the #1141 bug path)', () => {
    // The signature failure mode: gateway falls back to 1536 because the
    // `gbrain init --migrate-only` subprocess hasn't read
    // ~/.gbrain/config.json yet, but the live column is vector(2560)
    // from a previous zembed-1 switch. Schema replay would otherwise
    // emit the HNSW index and pgvector would reject.
    const r = resolveSchemaDims(1536, 2560);
    expect(r.dims).toBe(2560);
    expect(r.overridden).toBe(true);
    expect(r.reason).toContain('vector(2560)');
    expect(r.reason).toContain('1536');
  });

  test('OVERRIDE: gateway over cap, live under cap (reverse drift)', () => {
    // Hypothetical inverse: brain was high-dim, user re-embedded
    // to 1024-dim, gateway not yet refreshed (still thinks 2560). The
    // live column is now 1024 and HNSW should be emitted; gateway-
    // dictated SKIP would leave the brain without an HNSW index it
    // could legitimately have.
    const r = resolveSchemaDims(2560, 1024);
    expect(r.dims).toBe(1024);
    expect(r.overridden).toBe(true);
  });

  test('boundary: live exactly at 2000 + gateway at 2001 flips', () => {
    const r = resolveSchemaDims(2001, PGVECTOR_HNSW_VECTOR_MAX_DIMS);
    expect(r.dims).toBe(PGVECTOR_HNSW_VECTOR_MAX_DIMS);
    expect(r.overridden).toBe(true);
  });

  test('boundary: live exactly at 2001 + gateway at 2000 flips', () => {
    const r = resolveSchemaDims(PGVECTOR_HNSW_VECTOR_MAX_DIMS, 2001);
    expect(r.dims).toBe(2001);
    expect(r.overridden).toBe(true);
  });
});

describe('getLiveVectorColumnDims — identifier-shape gate', () => {
  const neverCalled: VectorIntrospectQuery = async () => {
    throw new Error('query should not run when identifier gate trips');
  };

  test('rejects table names with semicolons (injection probe)', async () => {
    const r = await getLiveVectorColumnDims(neverCalled, 'content_chunks; DROP TABLE pages--', 'embedding');
    expect(r).toBe(null);
  });

  test('rejects column names with quotes', async () => {
    const r = await getLiveVectorColumnDims(neverCalled, 'content_chunks', "embedding'");
    expect(r).toBe(null);
  });

  test('rejects mixed-case (production schema is lowercase)', async () => {
    const r = await getLiveVectorColumnDims(neverCalled, 'ContentChunks', 'embedding');
    expect(r).toBe(null);
  });

  test('rejects empty string', async () => {
    const r = await getLiveVectorColumnDims(neverCalled, '', 'embedding');
    expect(r).toBe(null);
  });
});

describe('getLiveVectorColumnDims — parse contract', () => {
  test('parses vector(N) from format_type output', async () => {
    const fakeQuery: VectorIntrospectQuery = async () => [{ column_type: 'vector(2560)' }];
    const r = await getLiveVectorColumnDims(fakeQuery, 'content_chunks', 'embedding');
    expect(r).toBe(2560);
  });

  test('returns null when type is not vector', async () => {
    const fakeQuery: VectorIntrospectQuery = async () => [{ column_type: 'text' }];
    const r = await getLiveVectorColumnDims(fakeQuery, 'content_chunks', 'embedding');
    expect(r).toBe(null);
  });

  test('returns null when row missing column_type', async () => {
    const fakeQuery: VectorIntrospectQuery = async () => [{}];
    const r = await getLiveVectorColumnDims(fakeQuery, 'content_chunks', 'embedding');
    expect(r).toBe(null);
  });

  test('returns null when zero rows (column absent)', async () => {
    const fakeQuery: VectorIntrospectQuery = async () => [];
    const r = await getLiveVectorColumnDims(fakeQuery, 'content_chunks', 'embedding');
    expect(r).toBe(null);
  });

  test('returns null when query throws (managed-pg permissions, etc.)', async () => {
    const fakeQuery: VectorIntrospectQuery = async () => { throw new Error('insufficient privilege'); };
    const r = await getLiveVectorColumnDims(fakeQuery, 'content_chunks', 'embedding');
    expect(r).toBe(null);
  });
});

describe('getLiveVectorColumnDims — live PGLite round-trip', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    // Don't call initSchema — we want to control the column shape
    // ourselves so this test exercises the exact 2560-dim wedge case.
    await engine.executeRaw('CREATE EXTENSION IF NOT EXISTS vector');
    await engine.executeRaw('CREATE TABLE content_chunks (id BIGSERIAL PRIMARY KEY, embedding vector(2560))');
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('returns the live dim for a vector(2560) column', async () => {
    const dim = await getLiveVectorColumnDims(
      async (sql, params) => {
        const result = await (engine as unknown as { db: { query(s: string, p?: unknown[]): Promise<{ rows: unknown[] }> } }).db.query(sql, params ? Array.from(params) : []);
        return result.rows as ReadonlyArray<Record<string, unknown>>;
      },
      'content_chunks',
      'embedding',
    );
    expect(dim).toBe(2560);
  });

  test('returns null for a column that does not exist on the live table', async () => {
    const dim = await getLiveVectorColumnDims(
      async (sql, params) => {
        const result = await (engine as unknown as { db: { query(s: string, p?: unknown[]): Promise<{ rows: unknown[] }> } }).db.query(sql, params ? Array.from(params) : []);
        return result.rows as ReadonlyArray<Record<string, unknown>>;
      },
      'content_chunks',
      'this_column_does_not_exist',
    );
    expect(dim).toBe(null);
  });

  test('returns null for a table that does not exist', async () => {
    const dim = await getLiveVectorColumnDims(
      async (sql, params) => {
        const result = await (engine as unknown as { db: { query(s: string, p?: unknown[]): Promise<{ rows: unknown[] }> } }).db.query(sql, params ? Array.from(params) : []);
        return result.rows as ReadonlyArray<Record<string, unknown>>;
      },
      'nonexistent_table',
      'embedding',
    );
    expect(dim).toBe(null);
  });
});
