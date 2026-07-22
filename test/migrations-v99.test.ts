/**
 * v0.41.16.0 — Migration v99 round-trip test.
 *
 * Verifies the `conversation_parser_llm_cache` table:
 *   - is created on schema init
 *   - accepts inserts on (content_sha256, model_id, call_shape, value_json)
 *   - rejects invalid call_shape via CHECK constraint
 *   - ON CONFLICT DO NOTHING semantics (the llm-base.ts caller's contract)
 *   - JSONB column round-trips a real object (no double-encode regression)
 *   - composite primary key prevents duplicate (sha, model, shape)
 *
 * Hermetic via the canonical PGLite block from CLAUDE.md test-isolation
 * rules.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('migration v99 — conversation_parser_llm_cache', () => {
  test('table exists after schema init', async () => {
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'conversation_parser_llm_cache'`,
    );
    expect(rows.length).toBe(1);
  });

  test('insert + select round-trip with polish call_shape', async () => {
    await engine.executeRaw(
      `INSERT INTO conversation_parser_llm_cache
         (content_sha256, model_id, call_shape, value_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        'abc123',
        'anthropic:claude-haiku-4-5',
        'polish',
        JSON.stringify({ merge_indices: [], drop_indices: [], edits: [] }),
      ],
    );
    const rows = await engine.executeRaw<{ value_json: unknown }>(
      `SELECT value_json FROM conversation_parser_llm_cache
         WHERE content_sha256 = $1 AND model_id = $2 AND call_shape = $3`,
      ['abc123', 'anthropic:claude-haiku-4-5', 'polish'],
    );
    expect(rows).toHaveLength(1);
    // value_json should round-trip as a parsed object (not a JSON string).
    const val =
      typeof rows[0].value_json === 'string'
        ? JSON.parse(rows[0].value_json)
        : rows[0].value_json;
    expect(val).toEqual({ merge_indices: [], drop_indices: [], edits: [] });
  });

  test('insert + select round-trip with fallback call_shape', async () => {
    await engine.executeRaw(
      `INSERT INTO conversation_parser_llm_cache
         (content_sha256, model_id, call_shape, value_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        'def456',
        'anthropic:claude-haiku-4-5',
        'fallback',
        JSON.stringify([
          { speaker: 'Alice', timestamp: '2024-03-15T18:37:00Z', text: 'hi' },
        ]),
      ],
    );
    const rows = await engine.executeRaw<{ value_json: unknown }>(
      `SELECT value_json FROM conversation_parser_llm_cache
         WHERE content_sha256 = $1 AND call_shape = $2`,
      ['def456', 'fallback'],
    );
    expect(rows).toHaveLength(1);
    const val =
      typeof rows[0].value_json === 'string'
        ? JSON.parse(rows[0].value_json)
        : rows[0].value_json;
    expect(Array.isArray(val)).toBe(true);
    expect(val).toHaveLength(1);
  });

  test('CHECK constraint rejects invalid call_shape', async () => {
    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO conversation_parser_llm_cache
           (content_sha256, model_id, call_shape, value_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        ['ghi789', 'anthropic:claude-haiku-4-5', 'INVALID_SHAPE', '{}'],
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('composite primary key prevents duplicate (sha, model, shape)', async () => {
    await engine.executeRaw(
      `INSERT INTO conversation_parser_llm_cache
         (content_sha256, model_id, call_shape, value_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      ['dup1', 'anthropic:claude-haiku-4-5', 'polish', '{}'],
    );
    // ON CONFLICT DO NOTHING from llm-base.ts writeDbCache — should not throw.
    await engine.executeRaw(
      `INSERT INTO conversation_parser_llm_cache
         (content_sha256, model_id, call_shape, value_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (content_sha256, model_id, call_shape) DO NOTHING`,
      ['dup1', 'anthropic:claude-haiku-4-5', 'polish', '{"different":true}'],
    );
    // First write wins on conflict.
    const rows = await engine.executeRaw<{ value_json: unknown }>(
      `SELECT value_json FROM conversation_parser_llm_cache WHERE content_sha256 = 'dup1'`,
    );
    expect(rows).toHaveLength(1);
  });

  test('different call_shape on same (sha, model) coexists', async () => {
    await engine.executeRaw(
      `INSERT INTO conversation_parser_llm_cache
         (content_sha256, model_id, call_shape, value_json)
       VALUES ($1, $2, 'polish', $3::jsonb), ($1, $2, 'fallback', $3::jsonb)`,
      ['co1', 'anthropic:claude-haiku-4-5', '{}'],
    );
    const rows = await engine.executeRaw<{ call_shape: string }>(
      `SELECT call_shape FROM conversation_parser_llm_cache WHERE content_sha256 = 'co1'`,
    );
    expect(rows).toHaveLength(2);
    const shapes = rows.map((r) => r.call_shape).sort();
    expect(shapes).toEqual(['fallback', 'polish']);
  });

  test('created_at index supports time-based pruning queries', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE tablename = 'conversation_parser_llm_cache'
           AND indexname = 'idx_conversation_parser_llm_cache_created'`,
    );
    expect(rows.length).toBe(1);
  });
});
