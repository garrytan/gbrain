/**
 * OAuth slug-prefix read binding (oauth_clients.bound_slug_prefixes) —
 * read-side isolation regression suite.
 *
 * A client bound to e.g. ['clients/*', 'people/*'] must never see content
 * outside those prefixes through ANY read surface: engine search paths
 * (SQL-side via SearchOpts.restrict_slug_prefixes), listPages
 * (PageFilters.restrictSlugPrefixes), and the op-handler layer
 * (slugScopeOpts / assertSlugReadable / filterRowsBySlugBinding).
 *
 * Modeled on test/e2e/source-isolation-pglite.test.ts (the source-axis
 * sibling). Same two-layer coverage: engine layer + op-handler layer with
 * a simulated AuthInfo carrying boundSlugPrefixes.
 *
 * Binding semantics under test (see AuthInfo.boundSlugPrefixes):
 *  - undefined (no binding)  → unrestricted (back-compat)
 *  - non-empty list          → confined; glob semantics of matchesSlugAllowList
 *  - empty array []          → fail-closed: sees NOTHING
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** Op-handler ctx with an optional slug binding on AuthInfo. */
function mkCtx(boundSlugPrefixes?: string[]) {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    ...(boundSlugPrefixes !== undefined
      ? {
          auth: {
            token: 'test',
            clientId: 'test-bound-client',
            scopes: ['read'],
            boundSlugPrefixes,
          },
        }
      : {}),
  };
}

async function seedPage(slug: string, title: string, text: string) {
  await engine.putPage(slug, {
    type: 'note',
    title,
    compiled_truth: text,
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    token_count: Math.ceil(text.length / 4),
  }], { sourceId: 'default' });
}

beforeEach(async () => {
  await resetPgliteState(engine);
  // One page per prefix family. All share the marker keyword so a search
  // that ignores the binding would return all of them.
  await seedPage('clients/acme-example', 'Acme (client)', 'Acme client notes. Zebra-marker keyword here.');
  await seedPage('clients/acme-example/meetings/2026-06-01', 'Acme meeting', 'Acme meeting notes. Zebra-marker keyword here.');
  await seedPage('people/alice-example', 'Alice', 'Alice profile. Zebra-marker keyword here.');
  await seedPage('partenaires/fund-a', 'Fund A (partner)', 'Partner fund notes. Zebra-marker keyword here. SECRET-PARTNER-TERMS.');
  // Cross-prefix edges for the backlink / link / graph leak tests.
  await engine.addLink('clients/acme-example', 'partenaires/fund-a', 'acme works with fund-a', 'mentions');
  await engine.addLink('partenaires/fund-a', 'clients/acme-example', 'fund-a invested in acme', 'mentions');
  await engine.addLink('clients/acme-example', 'people/alice-example', 'alice is the acme contact', 'mentions');
});

// ---------------------------------------------------------------------------
// Engine layer
// ---------------------------------------------------------------------------

describe('engine layer — SearchOpts.restrict_slug_prefixes', () => {
  test('searchKeyword confined to clients/*', async () => {
    const rows = await engine.searchKeyword('Zebra-marker', {
      restrict_slug_prefixes: ['clients/*'],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.slug.startsWith('clients/')).toBe(true);
    }
  });

  test('searchKeyword unrestricted sees every prefix (back-compat)', async () => {
    const rows = await engine.searchKeyword('Zebra-marker', {});
    const slugs = new Set(rows.map(r => r.slug));
    expect(slugs.has('partenaires/fund-a')).toBe(true);
    expect(slugs.has('people/alice-example')).toBe(true);
  });

  test('searchKeyword with EMPTY binding returns nothing (fail-closed)', async () => {
    const rows = await engine.searchKeyword('Zebra-marker', {
      restrict_slug_prefixes: [],
    });
    expect(rows.length).toBe(0);
  });

  test('bare entry matches exactly one slug, not descendants', async () => {
    const rows = await engine.searchKeyword('Zebra-marker', {
      restrict_slug_prefixes: ['clients/acme-example'],
    });
    const slugs = new Set(rows.map(r => r.slug));
    expect(slugs.has('clients/acme-example')).toBe(true);
    expect(slugs.has('clients/acme-example/meetings/2026-06-01')).toBe(false);
  });

  test('searchKeywordChunks honors the binding', async () => {
    const rows = await engine.searchKeywordChunks('SECRET-PARTNER-TERMS', {
      restrict_slug_prefixes: ['clients/*', 'people/*'],
    });
    expect(rows.length).toBe(0);
  });

  test('listPages with restrictSlugPrefixes confined', async () => {
    const pages = await engine.listPages({ restrictSlugPrefixes: ['people/*'] });
    expect(pages.length).toBe(1);
    expect(pages[0].slug).toBe('people/alice-example');
  });

  test('listPages with empty binding returns nothing', async () => {
    const pages = await engine.listPages({ restrictSlugPrefixes: [] });
    expect(pages.length).toBe(0);
  });

  test('LIKE metacharacters in a prefix are escaped, not wildcards', async () => {
    // 'clients_' would match 'clientsx' if `_` reached LIKE unescaped.
    await seedPage('clientsx/sneaky', 'Sneaky', 'Zebra-marker keyword here.');
    const rows = await engine.searchKeyword('Zebra-marker', {
      restrict_slug_prefixes: ['clients_/*'],
    });
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Op-handler layer
// ---------------------------------------------------------------------------

describe('op layer — bound client is confined on every read surface', () => {
  async function op(name: string) {
    const { operations } = await import('../../src/core/operations.ts');
    const found = operations.find(o => o.name === name);
    expect(found).toBeDefined();
    return found!;
  }

  test('search op: bound to clients/* sees only clients rows', async () => {
    const searchOp = await op('search');
    const rows = (await searchOp.handler(
      mkCtx(['clients/*']) as any,
      { query: 'Zebra-marker' },
    )) as Array<{ slug: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.slug.startsWith('clients/')).toBe(true);
  });

  test('search op: unbound client still sees everything (back-compat)', async () => {
    const searchOp = await op('search');
    const rows = (await searchOp.handler(
      mkCtx() as any,
      { query: 'Zebra-marker' },
    )) as Array<{ slug: string }>;
    const slugs = new Set(rows.map(r => r.slug));
    expect(slugs.has('partenaires/fund-a')).toBe(true);
  });

  test('get_page: out-of-binding slug is page_not_found (no existence oracle)', async () => {
    const getPage = await op('get_page');
    await expect(
      getPage.handler(mkCtx(['clients/*']) as any, { slug: 'partenaires/fund-a' }),
    ).rejects.toThrow(/Page not found/);
  });

  test('get_page: in-binding slug resolves normally', async () => {
    const getPage = await op('get_page');
    const page = (await getPage.handler(
      mkCtx(['clients/*']) as any,
      { slug: 'clients/acme-example' },
    )) as { slug: string };
    expect(page.slug).toBe('clients/acme-example');
  });

  test('list_pages: bound client enumerates only its prefixes', async () => {
    const listPages = await op('list_pages');
    const rows = (await listPages.handler(
      mkCtx(['clients/*', 'people/*']) as any,
      {},
    )) as Array<{ slug: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.slug.startsWith('clients/') || r.slug.startsWith('people/')).toBe(true);
    }
  });

  test('resolve_slugs: hidden prefixes are not enumerable', async () => {
    const resolveSlugs = await op('resolve_slugs');
    const rows = (await resolveSlugs.handler(
      mkCtx(['clients/*']) as any,
      { partial: 'fund' },
    )) as string[];
    expect(rows.length).toBe(0);
  });

  test('get_links: edge into a hidden prefix is dropped', async () => {
    const getLinks = await op('get_links');
    const rows = (await getLinks.handler(
      mkCtx(['clients/*', 'people/*']) as any,
      { slug: 'clients/acme-example' },
    )) as Array<{ to_slug: string }>;
    const targets = rows.map(l => l.to_slug);
    expect(targets).toContain('people/alice-example');
    expect(targets).not.toContain('partenaires/fund-a');
  });

  test('get_backlinks: referrer in a hidden prefix is dropped', async () => {
    const getBacklinks = await op('get_backlinks');
    const rows = (await getBacklinks.handler(
      mkCtx(['clients/*']) as any,
      { slug: 'clients/acme-example' },
    )) as Array<{ from_slug: string }>;
    expect(rows.map(l => l.from_slug)).not.toContain('partenaires/fund-a');
  });

  test('traverse_graph: hidden nodes pruned, visible nodes keep only visible edges', async () => {
    const traverse = await op('traverse_graph');
    const nodes = (await traverse.handler(
      mkCtx(['clients/*', 'people/*']) as any,
      { slug: 'clients/acme-example', depth: 2 },
    )) as Array<{ slug: string; links: { to_slug: string }[] }>;
    for (const n of nodes) {
      expect(n.slug.startsWith('partenaires/')).toBe(false);
      for (const l of n.links) {
        expect(l.to_slug.startsWith('partenaires/')).toBe(false);
      }
    }
  });

  test('empty binding [] is fail-closed at the op layer too', async () => {
    const searchOp = await op('search');
    const rows = (await searchOp.handler(
      mkCtx([]) as any,
      { query: 'Zebra-marker' },
    )) as Array<{ slug: string }>;
    expect(rows.length).toBe(0);
  });
});
