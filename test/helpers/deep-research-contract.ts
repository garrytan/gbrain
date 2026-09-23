import { beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { decodeDeepResearchId, encodeDeepResearchId } from '../../src/core/deep-research-id.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { stampDeepResearchIds } from '../../src/core/ops/context.ts';
import { structuralExactLookup } from '../../src/core/search/exact-lookup.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { hydrateChunks } from '../../src/core/search/two-pass.ts';
import { installFixtureChunks } from './page-projection.ts';

const fetchOp = operations.find(o => o.name === 'fetch')!;
const searchOp = operations.find(o => o.name === 'search')!;
const queryOp = operations.find(o => o.name === 'query')!;
const slug = 'notes/shared-example';

export function deepResearchContract(getEngine: () => BrainEngine): void {
  const ctx = (overrides: Partial<OperationContext> = {}): OperationContext => ({
    engine: getEngine(), config: { engine: 'pglite' }, logger: console, dryRun: false,
    remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'beta'] } as any,
    ...overrides,
  });
  const seed = async (sourceId: string, pageSlug: string, body: string, frontmatter = {}) => {
    await getEngine().putPage(pageSlug, { type: 'note', title: `${sourceId} fixture`, compiled_truth: body, frontmatter }, { sourceId, force: true });
    await installFixtureChunks(getEngine(), pageSlug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { sourceId });
  };
  const fetch = (id: string, context = ctx()) => fetchOp.handler(context, { id }) as Promise<any>;
  const errorOf = async (id: string, context = ctx()) => {
    try { await fetch(id, context); throw new Error('Expected fetch to fail'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const e = error as OperationError;
      return { code: e.code, message: e.message, suggestion: e.suggestion };
    }
  };

  describe('source-qualified deep research contract', () => {
    beforeEach(async () => {
      await getEngine().executeRaw(`INSERT INTO sources (id, name) VALUES ('beta', 'beta') ON CONFLICT (id) DO UPDATE SET archived=false`);
      await getEngine().setConfig('search.mcp_keyword_only', 'true');
      await seed('default', slug, 'Unrelated default material.');
      await seed('beta', slug, 'Zirconiumneedle beta evidence.');
    });

    for (const keywordOnly of [true, false]) {
      test(`${keywordOnly ? 'keyword dedup' : 'keyless hybrid fallback'} round-trips every result source`, async () => {
        await getEngine().setConfig('search.mcp_keyword_only', String(keywordOnly));
        const hits = await searchOp.handler(ctx(), { query: 'Zirconiumneedle' }) as any[];
        expect(hits).toHaveLength(1);
        expect(hits[0].source_id).toBe('beta');
        expect(decodeDeepResearchId(hits[0].id)).toEqual({ sourceId: 'beta', slug });
        const page = await fetch(hits[0].id);
        expect(page.id).toBe(hits[0].id);
        expect(page.metadata.source_id).toBe('beta');
        expect(page.text).toContain('Zirconiumneedle beta evidence.');
        expect(page.text).not.toContain('Unrelated default material.');
        expect(page.url).toBe(`gbrain://page/beta/${slug}`);
      });
    }

    test('same-slug hits survive dedup with distinct ids', async () => {
      await seed('default', slug, 'Zirconiumneedle default alpha vocabulary.');
      const hits = await searchOp.handler(ctx(), { query: 'Zirconiumneedle' }) as any[];
      expect(hits).toHaveLength(2);
      expect(new Set(hits.map(hit => hit.id)).size).toBe(2);
      for (const hit of hits) expect((await fetch(hit.id)).metadata.source_id).toBe(hit.source_id);
    });

    test('query results round-trip the same source-qualified protocol', async () => {
      const hits = await queryOp.handler(ctx(), { query: 'Zirconiumneedle', expand: false }) as any[];
      expect(hits).toHaveLength(1);
      expect(decodeDeepResearchId(hits[0].id)).toEqual({ sourceId: 'beta', slug });
      expect((await fetch(hits[0].id)).metadata.source_id).toBe('beta');
    });

    test('exact, alias, relational and code-hydration producers retain their own source', async () => {
      const scope = { sourceIds: ['default', 'beta'], excludePrivate: true, requireSafeChunks: true };
      await getEngine().setPageAliases(slug, 'beta', ['rare alias probe']);
      await getEngine().putPage('companies/widget-example', { type: 'company', title: 'Widget Example', compiled_truth: 'Synthetic company.' }, { sourceId: 'beta' });
      await getEngine().putPage('people/investor-example', { type: 'person', title: 'Investor Example', compiled_truth: 'Synthetic investor.' }, { sourceId: 'beta' });
      await installFixtureChunks(getEngine(), 'companies/widget-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic company.' }], { sourceId: 'beta' });
      await installFixtureChunks(getEngine(), 'people/investor-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic investor.' }], { sourceId: 'beta' });
      await getEngine().addLink('people/investor-example', 'companies/widget-example', '', 'invested_in', 'manual', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'beta' });
      const chunks = await getEngine().getChunks(slug, { sourceId: 'beta' });
      expect(chunks.length).toBeGreaterThan(0);
      const producers = {
        exact: await structuralExactLookup(getEngine(), slug, scope),
        alias: await applyAliasHop(getEngine(), [], 'rare alias probe', scope),
        relational: await buildRelationalArm(getEngine(), 'who invested in widget-example', scope),
        code: await hydrateChunks(getEngine(), chunks.map(chunk => chunk.id)),
      };
      for (const [producer, hits] of Object.entries(producers)) {
        expect(hits.length, producer).toBeGreaterThan(0);
        expect(hits.some(hit => hit.source_id === 'beta')).toBe(true);
        stampDeepResearchIds(hits);
        for (const hit of hits) {
          const id = (hit as typeof hit & { id: string }).id;
          expect(decodeDeepResearchId(id)).toEqual({ sourceId: hit.source_id!, slug: hit.slug });
          expect((await fetch(id)).metadata.source_id).toBe(hit.source_id);
        }
      }
    });

    test('legacy collisions refuse without listing candidates; scalar legacy lookup still works', async () => {
      expect(await errorOf(slug)).toEqual({
        code: 'ambiguous_id', message: 'The legacy id matches multiple readable pages',
        suggestion: 'Search again and pass the source-qualified result id.',
      });
      expect((await fetch(slug, ctx({ auth: undefined, sourceId: 'beta' }))).metadata.source_id).toBe('beta');
    });

    test('source-qualified lookup never falls back to another source', async () => {
      await seed('default', 'notes/default-only', 'Default only evidence.');
      expect((await errorOf(encodeDeepResearchId('beta', 'notes/default-only'))).code).toBe('page_not_found');
    });

    test('malformed and unsupported opaque ids fail without reflecting their payload', async () => {
      for (const id of ['gbrain-page:v2:beta-secret', 'gbrain-page:v1:!!', 'gbrain-page:v1:' + Buffer.from('["beta","../secret"]').toString('base64url')]) {
        expect(await errorOf(id)).toEqual({
          code: 'invalid_params', message: 'Invalid fetch result id',
          suggestion: 'Pass the unchanged `id` field from a `search` result.',
        });
      }
    });

    test('current grants reject stale, forged, and revoked ids without metadata', async () => {
      const betaId = encodeDeepResearchId('beta', slug);
      expect((await fetch(betaId)).metadata.source_id).toBe('beta');
      const current = ctx({ auth: { allowedSources: ['default'] } as any });
      const missing = await errorOf(encodeDeepResearchId('default', 'notes/missing'), current);
      expect(await errorOf(betaId, current)).toEqual(missing);
      expect(await errorOf(encodeDeepResearchId('unknown', 'notes/missing'), current)).toEqual(missing);
      expect(await errorOf(betaId, ctx({ sourceId: undefined, auth: { allowedSources: [] } as any }))).toEqual(missing);
      expect(await errorOf(betaId, ctx({ auth: undefined, remote: undefined as any }))).toEqual(missing);
      expect(await errorOf(betaId, ctx({ sourceId: undefined, auth: undefined }))).toEqual(missing);
      expect(await errorOf(slug, ctx({ sourceId: undefined, auth: undefined }))).toEqual(missing);
      expect(await errorOf(betaId, ctx({ sourceId: '__all__', auth: undefined }))).toEqual(missing);
    });

    test('transport-computed federation permits its hit but cannot widen OAuth grants', async () => {
      const id = encodeDeepResearchId('beta', slug);
      const localFederation = ctx({ auth: undefined, localFederatedSourceIds: ['default', 'beta'] });
      expect((await fetch(id, localFederation)).metadata.source_id).toBe('beta');
      expect((await errorOf(id, { ...localFederation, auth: { allowedSources: ['default'] } as any })).code).toBe('page_not_found');
      expect((await fetch(id, ctx({ remote: false, auth: undefined }))).metadata.source_id).toBe('beta');
    });

    test('private and archived collisions neither mask visible legacy matches nor leak existence', async () => {
      await seed('default', slug, 'Private default material.', { visibility: 'private' });
      expect((await fetch(slug)).metadata.source_id).toBe('beta');
      const missing = await errorOf(encodeDeepResearchId('default', 'notes/missing'));
      expect(await errorOf(encodeDeepResearchId('default', slug))).toEqual(missing);
      await getEngine().executeRaw(`UPDATE sources SET archived=true WHERE id='beta'`);
      expect(await errorOf(encodeDeepResearchId('beta', slug))).toEqual(missing);
      expect(await errorOf(slug)).toEqual(missing);
    });

    test('soft deletion cannot redirect an opaque id to the colliding page', async () => {
      await getEngine().deletePage(slug, { sourceId: 'beta' });
      expect((await errorOf(encodeDeepResearchId('beta', slug))).code).toBe('page_not_found');
      expect((await fetch(slug)).metadata.source_id).toBe('default');
    });

    test('source-bound aliases retain identity and canonical citations after rename', async () => {
      const id = encodeDeepResearchId('beta', slug);
      await getEngine().updateSlug(slug, 'notes/renamed-example', { sourceId: 'beta' });
      await getEngine().executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('beta', $1, 'notes/renamed-example')`, [slug]);
      const page = await fetch(id);
      expect(page.id).toBe(id);
      expect(page.metadata.source_id).toBe('beta');
      expect(page.url).toBe('gbrain://page/beta/notes/renamed-example');
      expect(page.text).toContain('Zirconiumneedle');
      expect((await errorOf(slug)).code).toBe('ambiguous_id');
    });

    test('opaque ids prefer an exact page over a stale same-source alias', async () => {
      await seed('beta', 'notes/renamed-example', 'Renamed fixture evidence.');
      await getEngine().executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('beta', $1, 'notes/renamed-example')`, [slug]);
      const result = await fetch(encodeDeepResearchId('beta', slug));
      expect(result.text).toContain('Zirconiumneedle beta evidence.');
      expect(result.url).toBe(`gbrain://page/beta/${slug}`);
    });

    for (const state of ['private', 'deleted'] as const) {
      test(`${state} exact pages cannot substitute a readable stale alias target`, async () => {
        const hits = await searchOp.handler(ctx(), { query: 'Zirconiumneedle' }) as any[];
        expect(hits).toHaveLength(1);
        await seed('beta', 'notes/previous-example', 'Different stale alias evidence.');
        await getEngine().executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
          VALUES ('beta', $1, 'notes/previous-example')`, [slug]);
        if (state === 'private') await seed('beta', slug, 'Private exact evidence.', { visibility: 'private' });
        else await getEngine().softDeletePage(slug, { sourceId: 'beta' });
        const missing = await errorOf(encodeDeepResearchId('beta', 'notes/missing'));
        expect(await errorOf(hits[0].id)).toEqual(missing);
        expect((await fetch(encodeDeepResearchId('beta', 'notes/previous-example'))).text)
          .toContain('Different stale alias evidence.');
        if (state === 'deleted') expect(await errorOf(hits[0].id, ctx({ remote: false }))).toEqual(missing);
      });
    }

    test('unicode and delimiter-bearing slugs round-trip with escaped citations', async () => {
      const special = 'notes/研究:example?part#one% "quoted"';
      await seed('beta', special, 'Escaped fixture evidence.');
      const id = encodeDeepResearchId('beta', special);
      const result = await fetch(id);
      expect(result.id).toBe(id);
      const uri = new URL(result.url);
      expect(uri.search).toBe('');
      expect(uri.hash).toBe('');
      expect(decodeURIComponent(uri.pathname)).toBe(`/beta/${special}`);
    });

    for (const transport of ['stdio', 'http'] as const) {
      test(`${transport} MCP dispatch round-trips search/fetch and rechecks changed grants`, async () => {
        const opts = { sourceId: 'default', remote: true, transport, auth: { allowedSources: ['default', 'beta'] } as any };
        const searched = await dispatchToolCall(getEngine(), 'search', { query: 'Zirconiumneedle' }, opts);
        expect(searched.isError).not.toBe(true);
        const hits = JSON.parse(searched.content[0].text);
        const result = await dispatchToolCall(getEngine(), 'fetch', { id: hits[0].id }, opts);
        expect(result.isError).not.toBe(true);
        const page = JSON.parse(result.content[0].text);
        expect(page.id).toBe(hits[0].id);
        expect(page.metadata.source_id).toBe('beta');
        const refused = await dispatchToolCall(getEngine(), 'fetch', { id: hits[0].id }, { ...opts, auth: { allowedSources: ['default'] } as any });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).not.toContain('beta');
        expect(refused.content[0].text).not.toContain('Zirconiumneedle');
      });
    }
  });
}
