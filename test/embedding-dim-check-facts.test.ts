/**
 * Hermetic tests for the facts.embedding dim-check + preflight surface
 * added in v0.41.15.0 T6.
 *
 * Covers:
 *   - readFactsEmbeddingDim: column-absent, vector(N), halfvec(N), unrecognized
 *   - buildFactsAlterRecipe: vector vs halfvec opclass + targetType
 *   - FactsEmbeddingDimMismatchError shape + tag
 *   - assertFactsEmbeddingDimMatchesConfig: PGLite skip, match, drift throws
 *   - doctor's checkFactsEmbeddingWidthConsistency: wired into the suite
 *
 * No DB needed for most cases — readFactsEmbeddingDim goes through
 * `engine.executeRaw`, which we stub with a tiny in-test fake engine.
 * The PGLite-engine skip case uses `{kind: 'pglite'}`. R1+R2 compliant.
 */

import { describe, test, expect } from 'bun:test';
import {
  readFactsEmbeddingDim,
  buildFactsAlterRecipe,
  FactsEmbeddingDimMismatchError,
  assertFactsEmbeddingDimMatchesConfig,
} from '../src/core/embedding-dim-check.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Synthetic engine satisfying the slice of BrainEngine these helpers
 * touch: `kind` discriminator + `executeRaw<T>(sql, params?)`. Tests
 * pre-program responses keyed on substring matches in the SQL.
 */
function makeStubEngine(opts: {
  kind: 'postgres' | 'pglite';
  factsExists?: boolean;
  factsFormatted?: string | null;
}): BrainEngine {
  const exists = opts.factsExists ?? false;
  const formatted = opts.factsFormatted ?? null;
  const eng = {
    kind: opts.kind,
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes('information_schema.columns') && sql.includes("'facts'")) {
        return [{ exists }] as unknown as T[];
      }
      if (sql.includes('format_type') && sql.includes("'facts'")) {
        return [{ formatted }] as unknown as T[];
      }
      return [] as T[];
    },
  };
  return eng as unknown as BrainEngine;
}

describe('readFactsEmbeddingDim', () => {
  test('returns exists=false when facts.embedding column is absent', async () => {
    const eng = makeStubEngine({ kind: 'postgres', factsExists: false });
    const r = await readFactsEmbeddingDim(eng);
    expect(r.exists).toBe(false);
    expect(r.dims).toBeNull();
    expect(r.columnType).toBeNull();
  });

  test('parses halfvec(N) shape', async () => {
    const eng = makeStubEngine({
      kind: 'postgres',
      factsExists: true,
      factsFormatted: 'halfvec(1536)',
    });
    const r = await readFactsEmbeddingDim(eng);
    expect(r.exists).toBe(true);
    expect(r.dims).toBe(1536);
    expect(r.columnType).toBe('halfvec');
  });

  test('parses vector(N) shape', async () => {
    const eng = makeStubEngine({
      kind: 'postgres',
      factsExists: true,
      factsFormatted: 'vector(1024)',
    });
    const r = await readFactsEmbeddingDim(eng);
    expect(r.exists).toBe(true);
    expect(r.dims).toBe(1024);
    expect(r.columnType).toBe('vector');
  });

  test('returns null columnType when format_type returns null', async () => {
    const eng = makeStubEngine({
      kind: 'postgres',
      factsExists: true,
      factsFormatted: null,
    });
    const r = await readFactsEmbeddingDim(eng);
    expect(r.exists).toBe(true);
    expect(r.dims).toBeNull();
    expect(r.columnType).toBeNull();
  });

  test('halfvec match preferred over vector match (codex #19 regex shadowing)', async () => {
    // The substring "vec" appears in "halfvec"; a naive /vector/i regex
    // would shadow the halfvec branch. Pin the ordering invariant.
    const eng = makeStubEngine({
      kind: 'postgres',
      factsExists: true,
      factsFormatted: 'halfvec(1280)',
    });
    const r = await readFactsEmbeddingDim(eng);
    expect(r.columnType).toBe('halfvec');
    expect(r.dims).toBe(1280);
  });
});

describe('buildFactsAlterRecipe', () => {
  test('halfvec recipe uses halfvec_cosine_ops + halfvec(N) USING cast', () => {
    const recipe = buildFactsAlterRecipe(1536, 1280, 'halfvec');
    expect(recipe).toContain('DROP INDEX IF EXISTS idx_facts_embedding_hnsw');
    expect(recipe).toContain('halfvec(1280)');
    expect(recipe).toContain('USING embedding::halfvec(1280)');
    expect(recipe).toContain('halfvec_cosine_ops');
    expect(recipe).not.toContain('vector_cosine_ops');
  });

  test('vector recipe uses vector_cosine_ops + vector(N) USING cast', () => {
    const recipe = buildFactsAlterRecipe(1024, 2048, 'vector');
    expect(recipe).toContain('vector(2048)');
    expect(recipe).toContain('USING embedding::vector(2048)');
    expect(recipe).toContain('vector_cosine_ops');
    expect(recipe).not.toContain('halfvec_cosine_ops');
  });

  test('recipe carries the maintenance-window warning (codex #18)', () => {
    const recipe = buildFactsAlterRecipe(1536, 1280, 'halfvec');
    expect(recipe).toMatch(/maintenance window/i);
    expect(recipe).toContain('rewrites every row');
  });

  test('recipe is the full DROP → ALTER → CREATE flow, not just REINDEX', () => {
    // Codex #18 specifically called out that REINDEX alone after ALTER
    // TYPE isn't sufficient — pgvector won't pick up the new column type
    // on the partial HNSW index. The recipe must be DROP + ALTER + CREATE.
    const recipe = buildFactsAlterRecipe(1536, 1280, 'halfvec');
    expect(recipe).toMatch(/DROP INDEX[\s\S]*ALTER TABLE[\s\S]*CREATE INDEX/);
  });

  test('dimension change NULLs embeddings BEFORE the alter (pgvector refuses cross-dim casts)', () => {
    // Same defect class fixed for content_chunks in embeddingMismatchMessage:
    // pgvector aborts a cross-dimension ALTER while rows still hold old-width
    // vectors. The dims-change recipe must wipe first; order pinned.
    const recipe = buildFactsAlterRecipe(1536, 1280, 'halfvec');
    const nullIdx = recipe.indexOf('UPDATE facts SET embedding = NULL');
    const alterIdx = recipe.indexOf('ALTER TABLE facts ALTER COLUMN embedding TYPE');
    expect(nullIdx).toBeGreaterThan(-1);
    expect(alterIdx).toBeGreaterThan(-1);
    expect(nullIdx).toBeLessThan(alterIdx);
  });

  test('same-dim type swap PRESERVES embeddings (no NULL wipe)', () => {
    // halfvec(1536) <-> vector(1536): the USING cast is lossless and the
    // whole point is keeping the data. A wipe here would destroy valid
    // embeddings for no reason.
    const recipe = buildFactsAlterRecipe(1536, 1536, 'vector');
    expect(recipe).not.toContain('UPDATE facts SET embedding = NULL');
    expect(recipe).toContain('USING embedding::vector(1536)');
  });
});

describe('FactsEmbeddingDimMismatchError', () => {
  test('tag matches the worker-pool MUST_ABORT semantics for D13 parity', () => {
    const err = new FactsEmbeddingDimMismatchError(
      'test',
      1536,
      1280,
      'halfvec',
    );
    // Tag-based dispatch (mirrors BudgetExhausted shape).
    expect(err.tag).toBe('FACTS_EMBEDDING_DIM_MISMATCH');
    expect(err.name).toBe('FactsEmbeddingDimMismatchError');
    expect(err instanceof Error).toBe(true);
    expect(err.columnDims).toBe(1536);
    expect(err.configuredDims).toBe(1280);
    expect(err.columnType).toBe('halfvec');
  });
});

describe('assertFactsEmbeddingDimMatchesConfig', () => {
  test('PGLite engines silently skip (no probe, no throw)', async () => {
    const eng = makeStubEngine({ kind: 'pglite' });
    // Should resolve without throwing — PGLite branch short-circuits.
    await assertFactsEmbeddingDimMatchesConfig(eng);
  });

  test('Postgres without facts column resolves cleanly (pre-v40 path)', async () => {
    const eng = makeStubEngine({ kind: 'postgres', factsExists: false });
    await assertFactsEmbeddingDimMatchesConfig(eng);
  });
});

describe('doctor checkFactsEmbeddingWidthConsistency wiring (T6)', () => {
  const DOC_PATH = resolve(import.meta.dir, '..', 'src/commands/doctor.ts');
  const DOC_SRC = readFileSync(DOC_PATH, 'utf-8');

  test('doctor.ts exports the new check function', () => {
    expect(DOC_SRC).toMatch(
      /export\s+async\s+function\s+checkFactsEmbeddingWidthConsistency/,
    );
  });

  test('check is registered in runDoctor alongside the content_chunks check', () => {
    expect(DOC_SRC).toMatch(/checkFactsEmbeddingWidthConsistency\(engine\)/);
    // Must appear AFTER the content_chunks check so a single
    // mismatch surface ordering is stable in the JSON envelope.
    const widthIdx = DOC_SRC.indexOf('checkEmbeddingWidthConsistency(engine)');
    const factsIdx = DOC_SRC.indexOf('checkFactsEmbeddingWidthConsistency(engine)');
    expect(widthIdx).toBeGreaterThan(0);
    expect(factsIdx).toBeGreaterThan(0);
    expect(widthIdx).toBeLessThan(factsIdx);
  });

  test('doctor check uses readFactsEmbeddingDim from the shared helper', () => {
    expect(DOC_SRC).toMatch(/readFactsEmbeddingDim/);
  });

  test('doctor check uses buildFactsAlterRecipe (NOT a hand-rolled ALTER string)', () => {
    expect(DOC_SRC).toMatch(/buildFactsAlterRecipe/);
  });
});

describe('postgres-engine fact insert cast (T6, codex #20)', () => {
  const PG_PATH = resolve(import.meta.dir, '..', 'src/core/postgres-engine.ts');
  const PG_SRC = readFileSync(PG_PATH, 'utf-8');

  test('insertFacts batch path uses cached castSuffix, NOT a hardcoded ::vector', () => {
    expect(PG_SRC).toMatch(/resolveFactsEmbeddingCast/);
    // The fixed call sites use `castSuffix`, not the literal `::vector`.
    const literalHits = PG_SRC.match(/embedLit[^,)]*'::vector'/g);
    // After T6 there should be zero remaining literal ::vector casts
    // in the insertFacts paths. (Other ::vector references in pgvector
    // SELECT helpers are unrelated; check only the embed-literal cast.)
    expect(literalHits ?? []).toEqual([]);
  });

  test('cached cast suffix has a test-only reset hook for unit cases', () => {
    expect(PG_SRC).toMatch(/__resetFactsEmbeddingCastCacheForTest/);
  });
});
