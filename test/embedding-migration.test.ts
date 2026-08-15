/**
 * #3390 — provider-agnostic embedding migration (planner/applier, PGLite) +
 * #3391 — NULL-signature rows must be treatable as stale.
 *
 * Covers:
 *   - resolveMigrationTarget validation (provider:model shape, unknown
 *     provider, recipe-default dims, --dim override, dims-required recipes)
 *   - includeNullSignature widening on countStaleChunks /
 *     sumStaleChunkChars / invalidateStaleSignatureEmbeddings (#3391)
 *   - planEmbeddingMigration counts, cost math, price_known, resuming
 *   - applyEmbeddingMigration: env-override refusal fires BEFORE any
 *     mutation, schema transition on dim change, DB-plane config writes,
 *     state marker, NULL-signature-inclusive invalidation, query-cache
 *     purge, idempotent re-apply (resume)
 *   - completeEmbeddingMigration bookkeeping
 *   - migrate_embeddings op contract (admin, localOnly, remote guard,
 *     needs_confirmation without yes)
 *
 * Canonical PGLite block (CLAUDE.md R3+R4). Engine parity for the #3391
 * predicates is pinned on real Postgres in
 * test/e2e/migrate-embeddings-postgres.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { ChunkInput } from '../src/core/types.ts';
import {
  resolveMigrationTarget,
  planEmbeddingMigration,
  applyEmbeddingMigration,
  completeEmbeddingMigration,
  reconcilePageSignatures,
  migrationSignature,
  MIGRATION_STATE_KEY,
  MIGRATION_COMPLETED_KEY,
} from '../src/core/embedding-migration.ts';
import { estimateCostFromChars } from '../src/core/embedding-pricing.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let colDim: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  colDim = Number(rows[0]?.dim);
});

/** Seed a page with one embedded chunk and a given signature (null = pre-v108). */
async function seedEmbedded(slug: string, text: string, signature: string | null): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
  ];
  await engine.upsertChunks(slug, chunks);
  await engine.executeRaw(
    `UPDATE content_chunks
        SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = 'default')`,
    [colDim, slug],
  );
  if (signature !== null) {
    await engine.setPageEmbeddingSignature(slug, { signature });
  }
}

/** Actual vector(N)/halfvec(N) width of a table's `embedding` column. */
async function embeddingColWidth(table: string): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = $1::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
    [table],
  );
  return Number(rows[0]?.dim);
}

/** Seed a page with one UNembedded chunk (classic NULL-embedding stale). */
async function seedUnembedded(slug: string, text: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
  ]);
}

describe('resolveMigrationTarget', () => {
  test('requires provider:model shape', () => {
    expect(() => resolveMigrationTarget('text-embedding-3-small')).toThrow(/provider:model/);
  });
  test('unknown provider throws', () => {
    expect(() => resolveMigrationTarget('nosuchprovider:some-model')).toThrow();
  });
  test('recipe default dims resolve (openai → 1536)', () => {
    expect(resolveMigrationTarget('openai:text-embedding-3-small')).toEqual({
      toModel: 'openai:text-embedding-3-small',
      toDims: 1536,
    });
  });
  test('explicit --dim wins over recipe default', () => {
    expect(resolveMigrationTarget('openai:text-embedding-3-small', 512).toDims).toBe(512);
  });
  test('recipe with default_dims=0 requires --dim', () => {
    expect(() => resolveMigrationTarget('litellm:my-custom-model')).toThrow(/--dim/);
    expect(resolveMigrationTarget('litellm:my-custom-model', 1024).toDims).toBe(1024);
  });
});

describe('#3391 includeNullSignature widening', () => {
  test('countStaleChunks / sumStaleChunkChars include NULL-signature rows only with the flag', async () => {
    await seedEmbedded('legacy', 'abcde', null);            // NULL sig, embedded
    await seedEmbedded('drifted', 'fghij', 'old:model:1');  // mismatched sig
    await seedEmbedded('fresh', 'klmno', 'new:model:1');    // matching sig
    const sig = 'new:model:1';

    // Default (grandfathered): legacy is invisible.
    expect(await engine.countStaleChunks({ signature: sig })).toBe(1);
    expect(await engine.sumStaleChunkChars({ signature: sig })).toBe(5);

    // Widened: legacy counts too; matching still excluded.
    expect(await engine.countStaleChunks({ signature: sig, includeNullSignature: true })).toBe(2);
    expect(await engine.sumStaleChunkChars({ signature: sig, includeNullSignature: true })).toBe(10);
  });

  test('invalidateStaleSignatureEmbeddings with the flag NULLs legacy + drifted, keeps matching', async () => {
    await seedEmbedded('legacy', 'abcde', null);
    await seedEmbedded('drifted', 'fghij', 'old:model:1');
    await seedEmbedded('fresh', 'klmno', 'new:model:1');

    const n = await engine.invalidateStaleSignatureEmbeddings({
      signature: 'new:model:1',
      includeNullSignature: true,
    });
    expect(n).toBe(2); // legacy + drifted; NOT fresh

    expect(await engine.countStaleChunks()).toBe(2); // both now NULL-embedding
    const kept = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'fresh' AND cc.embedding IS NOT NULL`,
    );
    expect(Number(kept[0]?.n)).toBe(1);

    // Idempotent.
    expect(await engine.invalidateStaleSignatureEmbeddings({
      signature: 'new:model:1', includeNullSignature: true,
    })).toBe(0);
  });

  test('default behavior unchanged: NULL signature stays grandfathered without the flag', async () => {
    await seedEmbedded('legacy', 'abcde', null);
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: 'new:model:1' })).toBe(0);
    expect(await engine.countStaleChunks({ signature: 'new:model:1' })).toBe(0);
  });
});

describe('planEmbeddingMigration', () => {
  test('counts everything not in the target space, splits out NULL-signature chunks, prices it', async () => {
    await seedEmbedded('legacy', 'abcde', null);                                 // 5 chars
    await seedEmbedded('current', 'fghij', `zeroentropyai:zembed-1:${colDim}`);  // 5 chars
    await seedUnembedded('pending', 'klmnop');                                   // 6 chars

    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small',
      fromModel: 'zeroentropyai:zembed-1',
      fromDims: colDim,
    });

    expect(plan.to_model).toBe('openai:text-embedding-3-small');
    expect(plan.to_dims).toBe(1536);
    expect(plan.column_dims).toBe(colDim);
    expect(plan.dim_change).toBe(colDim !== 1536);
    expect(plan.chunks_to_embed).toBe(3);        // all three
    expect(plan.null_signature_chunks).toBe(1);  // 'legacy' only
    expect(plan.total_chars).toBe(16);
    expect(plan.price_known).toBe(true);
    expect(plan.est_cost_usd).toBeCloseTo(estimateCostFromChars(16, 0.02), 10);
    expect(plan.resuming).toBe(false);
  });

  test('unknown pricing → price_known false, cost 0', async () => {
    await seedUnembedded('p1', 'abc');
    const plan = await planEmbeddingMigration(engine, { to: 'litellm:custom', dim: 1024 });
    expect(plan.price_known).toBe(false);
    expect(plan.est_cost_usd).toBe(0);
  });

  test('resuming=true when the state marker matches the target', async () => {
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
      to_model: 'openai:text-embedding-3-small', to_dims: 1536,
      from_model: 'x', from_dims: 1, started_at: 'now',
    }));
    const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-small' });
    expect(plan.resuming).toBe(true);
    const other = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-large' });
    expect(other.resuming).toBe(false);
  });

  test('reranker on the outgoing provider triggers the warning', async () => {
    await engine.setConfig('search.reranker.model', 'zeroentropyai:zerank-2');
    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small',
      fromModel: 'zeroentropyai:zembed-1',
      fromDims: 1280,
    });
    expect(plan.reranker_warning).toContain('zeroentropyai:zerank-2');
  });
});

describe('applyEmbeddingMigration', () => {
  test('env override refuses BEFORE any mutation', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-3-large' }, async () => {
      const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-small' });
      const res = await applyEmbeddingMigration(engine, plan);
      expect(res.status).toBe('refused');
      expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
      expect(await engine.getConfig('embedding_model')).toBeFalsy();
    });
  });

  test('same-dim swap: no schema transition; invalidates legacy + drifted; writes config + state; purges cache', async () => {
    await seedEmbedded('legacy', 'abcde', null);
    await seedEmbedded('drifted', 'fghij', `old:model:${colDim}`);
    // Seed a query-cache row that must not survive the swap.
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc1', 'stale query', 'default')`,
    );

    const persisted: Array<[string, number]> = [];
    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: colDim, // same width → no DDL
    });
    const res = await applyEmbeddingMigration(engine, plan, {
      persistConfig: (m, d) => { persisted.push([m, d]); },
    });

    expect(res.status).toBe('applied');
    if (res.status !== 'applied') throw new Error('unreachable');
    expect(res.schema_transitioned).toBe(false);
    expect(res.invalidated).toBe(2); // legacy (#3391) + drifted
    expect(res.cache_cleared).toBe(1);
    expect(persisted).toEqual([['openai:text-embedding-3-small', colDim]]);
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-small');
    expect(await engine.getConfig('embedding_dimensions')).toBe(String(colDim));
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeTruthy();

    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  });

  test('dim change: schema transition rebuilds the column at the target width; re-apply is a no-op', async () => {
    await seedEmbedded('a', 'abcde', null);
    const target = colDim === 512 ? 256 : 512;
    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: target,
    });
    const res = await applyEmbeddingMigration(engine, plan);
    expect(res.status).toBe('applied');
    if (res.status !== 'applied') throw new Error('unreachable');
    expect(res.schema_transitioned).toBe(true);

    const rows = await engine.executeRaw<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0 AND NOT attisdropped`,
    );
    expect(Number(rows[0]?.dim)).toBe(target);

    // Every embedding is NULL after the column rebuild → classic stale.
    expect(await engine.countStaleChunks()).toBe(1);

    // Resume: second apply must not transition again (column already at target).
    const res2 = await applyEmbeddingMigration(engine, plan);
    expect(res2.status).toBe('applied');
    if (res2.status !== 'applied') throw new Error('unreachable');
    expect(res2.schema_transitioned).toBe(false);
    expect(res2.invalidated).toBe(0);
  });

  test('dim change transitions ALL THREE text-embedding-space columns (blocker: query_cache + facts were left at the old width)', async () => {
    const target = colDim === 512 ? 256 : 512;

    // Pre-condition: all three start at the brain-birth width.
    expect(await embeddingColWidth('content_chunks')).toBe(colDim);
    expect(await embeddingColWidth('query_cache')).toBe(colDim);
    expect(await embeddingColWidth('facts')).toBe(colDim);

    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: target,
    });
    const res = await applyEmbeddingMigration(engine, plan);
    expect(res.status).toBe('applied');

    // All three must move together. Before the fix, query_cache and facts
    // stayed narrow: the query cache silently accepted ZERO rows forever
    // (store() + lookup() swallow the width error by design) and every
    // per-fact embed write failed.
    expect(await embeddingColWidth('content_chunks')).toBe(target);
    expect(await embeddingColWidth('query_cache')).toBe(target);
    expect(await embeddingColWidth('facts')).toBe(target);
  });

  test('post-transition the query cache can actually STORE a row at the new width', async () => {
    const target = colDim === 512 ? 256 : 512;
    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: target,
    });
    expect((await applyEmbeddingMigration(engine, plan)).status).toBe('applied');

    // The real regression symptom: a width-mismatched column makes this
    // INSERT throw, which query-cache.ts swallows → permanent 0% hit rate.
    const vec = `[${new Array(target).fill(0.01).join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id, embedding)
       VALUES ('post-migrate', 'q', 'default', $1::vector)`,
      [vec],
    );
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM query_cache WHERE id = 'post-migrate'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test('post-transition a fact embedding at the new width inserts (blocker: facts writes broke)', async () => {
    const target = colDim === 512 ? 256 : 512;
    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: target,
    });
    expect((await applyEmbeddingMigration(engine, plan)).status).toBe('applied');

    const vec = `[${new Array(target).fill(0.02).join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence, embedding)
       VALUES ('default', 'e', 'f', 'fact', 'private', 'medium', 'test', 1.0, $1::vector)`,
      [vec],
    );
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE entity_slug = 'e'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test('reconcilePageSignatures stamps fully-embedded pages and leaves partially-embedded ones alone', async () => {
    // 'done' — every chunk embedded, but signature still the OLD one (the
    // batch-boundary shape: embedded correctly, stamp skipped).
    await seedEmbedded('done', 'abcde', 'old:model:1');
    // 'partial' — one embedded chunk + one NULL chunk (a real embed failure).
    await seedEmbedded('partial', 'fghij', 'old:model:1');
    await engine.upsertChunks('partial', [
      { chunk_index: 0, chunk_text: 'fghij', chunk_source: 'compiled_truth', token_count: 4 },
      { chunk_index: 1, chunk_text: 'not embedded', chunk_source: 'compiled_truth', token_count: 4 },
    ]);

    const plan = await planEmbeddingMigration(engine, {
      to: 'openai:text-embedding-3-small', dim: colDim,
    });
    const n = await reconcilePageSignatures(engine, plan);
    expect(n).toBe(1); // 'done' only

    const sig = `openai:text-embedding-3-small:${colDim}`;
    const rows = await engine.executeRaw<{ slug: string; embedding_signature: string | null }>(
      `SELECT slug, embedding_signature FROM pages WHERE slug IN ('done','partial') ORDER BY slug`,
    );
    expect(rows.find(r => r.slug === 'done')?.embedding_signature).toBe(sig);
    expect(rows.find(r => r.slug === 'partial')?.embedding_signature).toBe('old:model:1');
  });

  test('completeEmbeddingMigration clears the state marker and stamps completion', async () => {
    const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-small', dim: colDim });
    await applyEmbeddingMigration(engine, plan);
    await completeEmbeddingMigration(engine, plan);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    const done = JSON.parse((await engine.getConfig(MIGRATION_COMPLETED_KEY))!);
    expect(done.to_model).toBe('openai:text-embedding-3-small');
  });
});

describe('migrate_embeddings op contract', () => {
  const op = operations.find(o => o.name === 'migrate_embeddings')!;

  test('is admin + localOnly + mutating', () => {
    expect(op).toBeDefined();
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBe(true);
    expect(op.mutating).toBe(true);
  });

  test('remote callers are refused even if dispatch forgot the localOnly filter', async () => {
    await expect(
      op.handler({ engine, remote: true } as never, { to: 'openai:text-embedding-3-small' }),
    ).rejects.toThrow(/local-only/);
    // remote undefined (not strictly false) is ALSO refused — fail-closed.
    await expect(
      op.handler({ engine } as never, { to: 'openai:text-embedding-3-small' }),
    ).rejects.toThrow(/local-only/);
  });

  test('without yes=true it returns the plan only (no mutation)', async () => {
    const res = await op.handler(
      { engine, remote: false } as never,
      { to: 'openai:text-embedding-3-small', dim: colDim },
    ) as { status: string; plan: { to_model: string } };
    expect(res.status).toBe('needs_confirmation');
    expect(res.plan.to_model).toBe('openai:text-embedding-3-small');
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
  });

  test('signature helper matches currentEmbeddingSignature shape', () => {
    expect(migrationSignature('openai:text-embedding-3-small', 1536))
      .toBe('openai:text-embedding-3-small:1536');
  });
});
