/**
 * Optional alias expansion can degrade when its table is unavailable.
 * Canonical publication requires the complete snapshot schema; a missing
 * alias table must reject ingestion before any page or projection changes.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  // Simulate a pre-v110 brain: drop the page_aliases table entirely.
  await engine.executeRaw('DROP TABLE IF EXISTS page_aliases');
});

function r(slug: string, score: number): SearchResult {
  return { slug, title: slug, score, chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1 } as unknown as SearchResult;
}

describe('incomplete alias schema: optional search fallback and atomic write refusal', () => {
  test('applyAliasHop returns input unchanged, does not throw', async () => {
    const organic = [r('a', 0.9), r('b', 0.8)];
    const out = await applyAliasHop(engine, organic, 'hall of light', { sourceId: 'default' });
    expect(out.map(x => x.slug)).toEqual(['a', 'b']);
  });

  test('canonical import rejects incomplete snapshot schema without a partial page or projection', async () => {
    const md = `---\ntype: note\ntitle: X\naliases: [Hall of Light]\n---\nbody`;
    await expect(importFromContent(engine, 'p/x', md, { sourceId: 'default', noEmbed: true }))
      .rejects.toMatchObject({ code: '42P01' });
    expect(await engine.executeRaw("SELECT id FROM pages WHERE slug='p/x' AND source_id='default'")).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM content_chunks')).toEqual([]);
  });

  test('resolveAliases throws table-missing (caller is responsible for catching)', async () => {
    // The engine method itself surfaces the error; the alias-hop caller wraps it.
    let threw = false;
    try {
      await engine.resolveAliases(['x'], { sourceId: 'default' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
