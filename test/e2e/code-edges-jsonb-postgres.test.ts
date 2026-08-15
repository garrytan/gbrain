/**
 * Postgres-only regression for addCodeEdges jsonb encoding (#2968).
 *
 * Bun SQL mis-encodes `::jsonb[]` array binds: each element arrives as a
 * double-encoded JSON string (jsonb_typeof = 'string'), not an object. The
 * symbol resolver's `edge_metadata || jsonb_build_object(...)` UPDATE then
 * concatenates onto a string scalar and produces a jsonb array, so
 * resolved_chunk_id never lands and code_callers/code_callees return nothing.
 *
 * PGLite cannot reproduce this class (its addCodeEdges always used per-row
 * placeholders), so this is DATABASE_URL-gated per the engine-parity
 * convention. Pins the per-row `$n::text::jsonb` shape: every inserted
 * edge_metadata must be jsonb_typeof = 'object' and round-trip its fields.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
let chunkA: number;
let chunkB: number;

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();

  await engine.putPage('src-a-ts', {
    type: 'code', page_kind: 'code',
    title: 'src/a.ts (typescript)',
    compiled_truth: 'export function run() { return helper(); }',
    timeline: '',
  });
  await engine.upsertChunks('src-a-ts', [{
    chunk_index: 0,
    chunk_text: 'export function run() { return helper(); }',
    chunk_source: 'compiled_truth',
    language: 'typescript',
    symbol_name: 'run',
    symbol_type: 'function',
    symbol_name_qualified: 'run',
  }]);

  await engine.putPage('src-b-ts', {
    type: 'code', page_kind: 'code',
    title: 'src/b.ts (typescript)',
    compiled_truth: 'export function helper() { return 1; }',
    timeline: '',
  });
  await engine.upsertChunks('src-b-ts', [{
    chunk_index: 0,
    chunk_text: 'export function helper() { return 1; }',
    chunk_source: 'compiled_truth',
    language: 'typescript',
    symbol_name: 'helper',
    symbol_type: 'function',
    symbol_name_qualified: 'helper',
  }]);

  chunkA = (await engine.getChunks('src-a-ts'))[0]!.id;
  chunkB = (await engine.getChunks('src-b-ts'))[0]!.id;
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

describeIfDB('addCodeEdges jsonb encoding — Postgres regression (#2968)', () => {
  test('resolved edges land as jsonb objects, not double-encoded strings', async () => {
    const inserted = await engine.addCodeEdges([{
      from_chunk_id: chunkA,
      to_chunk_id: chunkB,
      from_symbol_qualified: 'run',
      to_symbol_qualified: 'helper',
      edge_type: 'calls',
      edge_metadata: { line: 1, via: 'direct' },
    }]);
    expect(inserted).toBe(1);

    const rows = await engine.executeRaw<{ kind: string; line: string | null }>(
      `SELECT jsonb_typeof(edge_metadata) AS kind, edge_metadata->>'line' AS line
         FROM code_edges_chunk
        WHERE from_chunk_id = $1 AND to_chunk_id = $2 AND edge_type = 'calls'`,
      [chunkA, chunkB],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('object');
    expect(rows[0]!.line).toBe('1');
  });

  test('unresolved edges land as jsonb objects (empty metadata defaults to {})', async () => {
    const inserted = await engine.addCodeEdges([
      {
        from_chunk_id: chunkA,
        to_chunk_id: null,
        from_symbol_qualified: 'run',
        to_symbol_qualified: 'phantom',
        edge_type: 'calls',
        edge_metadata: { line: 2 },
      },
      {
        from_chunk_id: chunkA,
        to_chunk_id: null,
        from_symbol_qualified: 'run',
        to_symbol_qualified: 'ghost',
        edge_type: 'calls',
      },
    ]);
    expect(inserted).toBe(2);

    const rows = await engine.executeRaw<{ to_symbol_qualified: string; kind: string }>(
      `SELECT to_symbol_qualified, jsonb_typeof(edge_metadata) AS kind
         FROM code_edges_symbol
        WHERE from_chunk_id = $1`,
      [chunkA],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.kind).toBe('object');
    }
  });

  test('resolver-style || UPDATE keeps object shape (the corruption symptom)', async () => {
    // The production resolver runs `edge_metadata || jsonb_build_object(...)`.
    // On a double-encoded string scalar this yields a jsonb ARRAY and the
    // resolved_chunk_id key never becomes readable. Pin the healthy path.
    await engine.executeRaw(
      `UPDATE code_edges_symbol
          SET edge_metadata = edge_metadata || jsonb_build_object('resolved_chunk_id', $1::int)
        WHERE from_chunk_id = $2 AND to_symbol_qualified = 'phantom'`,
      [chunkB, chunkA],
    );
    const rows = await engine.executeRaw<{ kind: string; resolved: string | null }>(
      `SELECT jsonb_typeof(edge_metadata) AS kind,
              edge_metadata->>'resolved_chunk_id' AS resolved
         FROM code_edges_symbol
        WHERE from_chunk_id = $1 AND to_symbol_qualified = 'phantom'`,
      [chunkA],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('object');
    expect(rows[0]!.resolved).toBe(String(chunkB));
  });
});
