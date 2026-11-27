/**
 * #9922: keyword search pages past three times the limit.
 *
 * 1. Protects: searchKeyword (the search.mcp_keyword_only path) applies offset as "rows to skip": with 60 matching
 *    pages and limit 10, offsets 0, 20, 30 and 40 each return 10 rows. Before, the chunk pool was cut to 3 x limit
 *    before OFFSET, so any offset at or past 3 x limit read an empty page.
 * 2. Fails when: a page inside the matching set comes back short or empty, or pages overlap.
 * 3. Real seams: the engine's searchKeyword on in-memory PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) describe(`keyword search offset past 3 x limit (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
    for (let i = 0; i < 60; i++) {
      const n = String(i).padStart(2, '0');
      await importFromContent(engine, `notes/zebrafish-${n}`, `---\ntitle: Note ${n}\n---\n# Note ${n}\nA zebrafish observation, entry ${n}.`, { sourceId: 'default', noEmbed: true });
    }
  }, 180_000);
  afterAll(async () => { await close?.(); });

  test('every page of 10 inside 60 matches is full and distinct', async () => {
    const seen = new Set<string>();
    for (const offset of [0, 10, 20, 30, 40, 50]) {
      const rows = await engine.searchKeyword('zebrafish', { limit: 10, offset });
      expect(rows.length, `offset ${offset}`).toBe(10);
      for (const r of rows) seen.add(r.slug);
    }
    expect(seen.size).toBe(60);
    expect((await engine.searchKeyword('zebrafish', { limit: 10, offset: 60 })).length).toBe(0);
  }, 60_000);
});
