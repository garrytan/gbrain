/**
 * #9923: the alias hop injected an alias's canonical page even when the
 * caller's type/types filter excluded that page's type, so
 * `search Quokkafoo --types company` led with a person page. The hop now
 * applies the same type gate as the exact-lookup tier (#4480).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyAliasHop, hybridSearch } from '../src/core/search/hybrid.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PageType } from '../src/core/types.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await importFromContent(engine, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\naliases: [Quokkafoo]\n---\nAlice works on things.\n', { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'companies/acme-example', '---\ntype: company\ntitle: Acme Example\n---\nAcme Example mentions a quokkafoo partnership.\n', { sourceId: 'default', noEmbed: true });
});

const rr = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any };
const slugs = async (opts: Record<string, unknown>) => (await hybridSearch(engine, 'Quokkafoo', { ...rr, ...opts })).map((r) => r.slug);

describe('alias hop honours the type filter (#9923)', () => {
  test('search --types company never injects the aliased person page', async () => {
    expect(await slugs({ types: ['company'] as PageType[] })).toEqual(['companies/acme-example']);
  }, 60_000);

  test('search --type company and --types concept never inject it either', async () => {
    expect(await slugs({ type: 'company' as PageType })).toEqual(['companies/acme-example']);
    expect(await slugs({ types: ['concept'] as PageType[] })).toEqual([]);
  }, 60_000);

  test('a matching type filter and no filter still inject the canonical at rank 1', async () => {
    expect((await slugs({ types: ['person'] as PageType[] }))[0]).toBe('people/alice-example');
    expect(await slugs({})).toEqual(['people/alice-example', 'companies/acme-example']);
  }, 60_000);

  test('applyAliasHop: the single-token hop is gated too', async () => {
    const out = await applyAliasHop(engine, [], 'quokkafoo summary', { sourceId: 'default', tokenHop: true, types: ['company'] });
    expect(out).toEqual([]);
    const allowed = await applyAliasHop(engine, [], 'quokkafoo summary', { sourceId: 'default', tokenHop: true, types: ['person'] });
    expect(allowed.map((r) => r.slug)).toEqual(['people/alice-example']);
  });
});
