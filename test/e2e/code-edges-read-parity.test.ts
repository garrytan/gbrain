/**
 * D7 — code-edge READ parity: getCallersOf / getCalleesOf / getEdgesByChunk.
 *
 * The two engine modules (src/core/postgres-engine/code-edges.ts vs
 * src/core/pglite-engine/code-edges.ts) build the UNION-ALL read differently:
 * postgres.js sql`` fragments + bound source filter vs string-composed SQL
 * with an escaped-literal source filter. The write side also differs
 * ($N::text::jsonb vs $N::jsonb for edge_metadata — the #2339 double-encode
 * class only real Postgres can surface). This suite seeds identical chunk
 * graphs into both engines and pins that every read returns the same
 * CodeEdgeResult shapes: numeric id types, resolved flags, parsed
 * edge_metadata objects.
 *
 * Reality pins (spec adjusted to code):
 *   - Serial chunk/edge ids DIVERGE across engines (the shared Postgres DB's
 *     sequences advanced in earlier suites; PGLite starts fresh). Parity
 *     compares id-NORMALIZED shapes (ids mapped back to fixture names) plus
 *     `typeof === 'number'` type pins — never absolute ids.
 *   - LIMIT without ORDER BY returns an unspecified subset: the limit-clamp
 *     assertions are set-level (length + membership in the full set), not
 *     positional.
 *   - Omitting sourceId behaves like allSources on BOTH engines (the scope
 *     filter only engages when sourceId is set and allSources is falsy).
 *
 * Gated by DATABASE_URL — skips gracefully without a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodeEdgeInput, CodeEdgeResult } from '../../src/core/types.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

/** Per-engine fixture: chunk ids keyed by role name. */
interface CeFixture {
  main: number;
  helper: number;
  lib: number;
  alt: number;
  /** reverse map id → role name, for shape normalization */
  rev: Map<number, string>;
  /** addCodeEdges return counts: [firstInsert, duplicateReplay] */
  insertCounts: [number, number];
}

async function chunkIdsFor(eng: BrainEngine, slug: string, sourceId: string): Promise<number[]> {
  const rows = await eng.executeRaw<{ id: number | string; chunk_index: number }>(
    `SELECT c.id, c.chunk_index
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE p.slug = $1 AND p.source_id = $2
      ORDER BY c.chunk_index ASC`,
    [slug, sourceId],
  );
  return rows.map((r) => Number(r.id));
}

async function seedCodeEdges(eng: BrainEngine): Promise<CeFixture> {
  await eng.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('ce-alt', 'ce-alt', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );

  await eng.putPage('code/ce-main', { type: 'note', title: 'ce main', compiled_truth: 'main module', timeline: '' });
  await eng.upsertChunks('code/ce-main', [
    { chunk_index: 0, chunk_text: 'function main() { target(); }', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'function helper() { target(); }', chunk_source: 'compiled_truth' },
  ]);
  await eng.putPage('code/ce-lib', { type: 'note', title: 'ce lib', compiled_truth: 'lib module', timeline: '' });
  await eng.upsertChunks('code/ce-lib', [
    { chunk_index: 0, chunk_text: 'export function target() {}', chunk_source: 'compiled_truth' },
  ]);
  await eng.putPage('code/ce-alt', { type: 'note', title: 'ce alt', compiled_truth: 'alt module', timeline: '' }, { sourceId: 'ce-alt' });
  await eng.upsertChunks('code/ce-alt', [
    { chunk_index: 0, chunk_text: 'function altcaller() { target(); }', chunk_source: 'compiled_truth' },
  ], { sourceId: 'ce-alt' });

  const [main, helper] = await chunkIdsFor(eng, 'code/ce-main', 'default');
  const [lib] = await chunkIdsFor(eng, 'code/ce-lib', 'default');
  const [alt] = await chunkIdsFor(eng, 'code/ce-alt', 'ce-alt');

  const edges: CodeEdgeInput[] = [
    // Resolved (code_edges_chunk) — nested metadata exercises the jsonb bind.
    {
      from_chunk_id: main, to_chunk_id: lib,
      from_symbol_qualified: 'cep.main', to_symbol_qualified: 'cep.target',
      edge_type: 'calls', edge_metadata: { line: 12, col: 3 }, source_id: 'default',
    },
    {
      from_chunk_id: helper, to_chunk_id: lib,
      from_symbol_qualified: 'cep.helper', to_symbol_qualified: 'cep.target',
      edge_type: 'calls', edge_metadata: { line: 40 }, source_id: 'default',
    },
    // Unresolved (code_edges_symbol): no to_chunk_id.
    {
      from_chunk_id: main,
      from_symbol_qualified: 'cep.main', to_symbol_qualified: 'cep.target',
      edge_type: 'imports', edge_metadata: {}, source_id: 'default',
    },
    // Foreign-source resolved edge (self-edge keeps the fixture to one chunk).
    {
      from_chunk_id: alt, to_chunk_id: alt,
      from_symbol_qualified: 'cep.altcaller', to_symbol_qualified: 'cep.target',
      edge_type: 'calls', edge_metadata: { line: 7 }, source_id: 'ce-alt',
    },
  ];
  const first = await eng.addCodeEdges(edges);
  // Idempotency parity: full replay conflicts away on both engines.
  const replay = await eng.addCodeEdges(edges);

  const rev = new Map<number, string>([[main, 'main'], [helper, 'helper'], [lib, 'lib'], [alt, 'alt']]);
  return { main, helper, lib, alt, rev, insertCounts: [first, replay] };
}

/** Id-normalized, order-insensitive shape of a CodeEdgeResult array. */
function shape(rows: CodeEdgeResult[], fx: CeFixture): string[] {
  return rows
    .map((r) => [
      fx.rev.get(r.from_chunk_id) ?? `?${r.from_chunk_id}`,
      r.to_chunk_id == null ? 'null' : fx.rev.get(r.to_chunk_id) ?? `?${r.to_chunk_id}`,
      r.from_symbol_qualified,
      r.to_symbol_qualified,
      r.edge_type,
      JSON.stringify(r.edge_metadata, Object.keys(r.edge_metadata ?? {}).sort()),
      r.source_id ?? 'null',
      String(r.resolved),
    ].join('|'))
    .sort();
}

describeBoth('Engine parity — code-edge reads (D7)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;
  let pgFx: CeFixture;
  let pgliteFx: CeFixture;

  beforeAll(async () => {
    pgEngine = await setupDB();
    pgFx = await seedCodeEdges(pgEngine);
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    pgliteFx = await seedCodeEdges(pgliteEngine);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('addCodeEdges: identical insert counts, identical ON CONFLICT replay (resolved + unresolved split)', () => {
    expect(pgFx.insertCounts).toEqual([4, 0]);
    expect(pgliteFx.insertCounts).toEqual([4, 0]);
  });

  test('getCallersOf: scoped call returns identical rows; parsed metadata; numeric id types', async () => {
    const pg = await pgEngine.getCallersOf('cep.target', { sourceId: 'default' });
    const pglite = await pgliteEngine.getCallersOf('cep.target', { sourceId: 'default' });

    expect(shape(pg, pgFx)).toEqual(shape(pglite, pgliteFx));
    expect(shape(pg, pgFx)).toEqual([
      'helper|lib|cep.helper|cep.target|calls|{"line":40}|default|true',
      'main|lib|cep.main|cep.target|calls|{"col":3,"line":12}|default|true',
      'main|null|cep.main|cep.target|imports|{}|default|false',
    ].sort());

    for (const [rows, fx] of [[pg, pgFx], [pglite, pgliteFx]] as const) {
      const resolved = rows.find((r) => r.edge_type === 'calls' && r.from_chunk_id === fx.main)!;
      // Numeric id types — never bigint-as-string, never stringified fk ids.
      expect(typeof resolved.id).toBe('number');
      expect(typeof resolved.from_chunk_id).toBe('number');
      expect(typeof resolved.to_chunk_id).toBe('number');
      expect(resolved.resolved).toBe(true);
      // edge_metadata is a PARSED object (a #2339 double-encode would read
      // back a string scalar here).
      expect(resolved.edge_metadata).toEqual({ line: 12, col: 3 });
      const unresolved = rows.find((r) => r.edge_type === 'imports')!;
      expect(unresolved.resolved).toBe(false);
      expect(unresolved.to_chunk_id).toBeNull();
      expect(unresolved.edge_metadata).toEqual({});
    }
  });

  test('getCallersOf: allSources reaches the foreign source; omitted sourceId behaves the same (pinned reality)', async () => {
    const pgAll = await pgEngine.getCallersOf('cep.target', { allSources: true });
    const pgliteAll = await pgliteEngine.getCallersOf('cep.target', { allSources: true });
    expect(shape(pgAll, pgFx)).toEqual(shape(pgliteAll, pgliteFx));
    expect(pgAll.length).toBe(4);
    expect(pgAll.some((r) => r.source_id === 'ce-alt')).toBe(true);
    expect(pgliteAll.some((r) => r.source_id === 'ce-alt')).toBe(true);

    // Reality pin: no sourceId + no allSources → unscoped on both engines.
    const pgUnscoped = await pgEngine.getCallersOf('cep.target');
    const pgliteUnscoped = await pgliteEngine.getCallersOf('cep.target');
    expect(shape(pgUnscoped, pgFx)).toEqual(shape(pgAll, pgFx));
    expect(shape(pgliteUnscoped, pgliteFx)).toEqual(shape(pgliteAll, pgliteFx));
  });

  test('getCalleesOf: identical rows for a from-symbol across both tables', async () => {
    const pg = await pgEngine.getCalleesOf('cep.main', { sourceId: 'default' });
    const pglite = await pgliteEngine.getCalleesOf('cep.main', { sourceId: 'default' });
    expect(shape(pg, pgFx)).toEqual(shape(pglite, pgliteFx));
    expect(shape(pg, pgFx)).toEqual([
      'main|lib|cep.main|cep.target|calls|{"col":3,"line":12}|default|true',
      'main|null|cep.main|cep.target|imports|{}|default|false',
    ].sort());
  });

  test('getEdgesByChunk: direction in/out/both + edgeType filter identical', async () => {
    // in → only resolved edges INTO the chunk (symbol rows have no inbound arm).
    const pgIn = await pgEngine.getEdgesByChunk(pgFx.lib, { direction: 'in' });
    const pgliteIn = await pgliteEngine.getEdgesByChunk(pgliteFx.lib, { direction: 'in' });
    expect(shape(pgIn, pgFx)).toEqual(shape(pgliteIn, pgliteFx));
    expect(pgIn.length).toBe(2);
    expect(pgIn.every((r) => r.resolved)).toBe(true);

    // out → resolved + unresolved rows FROM the chunk.
    const pgOut = await pgEngine.getEdgesByChunk(pgFx.main, { direction: 'out' });
    const pgliteOut = await pgliteEngine.getEdgesByChunk(pgliteFx.main, { direction: 'out' });
    expect(shape(pgOut, pgFx)).toEqual(shape(pgliteOut, pgliteFx));
    expect(shape(pgOut, pgFx)).toEqual([
      'main|lib|cep.main|cep.target|calls|{"col":3,"line":12}|default|true',
      'main|null|cep.main|cep.target|imports|{}|default|false',
    ].sort());

    // both on a sink chunk == its inbound set (no outgoing, no symbol rows).
    const pgBoth = await pgEngine.getEdgesByChunk(pgFx.lib, { direction: 'both' });
    const pgliteBoth = await pgliteEngine.getEdgesByChunk(pgliteFx.lib, { direction: 'both' });
    expect(shape(pgBoth, pgFx)).toEqual(shape(pgliteBoth, pgliteFx));
    expect(shape(pgBoth, pgFx)).toEqual(shape(pgIn, pgFx));

    // edgeType filter drops the unresolved 'imports' row identically.
    const pgTyped = await pgEngine.getEdgesByChunk(pgFx.main, { direction: 'out', edgeType: 'calls' });
    const pgliteTyped = await pgliteEngine.getEdgesByChunk(pgliteFx.main, { direction: 'out', edgeType: 'calls' });
    expect(shape(pgTyped, pgFx)).toEqual(shape(pgliteTyped, pgliteFx));
    expect(pgTyped.length).toBe(1);
    expect(pgTyped[0].edge_type).toBe('calls');
  });

  test('limit clamp: both engines return exactly N rows, each from the full set (LIMIT has no ORDER BY — set-level pin)', async () => {
    const fullPg = shape(await pgEngine.getCallersOf('cep.target', { allSources: true }), pgFx);
    const fullPglite = shape(await pgliteEngine.getCallersOf('cep.target', { allSources: true }), pgliteFx);

    const pgClamped = await pgEngine.getCallersOf('cep.target', { allSources: true, limit: 2 });
    const pgliteClamped = await pgliteEngine.getCallersOf('cep.target', { allSources: true, limit: 2 });
    expect(pgClamped.length).toBe(2);
    expect(pgliteClamped.length).toBe(2);
    for (const s of shape(pgClamped, pgFx)) expect(fullPg).toContain(s);
    for (const s of shape(pgliteClamped, pgliteFx)) expect(fullPglite).toContain(s);

    // getEdgesByChunk clamp too (its default is 50, cap 200).
    const pgOne = await pgEngine.getEdgesByChunk(pgFx.lib, { direction: 'in', limit: 1 });
    const pgliteOne = await pgliteEngine.getEdgesByChunk(pgliteFx.lib, { direction: 'in', limit: 1 });
    expect(pgOne.length).toBe(1);
    expect(pgliteOne.length).toBe(1);
  });
});
