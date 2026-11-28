/**
 * GST-4006 / #9817 (gbrain-evals#671): a filtered joined vector search turns materialization off only when it has a
 * date bound (alone or with a type filter) and the brain holds at least DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS chunks by
 * the planner's estimate. Every other search keeps the planner's plan, and #10507's enable_sort setting and exact
 * fallback routing still follow the index walk alone.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { brainChunkEstimateLoader, buildVectorSearchStatement, DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS, HNSW_ORDERED_POOL_SETTINGS, INDEX_WALK_SETTINGS, JOINED_STATEMENT_SETTINGS } from '../../src/core/search/vector-statement.ts';
import { vectorAttemptFlags, vectorScanSettings } from '../../src/core/search/vector-settings.ts';
import type { VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const indexedColumn = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-large' };
const build = (opts: Partial<SearchOpts>, brainChunks?: number, scope?: { share: number; chunks?: number }) =>
  buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1, 0, 0]), limit: 20, offset: 0, opts: { embeddingColumn: indexedColumn, ...opts }, brainChunks, scope });
const ABOVE = DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS, BELOW = DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS - 1;
const pooled: Pick<VectorPoolAttempt, 'exact' | 'indexWalk' | 'scopeScan'> = { exact: false };
/** The planner flags one attempt sets, as the Postgres engine computes them. */
const flagsFor = (stmt: ReturnType<typeof build>, attempt: Pick<VectorPoolAttempt, 'exact' | 'indexWalk' | 'scopeScan'>) => {
  const { walk, joined, materialOff } = vectorAttemptFlags(stmt, attempt);
  const settings = vectorScanSettings(true, 100, 20_000, undefined, undefined, walk ? stmt.indexWalkOverfetch : undefined, materialOff, joined);
  const read = (name: string): string | undefined => settings[name];
  return { enable_material: read('enable_material'), enable_sort: read('enable_sort') };
};

describe('#9817 the date-bound materialization rule', () => {
  test('375k chunks is the published threshold', () => {
    expect(DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS).toBe(375_000);
    expect(JOINED_STATEMENT_SETTINGS).toEqual({ enable_material: 'off' });
  });

  test('flips only for a date bound, alone or with a type filter, at or above the threshold', () => {
    const cases: Array<[Partial<SearchOpts>, number | undefined, boolean]> = [
      [{ afterDate: '2026-01-01' }, ABOVE, true],
      [{ beforeDate: '2026-01-01' }, ABOVE, true],
      [{ afterDate: '2025-01-01', beforeDate: '2026-01-01' }, ABOVE, true],
      [{ afterDate: '2026-01-01', type: 'meeting' }, ABOVE, true],
      [{ afterDate: '2026-01-01', types: ['meeting', 'person'] }, ABOVE, true],
      [{ afterDate: '2026-01-01', type: 'meeting' }, 2_000_000, true],
      [{ afterDate: '2026-01-01' }, BELOW, false],
      [{ afterDate: '2026-01-01', type: 'meeting' }, BELOW, false],
      [{ afterDate: '2026-01-01' }, undefined, false],
      [{ afterDate: '2026-01-01' }, -1, false],
      [{ type: 'meeting' }, ABOVE, false],
      [{ types: ['meeting'] }, ABOVE, false],
      [{ where: { status: ['open'] } }, ABOVE, false],
      [{ afterDate: '2026-01-01', where: { status: ['open'] } }, ABOVE, false],
      [{ afterDate: '2026-01-01', exclude_slugs: ['notes/a'] }, ABOVE, false],
      [{ afterDate: '2026-01-01', language: 'typescript' }, ABOVE, false],
      [{ afterDate: '2026-01-01', symbolKind: 'function' }, ABOVE, false],
      [{ afterDate: '2026-01-01', detail: 'low' }, ABOVE, false],
      [{}, ABOVE, false],
      [{ afterDate: '2026-01-01', vectorLegacyGuard: true }, ABOVE, false],
    ];
    for (const [opts, chunks, expected] of cases) expect([opts, chunks, build(opts, chunks).dateFilterMaterialOff]).toEqual([opts, chunks, expected]);
  });

  test('a source scope keeps the rule only while it covers most of the brain', () => {
    expect(build({ afterDate: '2026-01-01', sourceId: 'source-a' }, ABOVE, { share: 0.9 }).dateFilterMaterialOff).toBe(true);
    expect(build({ afterDate: '2026-01-01', sourceId: 'source-a' }, ABOVE, { share: 0.01 }).dateFilterMaterialOff).toBe(false);
  });

  test('a non-indexed column (no relaxed statement) never flips', () => {
    const wide = buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1]), limit: 20, offset: 0, opts: { embeddingColumn: { ...indexedColumn, dimensions: 3072 }, afterDate: '2026-01-01' }, brainChunks: ABOVE });
    expect(wide.relaxed).toBe(false);
    expect(wide.dateFilterMaterialOff).toBe(false);
  });

  test('the brain size changes no SQL: only the attempt settings move', () => {
    for (const opts of [{ afterDate: '2026-01-01' }, { afterDate: '2026-01-01', type: 'meeting' }]) {
      const above = build(opts, ABOVE), below = build(opts, BELOW);
      expect(above.sql).toBe(below.sql);
      expect(above.exactSql).toBe(below.exactSql);
      expect(above.indexWalkSql).toBeUndefined();
    }
  });
});

describe('#9817 planner flags per attempt', () => {
  test('a date-bounded search above the threshold turns materialization off on its pooled attempts and nothing else', () => {
    for (const opts of [{ afterDate: '2026-01-01' }, { beforeDate: '2026-01-01', type: 'meeting' }]) {
      const stmt = build(opts, ABOVE);
      expect(flagsFor(stmt, pooled)).toEqual({ enable_material: 'off', enable_sort: undefined });
      expect(flagsFor(stmt, { exact: true })).toEqual({ enable_material: undefined, enable_sort: undefined });
      expect(vectorAttemptFlags(stmt, pooled).joined).toBe(false);
    }
  });

  test('below the threshold, without a date bound, or with only a type filter, the pooled attempt sets neither flag', () => {
    for (const stmt of [build({ afterDate: '2026-01-01' }, BELOW), build({ afterDate: '2026-01-01', type: 'meeting' }, BELOW), build({ type: 'meeting' }, ABOVE), build({ types: ['person'] }, ABOVE)]) {
      expect(flagsFor(stmt, pooled)).toEqual({ enable_material: undefined, enable_sort: undefined });
      expect(flagsFor(stmt, { exact: true })).toEqual({ enable_material: undefined, enable_sort: undefined });
    }
  });

  test('a date-bounded small source scope keeps the planner\'s plan on its scope scan and its pooled attempts', () => {
    const stmt = build({ afterDate: '2026-01-01', sourceId: 'side' }, ABOVE, { share: 0.02, chunks: 5_000 });
    expect(stmt.scopeScanSql).toBeDefined();
    expect(flagsFor(stmt, { exact: false, scopeScan: true })).toEqual({ enable_material: undefined, enable_sort: undefined });
    expect(flagsFor(stmt, pooled)).toEqual({ enable_material: undefined, enable_sort: undefined });
  });

  test('#10507 unchanged: the joined attempt behind an index walk keeps both flags, the walk keeps its sort setting, exact keeps neither', () => {
    for (const chunks of [undefined, BELOW, ABOVE]) {
      const stmt = build({}, chunks);
      expect(stmt.indexWalkSql).toBeDefined();
      expect(flagsFor(stmt, pooled)).toEqual({ enable_material: 'off', enable_sort: 'off' });
      expect(vectorAttemptFlags(stmt, pooled)).toEqual({ walk: false, joined: true, materialOff: true });
      expect(flagsFor(stmt, { exact: false, indexWalk: true })).toEqual({ enable_material: undefined, enable_sort: INDEX_WALK_SETTINGS.enable_sort });
      expect(flagsFor(stmt, { exact: true })).toEqual({ enable_material: undefined, enable_sort: undefined });
    }
    expect(HNSW_ORDERED_POOL_SETTINGS).toEqual({ enable_sort: 'off' });
  });
});

describe('#9817 the brain chunk estimate', () => {
  test('reads the catalog estimate at most once a minute and keeps the last value when a later read fails', async () => {
    let clock = 1_000, reads = 0, fail = false;
    const now = spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const read = async () => { reads++; if (fail) throw new Error('down'); return [{ chunks: 400_000 }]; };
      const estimate = brainChunkEstimateLoader();
      expect(await estimate(read)).toBe(400_000);
      clock += 59_000;
      expect(await estimate(read)).toBe(400_000);
      expect(reads).toBe(1);
      clock += 2_000; fail = true;
      expect(await estimate(read)).toBe(400_000);
      expect(reads).toBe(2);
      expect(await brainChunkEstimateLoader()(async () => { throw new Error('down'); })).toBeUndefined();
    } finally { now.mockRestore(); }
  });

  test('a refresh runs the read its caller passes, so a transaction reads on its own connection', async () => {
    let clock = 1_000;
    const now = spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const calls: string[] = [];
      const estimate = brainChunkEstimateLoader();
      expect(await estimate(async () => { calls.push('pool'); return [{ chunks: 400_000 }]; })).toBe(400_000);
      clock += 61_000;
      expect(await estimate(async () => { calls.push('transaction'); return [{ chunks: 500_000 }]; })).toBe(500_000);
      expect(calls).toEqual(['pool', 'transaction']);
      clock += 61_000;
      let release!: () => void;
      const stuck = estimate(() => new Promise(resolve => { release = () => resolve([{ chunks: 600_000 }]); }));
      expect(await estimate(async () => { calls.push('second'); return [{ chunks: 1 }]; })).toBe(500_000);
      expect(calls).toEqual(['pool', 'transaction']);
      release();
      expect(await stuck).toBe(600_000);
    } finally { now.mockRestore(); }
  });
});
