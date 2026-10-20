/**
 * PR #6959 on real Postgres + pgvector: a migration's paid estimate and its
 * worst-case authorization leave out chunks whose vectors are already in the
 * target space (same model, text hash and width), because invalidation keeps
 * those vectors and the drain only restamps their page. The PGLite arm is
 * test/migrate-embeddings-dry-run-split-5226.serial.test.ts.
 *
 *   Run: DATABASE_URL=postgres://...gbrain_test bun test test/e2e/migration-restamp-estimate-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { planEmbeddingMigration } from '../../src/core/embedding-migration.ts';
import { planMigrationWorstCase } from '../../src/core/embedding-migration-worst-case.ts';
import { readContentChunksEmbeddingDim } from '../../src/core/embedding-dim-check.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const MODEL = 'openai:text-embedding-3-large';
let engine: PostgresEngine;
let dims: number;

async function seed(slug: string, chunks: number, vectors: boolean): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, Array.from({ length: chunks }, (_, i) => ({
    chunk_index: i, chunk_text: `${slug} body ${i}`, chunk_source: 'compiled_truth' as const, token_count: 4,
    ...(vectors ? { embedding: new Float32Array(dims).fill(0.002), model: MODEL } : {}),
  })));
}

d('migration estimate excludes restamp-only chunks (Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    dims = (await readContentChunksEmbeddingDim(engine)).dims!;
    configureGateway({ embedding_model: MODEL, embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  }, 60_000);

  afterAll(async () => {
    resetGateway();
    await teardownDB();
  });

  test('plan chars, cost and worst case match the paid-only brain', async () => {
    const target = { to: MODEL, dim: dims, fromModel: 'legacy:model', fromDims: dims };
    await seed('no-vectors', 1, false);
    const paidOnly = await planEmbeddingMigration(engine, target);
    const paidWorst = await planMigrationWorstCase(engine, paidOnly);
    await seed('current-vectors', 2, true);
    const mixed = await planEmbeddingMigration(engine, target);
    expect(mixed.dim_change).toBe(false);
    expect(mixed.chunks_to_restamp).toBe(2);
    expect(paidOnly.total_chars).toBe('no-vectors body 0'.length);
    expect(mixed.total_chars).toBe(paidOnly.total_chars);
    expect(mixed.est_cost_usd).toBe(paidOnly.est_cost_usd);
    expect(await planMigrationWorstCase(engine, mixed)).toEqual(paidWorst);
  });
});
