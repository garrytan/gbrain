/**
 * #3390/#3391 — embedding migration on REAL Postgres + pgvector.
 *
 * Engine-parity pin for the #3391 includeNullSignature predicates
 * (identical semantics to the PGLite coverage in
 * test/embedding-migration.test.ts) PLUS the migration path that genuinely
 * differs on real Postgres: runSchemaTransition's DROP INDEX / DROP COLUMN /
 * ADD vector(N) / CREATE hnsw sequence against a native pgvector, followed
 * by a full re-embed through the real pipeline with a fake transport.
 *
 * Gated by DATABASE_URL (docs/TESTING.md: docker pgvector/pgvector:pg16,
 * e.g. on :5435). Restores the original column width in afterAll so later
 * e2e files see the schema they expect.
 *
 *   Run: DATABASE_URL=postgres://...gbrain_test bun test test/e2e/migrate-embeddings-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import {
  planEmbeddingMigration,
  applyEmbeddingMigration,
  completeEmbeddingMigration,
  migrationSignature,
  MIGRATION_STATE_KEY,
} from '../../src/core/embedding-migration.ts';
import { runSchemaTransition } from '../../src/core/retrieval-upgrade-planner.ts';
import type { ChunkInput } from '../../src/core/types.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;
let originalDims: number;
let currentDims = 0; // fake-transport vector width, set per phase
const savedEnv: Record<string, string | undefined> = {};

async function columnDims(): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
  );
  return Number(rows[0]?.dim);
}

async function embeddingColWidth(table: string): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = $1::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
    [table],
  );
  return Number(rows[0]?.dim);
}

async function seedEmbedded(slug: string, text: string, signature: string | null): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4 },
  ];
  await engine.upsertChunks(slug, chunks);
  await engine.executeRaw(
    `UPDATE content_chunks
        SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = 'default')`,
    [originalDims, slug],
  );
  if (signature !== null) {
    await engine.setPageEmbeddingSignature(slug, { signature });
  }
}

d('embedding migration (live Postgres + pgvector)', () => {
  beforeAll(async () => {
    for (const k of ['GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    engine = await setupDB();
    originalDims = await columnDims();

    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.cos(i) * 0.01 + 0.002)),
      usage: { tokens: values.length * 4 },
    }) as never);
  }, 60000);

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    // Restore the shared test DB's column width for subsequent e2e files.
    if (engine && originalDims && (await columnDims()) !== originalDims) {
      await runSchemaTransition(engine, originalDims);
    }
    await teardownDB();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60000);

  test('#3391 predicates behave identically to PGLite (engine parity)', async () => {
    await seedEmbedded('parity/legacy', 'abcde', null);            // NULL sig
    await seedEmbedded('parity/drifted', 'fghij', 'old:model:1');  // mismatched
    await seedEmbedded('parity/fresh', 'klmno', 'new:model:1');    // matching
    const sig = 'new:model:1';

    // Grandfathered (no flag): only the drifted page counts.
    expect(await engine.countStaleChunks({ signature: sig })).toBe(1);
    expect(await engine.sumStaleChunkChars({ signature: sig })).toBe(5);
    // Widened (#3391): legacy counts too; matching still excluded.
    expect(await engine.countStaleChunks({ signature: sig, includeNullSignature: true })).toBe(2);
    expect(await engine.sumStaleChunkChars({ signature: sig, includeNullSignature: true })).toBe(10);

    // Invalidation parity: default grandfathers, flag lifts it, idempotent.
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: sig })).toBe(1);
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: sig, includeNullSignature: true })).toBe(1); // legacy
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: sig, includeNullSignature: true })).toBe(0);
    const kept = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'parity/fresh' AND cc.embedding IS NOT NULL`,
    );
    expect(Number(kept[0]?.n)).toBe(1);

    // Clean up parity fixtures so the migration test below starts exact.
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'parity/%'`);
  }, 30000);

  test('full migration with a dimension change on real pgvector', async () => {
    const targetDims = originalDims === 1536 ? 1024 : 1536;
    const toModel = targetDims === 1536 ? 'openai:text-embedding-3-small' : 'voyage:voyage-3-large';

    // Brain state: one current-signature page, one pre-v108 NULL-signature
    // page, one never-embedded page.
    await seedEmbedded('mig/current', 'aaaaa', migrationSignature('zeroentropyai:zembed-1', originalDims));
    await seedEmbedded('mig/legacy', 'bbbbb', null);
    await engine.putPage('mig/pending', { type: 'note', title: 'pending', compiled_truth: '# pending' });
    await engine.upsertChunks('mig/pending', [
      { chunk_index: 0, chunk_text: 'ccccc', chunk_source: 'compiled_truth', token_count: 2 },
    ]);

    const plan = await planEmbeddingMigration(engine, {
      to: toModel,
      dim: targetDims,
      fromModel: 'zeroentropyai:zembed-1',
      fromDims: originalDims,
    });
    expect(plan.dim_change).toBe(true);
    expect(plan.chunks_to_embed).toBe(3);
    expect(plan.null_signature_chunks).toBe(1);

    // Apply: runSchemaTransition on REAL Postgres (native pgvector DDL).
    const persisted: Array<[string, number]> = [];
    const applied = await applyEmbeddingMigration(engine, plan, {
      persistConfig: (m, dd) => { persisted.push([m, dd]); },
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('unreachable');
    expect(applied.schema_transitioned).toBe(true);
    expect(persisted).toEqual([[toModel, targetDims]]);
    expect(await columnDims()).toBe(targetDims);

    // All THREE dim-pinned text-embedding-space columns move together on real
    // pgvector (query_cache + facts are created at brain-birth width and no
    // migration ever ALTERs them — before the fix they stayed narrow, which
    // silently killed the query cache and every per-fact embed write).
    expect(await embeddingColWidth('query_cache')).toBe(targetDims);
    expect(await embeddingColWidth('facts')).toBe(targetDims);
    // And the rebuilt columns actually ACCEPT a vector at the new width.
    const nv = `[${new Array(targetDims).fill(0.01).join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id, embedding)
       VALUES ('pg-post-migrate', 'q', 'default', $1::vector)`,
      [nv],
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence, embedding)
       VALUES ('default', 'pg-e', 'pg-f', 'fact', 'private', 'medium', 'test', 1.0, $1::vector)`,
      [nv],
    );
    const accepted = await engine.executeRaw<{ qc: number; f: number }>(
      `SELECT (SELECT count(*)::int FROM query_cache WHERE id = 'pg-post-migrate') AS qc,
              (SELECT count(*)::int FROM facts WHERE entity_slug = 'pg-e') AS f`,
    );
    expect(Number(accepted[0]?.qc)).toBe(1);
    expect(Number(accepted[0]?.f)).toBe(1);
    expect(await engine.getConfig('embedding_model')).toBe(toModel);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeTruthy();

    // HNSW index rebuilt inside the same transaction.
    const idx = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'content_chunks' AND indexname = 'idx_chunks_embedding'`,
    );
    expect(idx.length).toBe(1);

    // Re-embed through the real pipeline at the new width. NOTE: no
    // resetGateway() here — it would clear the installed fake transport.
    currentDims = targetDims;
    configureGateway({
      embedding_model: toModel,
      embedding_dimensions: targetDims,
      env: { OPENAI_API_KEY: 'sk-test-fake', VOYAGE_API_KEY: 'va-test-fake' },
    });
    const res = await runEmbedCore(engine, {
      stale: true, catchUp: true, includeNullSignature: true, quiet: true,
    });
    expect(res.embedded).toBe(3);

    // Everything is in the target space, including the NULL-signature page.
    const newSig = migrationSignature(toModel, targetDims);
    expect(await engine.countStaleChunks({ signature: newSig, includeNullSignature: true })).toBe(0);
    const sigs = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'mig/%' AND embedding_signature = $1`,
      [newSig],
    );
    expect(Number(sigs[0]?.n)).toBe(3);

    // Vector search works against the new column at the new width.
    const qvec = `[${new Array(targetDims).fill(0).map((_, i) => (Math.cos(i) * 0.01 + 0.002).toFixed(6)).join(',')}]`;
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT p.slug FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE cc.embedding IS NOT NULL
       ORDER BY cc.embedding <=> $1::vector
       LIMIT 3`,
      [qvec],
    );
    expect(rows.length).toBe(3);

    await completeEmbeddingMigration(engine, plan);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
  }, 120000);
});
