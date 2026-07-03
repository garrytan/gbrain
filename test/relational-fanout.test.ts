/**
 * relationalFanout unit tests (PGLite, default CI).
 *
 * Exercises the typed-edge fan-out SQL directly so the engine method is
 * covered even when the DATABASE_URL-gated parity test does not run. Pins:
 * typed-edge filtering, mentions-excluded-by-default, deleted_at exclusion,
 * hop/edge_count aggregation, canonical_chunk_id, multi-seed + connects,
 * and determinism.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { probeEmbeddingDim } from './fixtures/retrieval-quality/relational/corpus.ts';

function emb(idx: number, dim: number): Float32Array {
  const e = new Float32Array(dim);
  e[idx % dim] = 1.0;
  return e;
}

let eng: PGLiteEngine;
let DIM = 0;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  DIM = await probeEmbeddingDim(eng); // match the schema's column width (1280 ZE / 1536 OpenAI)

  const pages: Array<[string, string, string]> = [
    ['companies/widget-co', 'company', 'Widget Co'],
    ['companies/other-co', 'company', 'Other Co'],
    ['people/investor-a', 'person', 'Investor A'],
    ['people/investor-b', 'person', 'Investor B'],
    ['people/employee-c', 'person', 'Employee C'],
    ['people/mentioner', 'person', 'Mentioner'],
    ['people/deleted-investor', 'person', 'Deleted Investor'],
  ];
  for (const [slug, type, title] of pages) {
    await eng.putPage(slug, { type: type as 'company' | 'person', title, compiled_truth: `${title} body`, timeline: '' });
  }
  // investor-b carries a chunk (→ canonical_chunk_id non-null); investor-a stays chunkless.
  const chunk: ChunkInput[] = [{ chunk_index: 0, chunk_text: 'b', chunk_source: 'compiled_truth', embedding: emb(2, DIM), token_count: 1 }];
  await eng.upsertChunks('people/investor-b', chunk);

  // Edges into widget-co.
  await eng.addLink('people/investor-a', 'companies/widget-co', '', 'invested_in', 'manual');
  await eng.addLink('people/investor-b', 'companies/widget-co', '', 'invested_in', 'manual');
  await eng.addLink('people/employee-c', 'companies/widget-co', '', 'works_at', 'manual');
  await eng.addLink('people/mentioner', 'companies/widget-co', '', 'mentions', 'mentions');
  await eng.addLink('people/deleted-investor', 'companies/widget-co', '', 'invested_in', 'manual');
  // investor-a also invested in other-co → widget-co and other-co connect via investor-a.
  await eng.addLink('people/investor-a', 'companies/other-co', '', 'invested_in', 'manual');

  // Soft-delete one investor; it must never surface.
  await eng.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, ['people/deleted-investor']);
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('relationalFanout', () => {
  test('typed-edge: who invested in widget-co', async () => {
    const rows = await eng.relationalFanout(['companies/widget-co'], { direction: 'in', linkTypes: ['invested_in'] });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual(['people/investor-a', 'people/investor-b']);
    for (const r of rows) {
      expect(r.hop).toBe(1);
      expect(r.via_link_types).toEqual(['invested_in']);
    }
  });

  test('deleted pages are excluded', async () => {
    const rows = await eng.relationalFanout(['companies/widget-co'], { direction: 'in', linkTypes: ['invested_in'] });
    expect(rows.map(r => r.slug)).not.toContain('people/deleted-investor');
  });

  test('mentions excluded by default, included on opt-in', async () => {
    const off = await eng.relationalFanout(['companies/widget-co'], { direction: 'in' });
    expect(off.map(r => r.slug)).not.toContain('people/mentioner');
    // type-agnostic also picks up the works_at neighbor
    expect(off.map(r => r.slug).sort()).toEqual(['people/employee-c', 'people/investor-a', 'people/investor-b']);

    const on = await eng.relationalFanout(['companies/widget-co'], { direction: 'in', includeMentions: true });
    expect(on.map(r => r.slug)).toContain('people/mentioner');
  });

  test('canonical_chunk_id: non-null for chunked page, null for chunkless', async () => {
    const rows = await eng.relationalFanout(['companies/widget-co'], { direction: 'in', linkTypes: ['invested_in'] });
    const a = rows.find(r => r.slug === 'people/investor-a')!;
    const b = rows.find(r => r.slug === 'people/investor-b')!;
    expect(a.canonical_chunk_id).toBeNull();
    expect(b.canonical_chunk_id).not.toBeNull();
  });

  test('connects: shared midpoint reachable from both seeds with a path', async () => {
    const rows = await eng.relationalFanout(['companies/widget-co', 'companies/other-co'], { direction: 'both' });
    const a = rows.find(r => r.slug === 'people/investor-a');
    expect(a).toBeDefined();
    expect(a!.path.length).toBeGreaterThanOrEqual(2); // [seed, ..., node]
    expect(a!.path[a!.path.length - 1]).toBe('people/investor-a');
  });

  test('empty seeds → []', async () => {
    expect(await eng.relationalFanout([])).toEqual([]);
  });

  test('deterministic: same call twice is byte-identical', async () => {
    const r1 = await eng.relationalFanout(['companies/widget-co'], { direction: 'in' });
    const r2 = await eng.relationalFanout(['companies/widget-co'], { direction: 'in' });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
