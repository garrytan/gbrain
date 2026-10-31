/**
 * #7972: counted keyword enumeration must include exact slug/handle identities,
 * without post-LIMIT injection. Protects typed OR walks and the read fences on
 * both engines. Uses real imported pages and the public operation, no mocks.
 * Fails upstream because only body chunks participate in admission.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { callSearch, seedPage, walkKeyword } from './helpers/keyword-paging-fixture.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

for (const backend of testBackends()) {
  describe(`keyword handle identities (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await seedPage(engine, 'people/dan-example', 'Dan leads procurement.', { type: 'person', title: 'Dan Example' });
      await seedPage(engine, 'people/erin-example', 'Erin leads design.', { type: 'person', title: 'Erin Example' });
      await seedPage(engine, 'meetings/review', 'Discussed dan-example and erin-example.', { type: 'meeting' });
      await seedPage(engine, 'people/private-example', 'Private canary.', { type: 'person', frontmatter: { visibility: 'private' } });
      await seedPage(engine, 'people/deleted-example', 'Deleted canary.', { type: 'person' });
      await engine.deletePage('people/deleted-example');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('a handle finds its own page even when absent from its title and body', async () => {
      const result = await callSearch(engine, { query: 'dan-example', match: 'keyword', types: ['person'] });
      expect(result.rows.map(r => r.slug)).toEqual(['people/dan-example']);
      expect(result.retrieval).toMatchObject({ total: 1, truncated: false });
      const full = await engine.searchKeywordPages('people/dan-example', { types: ['person'] }, { limit: 10 });
      expect(full.map(r => r.slug)).toEqual(['people/dan-example']);
    });

    test('quoted OR counts identities and body matches once, with consistent cursor/offset walks', async () => {
      const query = '"dan-example" OR "erin-example"';
      const { slugs, pages } = await walkKeyword(engine, { query, limit: 1 });
      expect([...slugs].sort()).toEqual(['meetings/review', 'people/dan-example', 'people/erin-example']);
      expect(new Set(slugs).size).toBe(3);
      expect(pages[0].retrieval.total).toBe(3);
      const typed = await walkKeyword(engine, { query, limit: 1, types: ['person'] });
      expect([...typed.slugs].sort()).toEqual(['people/dan-example', 'people/erin-example']);
      expect(typed.pages[0].retrieval.total).toBe(2);
      const offsets: string[] = [];
      for (let offset = 0; offset < 3; offset++) {
        offsets.push(...(await callSearch(engine, { query, match: 'keyword', limit: 1, offset })).rows.map(r => String(r.slug)));
      }
      expect(offsets).toEqual(slugs);
    });

    test('identity candidates obey private/deleted, type, prefix, source and frontmatter fences', async () => {
      const query = '"dan-example" OR "private-example" OR "deleted-example"';
      const opts = { requireSafeChunks: true, excludePrivate: true, sourceId: 'default', types: ['person'] };
      expect(await engine.countKeywordPages(query, opts)).toBe(1);
      expect((await engine.searchKeywordPages(query, opts, { limit: 10 })).map(r => r.slug)).toEqual(['people/dan-example']);
      for (const extra of [{ types: ['meeting'] }, { sourceId: 'other' }, { exclude_slug_prefixes: ['people/'] }, { where: { department: ['nonexistent'] } }]) {
        const filtered = { ...opts, ...extra };
        expect(await engine.countKeywordPages('dan-example', filtered)).toBe(extra.types ? 1 : 0);
        expect((await engine.searchKeywordPages('dan-example', filtered, { limit: 10 })).length).toBe(extra.types ? 1 : 0);
      }
    });

    test('AND, negation, phrases and partial handles do not become OR identity probes', async () => {
      for (const query of ['dan-example nonexistent', 'dan-example -procurement', '"dan-example nonexistent"', 'dan-exampl', '"dan-example" OR "erin-example" -design']) {
        expect(await engine.countKeywordPages(query, { types: ['person'] })).toBe(0);
      }
      expect(await engine.countKeywordPages('"Dan Example"', { types: ['person'] })).toBe(0);
    });

    test('MCP text contains the identity and the same counted match set', async () => {
      const result = await dispatchToolCall(engine, 'search', {
        query: '"dan-example" OR "erin-example"', match: 'keyword', types: ['person'], limit: 1,
      }, { remote: true, transport: 'http', sourceId: 'default' });
      expect(result.isError).not.toBe(true);
      const text = result.content.map(c => c.text).join('\n');
      expect(text).toContain('people/dan-example');
      expect(text).toContain('Keyword matches: 2 pages; showing 1-1');
      expect(text).toContain('next = ');
    });

    test('an identity cannot bypass the live projection or safe chunk seal', async () => {
      await seedPage(engine, 'people/stale-example', 'Old public text.', { type: 'person' });
      await engine.putPage('people/stale-example', { type: 'person', title: 'Stale Example', compiled_truth: 'New text without a projection.' });
      const opts = { requireSafeChunks: true, excludePrivate: true };
      expect(await engine.countKeywordPages('stale-example', opts)).toBe(0);
      expect(await engine.searchKeywordPages('stale-example', opts, { limit: 10 })).toEqual([]);
    });
  });
}
