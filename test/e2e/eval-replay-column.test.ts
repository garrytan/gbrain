/**
 * v0.36 (D16 / CDX-10) — eval_candidates.embedding_column round-trip.
 *
 * Pins:
 *   - logEvalCandidate persists `embedding_column` when set.
 *   - listEvalCandidates reads it back (SELECT * carries the new column).
 *   - Migration v67 applied: ALTER TABLE eval_candidates ADD COLUMN
 *     IF NOT EXISTS embedding_column TEXT.
 *   - Back-compat: rows inserted without embedding_column store NULL,
 *     and replay treats NULL as "use current default."
 *
 * The integration of replay with hybridSearch's column-override path is
 * tested via the embeddingColumn option being honored — we don't run
 * the full eval-replay CLI subcommand here because that brings in CLI
 * arg parsing + filesystem reading. Unit-level surface is sufficient
 * for the persist-and-read contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { EvalCandidateInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

const baseRow: Omit<EvalCandidateInput, 'embedding_column'> = {
  tool_name: 'query',
  query: 'test query',
  retrieved_slugs: ['docs/a', 'docs/b'],
  retrieved_chunk_ids: [1, 2],
  source_ids: ['default'],
  expand_enabled: true,
  detail: null,
  detail_resolved: 'medium',
  vector_enabled: true,
  expansion_applied: false,
  latency_ms: 42,
  remote: false,
  job_id: null,
  subagent_id: null,
};

describe('eval_candidates.embedding_column persistence (D16)', () => {
  test('migration v67 added embedding_column TEXT column', async () => {
    const rows = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'eval_candidates' AND column_name = 'embedding_column'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].column_name).toBe('embedding_column');
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('YES');
  });

  test('logEvalCandidate stores embedding_column value', async () => {
    const id = await engine.logEvalCandidate({
      ...baseRow,
      embedding_column: 'embedding_voyage',
    });
    const rows = await engine.executeRaw<{ embedding_column: string | null }>(
      `SELECT embedding_column FROM eval_candidates WHERE id = $1`,
      [id],
    );
    expect(rows[0].embedding_column).toBe('embedding_voyage');
  });

  test('listEvalCandidates reads embedding_column back (round-trip via SELECT *)', async () => {
    const id = await engine.logEvalCandidate({
      ...baseRow,
      query: 'list-readback test',
      embedding_column: 'embedding_ze',
    });
    const list = await engine.listEvalCandidates({ limit: 100 });
    const found = list.find(r => r.id === id);
    expect(found).toBeDefined();
    // Cast-through-unknown rowToEvalCandidate doesn't exist; SELECT *
    // carries `embedding_column` as a column with the same key name.
    expect((found as any).embedding_column).toBe('embedding_ze');
  });

  test('back-compat: missing embedding_column coalesces to NULL at insert', async () => {
    // Build a row WITHOUT embedding_column to mimic pre-v0.36 callers.
    const input: EvalCandidateInput = { ...baseRow, query: 'pre-v036 fixture' };
    expect(input.embedding_column).toBeUndefined();
    const id = await engine.logEvalCandidate(input);
    const rows = await engine.executeRaw<{ embedding_column: string | null }>(
      `SELECT embedding_column FROM eval_candidates WHERE id = $1`,
      [id],
    );
    expect(rows[0].embedding_column).toBeNull();
  });

  test('back-compat: explicit null persists as DB NULL (not the literal string "null")', async () => {
    const id = await engine.logEvalCandidate({
      ...baseRow,
      query: 'explicit-null fixture',
      embedding_column: null,
    });
    const rows = await engine.executeRaw<{ embedding_column: string | null }>(
      `SELECT embedding_column FROM eval_candidates WHERE id = $1`,
      [id],
    );
    expect(rows[0].embedding_column).toBeNull();
  });
});
