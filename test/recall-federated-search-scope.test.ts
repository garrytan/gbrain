/**
 * #3242 parity for `recall`'s page-search arm (#4707).
 *
 * #3242 taught the unqualified read surface to widen a no-grant caller across
 * the transport-computed federated set (`ctx.localFederatedSourceIds`):
 * `search` / `query` / `get_page` / `list_pages` / `resolve_slugs` all resolve
 * their scope through `federatedSearchScope`. `recall`'s query arm was missed
 * — it resolved through `sourceScopeOpts`, which only understands an ACL grant
 * (`ctx.auth.allowedSources`) or the scalar `ctx.sourceId`, and never consults
 * the federated set.
 *
 * Effect: a remote MCP caller with no source grant stayed pinned to its scalar
 * source, so pages in a `federated: true` source were invisible to `recall`
 * while visible to every sibling read op through the same context.
 *
 * The existing `test/recall-federated.test.ts` covers the FACTS arms fanning
 * out across an `allowedSources` GRANT — a different axis. Nothing covered the
 * query arm's federated widening, which is how the gap survived.
 *
 * The parity assertion (recall's slug set === search's slug set for one ctx
 * and query) is the load-bearing one: it fails if either op drifts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import {
  federatedSearchScope,
  sourceScopeOpts,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;
const recall = () => operationsByName['recall'];
const search = () => operationsByName['search'];

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

/**
 * The exact context `gbrain serve --http` builds for a legacy bearer token
 * with no operator source grant: remote, scalar 'default', and the federated
 * set populated by the transport (never by caller params).
 */
const remoteNoGrant = () =>
  ctxOf({ remote: true, sourceId: 'default', localFederatedSourceIds: ['default', 'wiki'] });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // Seeded 'default' is federated. Add a federated peer ('wiki') that an
  // unqualified no-grant caller must see, and a NON-federated one ('privsrc')
  // that must stay invisible — the fix must widen, not unscope.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('wiki', 'wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('privsrc', 'privsrc', '/tmp/privsrc', '{}'::jsonb)`,
  );
  const pages: Array<[slug: string, sourceId: string, where: string]> = [
    ['notes/home', 'default', 'default'],
    ['wiki/topic', 'wiki', 'wiki'],
    ['privsrc/topic', 'privsrc', 'privsrc'],
  ];
  for (const [slug, sourceId, where] of pages) {
    const result = await importFromContent(engine, slug,
      serializeMarkdown({}, `the zebra telescope in ${where}`, '', { type: 'note', title: `Topic in ${where}`, tags: [] }),
      { sourceId, noEmbed: true, forceRechunk: true });
    expect(result.status).toBe('imported');
  }
  // Keyword-only search path: no embedding provider needed in tests.
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

/** `recall` returns `{facts, results}`; `search` returns a bare result array. */
const recallSlugs = (res: any): string[] => (res?.results ?? []).map((r: any) => r.slug);
const searchSlugs = (res: any): string[] => (res ?? []).map((r: any) => r.slug);

describe("recall's page-search arm honors the federated set (#3242 parity)", () => {
  test('the two scope helpers differ for a no-grant remote ctx — recall must use the widening one', () => {
    const ctx = remoteNoGrant();
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'default' });
    expect(federatedSearchScope(ctx)).toEqual({ sourceIds: ['default', 'wiki'] });
  });

  test('a no-grant remote caller sees pages from a federated peer source', async () => {
    const slugs = recallSlugs(await recall().handler(remoteNoGrant(), { query: 'zebra telescope' }));
    expect(slugs).toContain('wiki/topic');
    expect(slugs).toContain('notes/home');
  });

  test('widening stops at the federated set — a non-federated source stays invisible', async () => {
    const slugs = recallSlugs(await recall().handler(remoteNoGrant(), { query: 'zebra telescope' }));
    expect(slugs).not.toContain('privsrc/topic');
  });

  test('recall and search resolve the SAME slug set for one ctx (op parity)', async () => {
    const ctx = remoteNoGrant();
    const recalled = recallSlugs(await recall().handler(ctx, { query: 'zebra telescope' })).sort();
    const searched = searchSlugs(await search().handler(ctx, { query: 'zebra telescope' })).sort();
    expect(recalled).toEqual(searched);
  });

  test('fail-closed: a remote caller whose transport did NOT populate the set stays scalar', async () => {
    const ctx = ctxOf({ remote: true, sourceId: 'default' });
    const slugs = recallSlugs(await recall().handler(ctx, { query: 'zebra telescope' }));
    expect(slugs).toEqual(['notes/home']);
  });

  test('an ACL grant still governs — the federated set never widens past it', async () => {
    const ctx = ctxOf({
      remote: true,
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'wiki'],
      auth: { allowedSources: ['default'] } as any,
    });
    const slugs = recallSlugs(await recall().handler(ctx, { query: 'zebra telescope' }));
    expect(slugs).toEqual(['notes/home']);
  });
});

describe('#4830: every recall hit names its source', () => {
  test('a federated read labels each hit with the source it came from, never a blind default', async () => {
    const res = await recall().handler(remoteNoGrant(), { query: 'zebra telescope' }) as any;
    const bySlug = Object.fromEntries(res.results.map((r: any) => [r.slug, r.source_id]));
    expect(bySlug['notes/home']).toBe('default');
    expect(bySlug['wiki/topic']).toBe('wiki');
    for (const r of res.results) expect(typeof r.source_id).toBe('string');
  });

  test('a scalar read labels its hits with the one source in scope', async () => {
    const res = await recall().handler(ctxOf({ remote: true, sourceId: 'default' }), { query: 'zebra telescope' }) as any;
    expect(res.results.map((r: any) => r.source_id)).toEqual(['default']);
    const wiki = await recall().handler(ctxOf({ remote: false, sourceId: 'wiki' }), { query: 'zebra telescope', source_id: 'wiki' }) as any;
    expect(wiki.results.map((r: any) => [r.slug, r.source_id])).toEqual([['wiki/topic', 'wiki']]);
  });
});

describe("recall's fact arms honor the federated set too", () => {
  const factTexts = (res: any): string[] => (res?.facts ?? []).map((f: any) => f.fact);
  beforeAll(async () => {
    for (const [fact, source_id] of [['zebra fact in default', 'default'], ['zebra fact in wiki', 'wiki'], ['zebra fact in privsrc', 'privsrc']]) {
      await engine.insertFact({ fact, kind: 'fact', entity_slug: `zebra-${source_id}`, source: 'test', visibility: 'world' }, { source_id });
    }
  });

  test('a no-grant remote caller recalls facts from a federated peer source, never a non-federated one', async () => {
    const facts = factTexts(await recall().handler(remoteNoGrant(), { since: '1 day ago' }));
    expect(facts).toContain('zebra fact in default');
    expect(facts).toContain('zebra fact in wiki');
    expect(facts).not.toContain('zebra fact in privsrc');
  });

  test('without a transport-computed set the fact arms stay on the scalar source', async () => {
    const facts = factTexts(await recall().handler(ctxOf({ remote: true, sourceId: 'default' }), { since: '1 day ago' }));
    expect(facts).toEqual(['zebra fact in default']);
  });
});
