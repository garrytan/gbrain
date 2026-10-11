/**
 * T9 regression — pre-v110 brains (no page_aliases table) must keep working.
 * The alias layer is additive: every alias touchpoint fails open so a brain
 * mid-upgrade (migration not yet run) still ingests and searches normally.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { SearchResult } from '../../src/core/types.ts';

const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
});
afterAll(async () => { await engine.initSchema(); await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
  // Simulate a pre-v110 brain: drop the page_aliases table entirely.
  await engine.executeRaw('DROP TABLE IF EXISTS page_aliases');
});

function r(slug: string, score: number): SearchResult {
  return { slug, title: slug, score, chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1 } as unknown as SearchResult;
}

describe('pre-migration (no page_aliases table) fail-open', () => {
  test('applyAliasHop returns input unchanged, does not throw', async () => {
    const organic = [r('a', 0.9), r('b', 0.8)];
    const out = await applyAliasHop(engine, organic, 'hall of light', { sourceId: 'default' });
    expect(out.map(x => x.slug)).toEqual(['a', 'b']);
  });

  test('importFromContent with frontmatter aliases does not throw (projection swallows table-missing)', async () => {
    const md = `---\ntype: note\ntitle: X\naliases: [Hall of Light]\n---\nbody`;
    const res = await importFromContent(engine, 'p/x', md, { sourceId: 'default', noEmbed: true });
    expect(res.status).toBe('imported'); // page write succeeded despite no alias table
    expect((await engine.getPage('p/x', { sourceId: 'default' }))?.frontmatter.aliases).toEqual(['Hall of Light']);
  });

  test('alias projection errors other than a missing table still fail and roll back the import', async () => {
    const injected = Object.assign(new Error('alias constraint rejected'), { code: '23514' });
    const write = spyOn(engine, 'setPageAliases').mockRejectedValue(injected);
    try {
      await expect(importFromContent(engine, 'p/rejected', '# Rejected\nbody', { sourceId: 'default', noEmbed: true }))
        .rejects.toThrow('alias constraint rejected');
      expect(await engine.getPage('p/rejected', { sourceId: 'default' })).toBeNull();
    } finally {
      write.mockRestore();
    }
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
