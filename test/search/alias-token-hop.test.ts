/**
 * #5428 remainder: the alias hop only fired when the WHOLE query was an
 * alias, so "<alias> summary" never surfaced the entity page. With
 * `tokenHop` on (opt-in: per-call `aliasTokenHop` or brain config
 * `search.alias_token_hop=true`), a query token that is the alias of exactly
 * one person/company page moves that page to the front, or injects it when
 * absent (at most two pages). Off by default.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop, hybridSearch } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function res(slug: string, score: number, type = 'note'): SearchResult {
  return { slug, title: slug, score, chunk_text: '', type, source_id: 'default', chunk_index: 0, chunk_id: 1 } as unknown as SearchResult;
}

describe('applyAliasHop — single-token alias hop', () => {
  test('off by default: "<alias> summary" changes nothing', async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice runs the lab.' });
    await engine.setPageAliases('people/alice-example', 'default', ['ali']);
    const organic = [res('chats/log', 0.9), res('people/alice-example', 0.5, 'person')];
    const out = await applyAliasHop(engine, organic, 'ali summary', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toEqual(['chats/log', 'people/alice-example']);
  });

  test('on: a present entity page moves to the front; the rest keep their order', async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice runs the lab.' });
    await engine.setPageAliases('people/alice-example', 'default', ['ali']);
    const organic = [res('chats/log', 0.9), res('notes/x', 0.7), res('people/alice-example', 0.5, 'person')];
    const out = await applyAliasHop(engine, organic, 'ali summary', { sourceId: 'default', tokenHop: true });
    expect(out.map(r => r.slug)).toEqual(['people/alice-example', 'chats/log', 'notes/x']);
    expect(out[0].alias_hit).toBe(true);
  });

  test('on: an absent entity page is injected', async () => {
    await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme builds widgets.' });
    await engine.setPageAliases('companies/acme-example', 'default', ['acme']);
    const out = await applyAliasHop(engine, [res('chats/log', 0.9)], 'acme notes', { sourceId: 'default', tokenHop: true });
    expect(out.map(r => r.slug)).toEqual(['companies/acme-example', 'chats/log']);
  });

  test('on: an ambiguous token, a non-entity page, and an excluded page are ignored', async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'a' });
    await engine.putPage('people/alice-other', { type: 'person', title: 'Alice Other', compiled_truth: 'b' });
    await engine.setPageAliases('people/alice-example', 'default', ['alice']);
    await engine.setPageAliases('people/alice-other', 'default', ['alice']);
    await engine.putPage('projects/widget', { type: 'note', title: 'Widget', compiled_truth: 'c' });
    await engine.setPageAliases('projects/widget', 'default', ['widget']);
    await engine.putPage('people/bob-example', { type: 'person', title: 'Bob Example', compiled_truth: 'd' });
    await engine.setPageAliases('people/bob-example', 'default', ['bob']);
    const organic = [res('chats/log', 0.9)];
    expect((await applyAliasHop(engine, organic, 'alice widget summary', { sourceId: 'default', tokenHop: true })).map(r => r.slug))
      .toEqual(['chats/log']);
    expect((await applyAliasHop(engine, organic, 'bob summary', { sourceId: 'default', tokenHop: true, excludeSlugs: ['people/bob-example'] })).map(r => r.slug))
      .toEqual(['chats/log']);
  });

  test('on: at most two token pages', async () => {
    for (const [slug, alias] of [['people/a-example', 'aa'], ['people/b-example', 'bb'], ['people/c-example', 'cc']]) {
      await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: slug });
      await engine.setPageAliases(slug, 'default', [alias]);
    }
    const out = await applyAliasHop(engine, [], 'aa bb cc', { sourceId: 'default', tokenHop: true });
    expect(out.length).toBe(2);
  });

  test('a full-query alias match takes precedence over token hops', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'x' });
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
    await engine.putPage('people/light-example', { type: 'person', title: 'Light Example', compiled_truth: 'y' });
    await engine.setPageAliases('people/light-example', 'default', ['light']);
    const out = await applyAliasHop(engine, [], 'hall of light', { sourceId: 'default', tokenHop: true });
    expect(out.map(r => r.slug)).toEqual(['projects/mingtang']);
  });
});

describe('hybridSearch wiring', () => {
  test('per-call aliasTokenHop and brain config search.alias_token_hop both enable it', async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice runs the lab.' });
    await engine.setPageAliases('people/alice-example', 'default', ['ali']);
    await engine.putPage('chats/log', { type: 'note', title: 'Chat log', compiled_truth: 'ali summary of the week' });
    const rr = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any };
    expect((await hybridSearch(engine, 'ali summary', rr)).map(r => r.slug)).not.toContain('people/alice-example');
    expect((await hybridSearch(engine, 'ali summary', { ...rr, aliasTokenHop: true }))[0].slug).toBe('people/alice-example');
    await engine.setConfig('search.alias_token_hop', 'true');
    expect((await hybridSearch(engine, 'ali summary', rr))[0].slug).toBe('people/alice-example');
  }, 60_000);
});
