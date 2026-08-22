/**
 * Extraction quarantine lane (issue #160) — LIVE Postgres parity.
 *
 * The PGLite coverage lives in test/extraction-review.test.ts; this file
 * re-runs the SQL-touching pieces on a real Postgres so the shared
 * `unverifiedExtractionFragment` predicate, the engine method
 * `getUnverifiedExtractionPageIds`, the source-boost guard inside
 * `buildSourceFactorCase`, and the review-op raw SQL are proven on both
 * engines (PGLite can hide postgres.js-specific behavior).
 *
 * Gated by DATABASE_URL via hasDatabase(); skips cleanly when unset.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/extraction-review-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { enrichEntity } from '../../src/core/enrichment-service.ts';
import { isUnverifiedExtraction, STATUS_VERIFIED, EXTRACTION_STATUS_KEY } from '../../src/core/extraction-review.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...over,
  } as OperationContext;
}

d('extraction quarantine lane (live Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  }, 60_000);

  test('untrusted enrichEntity → markers; getUnverifiedExtractionPageIds sees them', async () => {
    await enrichEntity(engine, { entityName: 'Pg Fake', entityType: 'person', context: 'c', sourceSlug: 's' });
    await enrichEntity(engine, { entityName: 'Pg Real', entityType: 'person', context: 'c', sourceSlug: 's' }, { trusted: true });
    const fake = await engine.getPage('people/pg-fake');
    const real = await engine.getPage('people/pg-real');
    expect(isUnverifiedExtraction(fake!.frontmatter)).toBe(true);
    expect(isUnverifiedExtraction(real!.frontmatter)).toBe(false);
    const marks = await engine.getUnverifiedExtractionPageIds([fake!.id, real!.id]);
    expect(marks.get(fake!.id)).toEqual({ unverified: true, status: 'unverified' });
    expect(marks.has(real!.id)).toBe(false);
  });

  test('SQL source-boost guard: unverified stub loses the people/ 1.2x in searchKeyword', async () => {
    await engine.upsertChunks('people/pg-fake', [{ chunk_index: 0, chunk_text: 'flurbo synergy report alpha', chunk_source: 'compiled_truth', token_count: 4 }]);
    await engine.upsertChunks('people/pg-real', [{ chunk_index: 0, chunk_text: 'flurbo synergy report bravo', chunk_source: 'compiled_truth', token_count: 4 }]);
    const rows = await engine.searchKeyword('flurbo', { limit: 10 });
    const fake = rows.find((r) => r.slug === 'people/pg-fake')!;
    const real = rows.find((r) => r.slug === 'people/pg-real')!;
    expect(fake).toBeDefined();
    expect(real).toBeDefined();
    // Same base ts_rank; only the verified page carries the 1.2 factor.
    expect(real.score / fake.score).toBeCloseTo(1.2, 5);
  });

  test('vector arm: unverified stub gets source factor 1.0 in searchVector re-rank', async () => {
    // The 1.2x people/ factor multiplies raw_score inside the scored CTE,
    // pre-LIMIT — the guard column projected in hnsw_candidates must zero it
    // out for unverified stubs. Identical basis embeddings → identical
    // cosine → the score ratio IS the factor. (1536-dim basis vectors match
    // the shared e2e schema, same as test/e2e/engine-parity.test.ts.)
    const basis = new Float32Array(1536);
    basis[7] = 1.0;
    await engine.upsertChunks('people/pg-fake', [{ chunk_index: 1, chunk_text: 'vec alpha', chunk_source: 'compiled_truth', embedding: basis, token_count: 2 }]);
    await engine.upsertChunks('people/pg-real', [{ chunk_index: 1, chunk_text: 'vec bravo', chunk_source: 'compiled_truth', embedding: basis, token_count: 2 }]);
    const rows = await engine.searchVector(basis, { limit: 10 });
    const fake = rows.find((r) => r.slug === 'people/pg-fake')!;
    const real = rows.find((r) => r.slug === 'people/pg-real')!;
    expect(fake).toBeDefined();
    expect(real).toBeDefined();
    expect(real.score / fake.score).toBeCloseTo(1.2, 5);
  });

  test('extraction_pending + extraction_review promote/reject run on Postgres', async () => {
    const pending = (await operationsByName['extraction_pending']!.handler(ctx(), {})) as {
      pending: Array<{ slug: string }>;
    };
    expect(pending.pending.map((r) => r.slug)).toContain('people/pg-fake');

    const out = (await operationsByName['extraction_review']!.handler(ctx({ remote: false }), {
      action: 'promote', slugs: ['people/pg-fake'],
    })) as { results: Array<{ slug: string; status: string }> };
    expect(out.results[0].status).toBe('promoted');
    const promoted = await engine.getPage('people/pg-fake');
    expect(promoted!.frontmatter[EXTRACTION_STATUS_KEY]).toBe(STATUS_VERIFIED);

    await enrichEntity(engine, { entityName: 'Pg Reject', entityType: 'person', context: 'c', sourceSlug: 's' });
    const rej = (await operationsByName['extraction_review']!.handler(ctx({ remote: false }), {
      action: 'reject', slugs: ['people/pg-reject'],
    })) as { results: Array<{ slug: string; status: string }> };
    expect(rej.results[0].status).toBe('rejected');
    expect(await engine.getPage('people/pg-reject')).toBeNull();
  });
});
