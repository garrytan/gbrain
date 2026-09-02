/**
 * #1393 — get_page exact-match path honors the federated source grant.
 *
 * Pre-fix the exact path used scalar `ctx.sourceId` only:
 *   const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
 * A remote OAuth client with a federated `allowedSources` grant (and no single
 * ctx.sourceId) therefore got an UNSCOPED exact lookup — a cross-source read of
 * any page by slug. The fuzzy path was already scoped (#1436); this closes the
 * exact path by (a) routing it through sourceScopeOpts and (b) teaching
 * engine.getPage to honor a `sourceIds[]` array (both engines).
 *
 * #2200 — the SAME class on the secondary-fetch read ops. get_page resolves the
 * page under the grant but fetched tags against 'default' (wrong source for a
 * non-default page); get_tags / get_links / get_backlinks / get_timeline didn't
 * route the federated grant to the engine at all (functionality gap + a
 * cross-source fallback/foreign-endpoint leak). These tests cover:
 *   - get_page tags resolved against the concrete page's source
 *   - the 4 standalone ops honoring a federated grant
 *   - isolation (out-of-grant slug → empty, never the 'default' page's data)
 *   - the foreign-endpoint link leak (D4A: both endpoints scoped)
 *   - same-slug-across-sources union (D3A)
 *   - engine getTags/getLinks/getBacklinks/getTimeline sourceIds[] precedence
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;
const get_tags = operations.find(o => o.name === 'get_tags')!;
const get_links = operations.find(o => o.name === 'get_links')!;
const get_backlinks = operations.find(o => o.name === 'get_backlinks')!;
const get_timeline = operations.find(o => o.name === 'get_timeline')!;
const get_chunks = operations.find(o => o.name === 'get_chunks')!;
const get_raw_data = operations.find(o => o.name === 'get_raw_data')!;
const get_versions = operations.find(o => o.name === 'get_versions')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  // Distinct slugs per source so an exact lookup can leak across the boundary.
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Beta secret', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('shared/alpha-doc', {
    type: 'note', title: 'Alpha doc', compiled_truth: 'alpha content', frontmatter: {},
  }, { sourceId: 'alpha' });
  // --- #4275 slug-alias redirect fixtures (retired dedup/migration slugs) ---
  await engine.executeRaw(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ('alpha', 'legacy/alpha-doc', 'shared/alpha-doc', 'test alias'),
            ('beta', 'legacy/beta-doc', 'secret/beta-doc', 'test alias'),
            ('beta', 'legacy/priv-doc', 'secret/priv-doc', 'test alias')`,
  );
  await engine.putPage('secret/priv-doc', {
    type: 'note', title: 'Private canonical', compiled_truth: 'private body',
    frontmatter: { visibility: 'private' },
  }, { sourceId: 'beta' });

  // --- #2200 secondary-fetch fixtures ---
  // beta page's own tags.
  await engine.addTag('secret/beta-doc', 'beta-confidential', { sourceId: 'beta' });
  await engine.addTag('secret/beta-doc', 'beta-tag', { sourceId: 'beta' });
  // A same-slug page in 'default' with DIFFERENT tags — the cross-source bleed
  // guard. A federated read scoped to [alpha,beta] must NEVER surface these.
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Default decoy', compiled_truth: 'default content', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.addTag('secret/beta-doc', 'default-secret-tag', { sourceId: 'default' });
  await engine.upsertChunks('secret/beta-doc', [{
    chunk_index: 0, chunk_text: 'beta chunk', chunk_source: 'compiled_truth', token_count: 2,
  }], { sourceId: 'beta' });
  await engine.upsertChunks('secret/beta-doc', [{
    chunk_index: 0, chunk_text: 'default chunk', chunk_source: 'compiled_truth', token_count: 2,
  }], { sourceId: 'default' });
  await engine.putRawData('secret/beta-doc', 'crm', { owner: 'beta' }, { sourceId: 'beta' });
  await engine.putRawData('secret/beta-doc', 'crm', { owner: 'default' }, { sourceId: 'default' });
  await engine.createVersion('secret/beta-doc', { sourceId: 'beta' });
  await engine.createVersion('secret/beta-doc', { sourceId: 'default' });
  // Link endpoints. NOTE (Codex #7): addLink defaults BOTH endpoints to 'default'
  // unless given {fromSourceId,toSourceId} — pass them or the beta edges won't seed.
  await engine.putPage('secret/beta-target', {
    type: 'note', title: 'Beta target', compiled_truth: 'beta target', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('default/only-doc', {
    type: 'note', title: 'Default only', compiled_truth: 'default only', frontmatter: {},
  }, { sourceId: 'default' });
  // In-grant outgoing link beta→beta (must show for [alpha,beta]).
  await engine.addLink('secret/beta-doc', 'secret/beta-target', 'in-grant ctx', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'beta' });
  // Far-endpoint-leak outgoing link beta→default (must NOT show for [alpha,beta] — D4A).
  await engine.addLink('secret/beta-doc', 'default/only-doc', 'LEAK ctx', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'default' });
  // In-grant backlink beta→beta (referrer beta-target → secret/beta-doc).
  await engine.addLink('secret/beta-target', 'secret/beta-doc', 'in-grant back', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'beta', toSourceId: 'beta' });
  // Far-endpoint-leak backlink: referrer in 'default' → must NOT show for [alpha,beta].
  await engine.addLink('default/only-doc', 'secret/beta-doc', 'LEAK back', 'cites', 'markdown', undefined, undefined, { fromSourceId: 'default', toSourceId: 'beta' });
  // Origin-leak guard (F1): both endpoints in-grant (beta→beta) but the AUTHORING
  // (origin) page is out-of-grant ('default'). origin_slug must NOT leak that slug.
  await engine.addLink('secret/beta-doc', 'secret/beta-target', 'origin-leak ctx', 'mentions', 'frontmatter', 'default/only-doc', 'related', { fromSourceId: 'beta', toSourceId: 'beta', originSourceId: 'default' });
  // Timeline entry on the beta page.
  await engine.addTimelineEntry('secret/beta-doc', {
    date: '2026-01-01', source: 'test', summary: 'beta event', detail: 'beta detail',
  }, { sourceId: 'beta' });
  // D3A union: same slug in BOTH alpha and beta with distinct tags.
  await engine.putPage('shared/dup', {
    type: 'note', title: 'Dup alpha', compiled_truth: 'a', frontmatter: {},
  }, { sourceId: 'alpha' });
  await engine.addTag('shared/dup', 'alpha-only', { sourceId: 'alpha' });
  await engine.putPage('shared/dup', {
    type: 'note', title: 'Dup beta', compiled_truth: 'b', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.addTag('shared/dup', 'beta-only', { sourceId: 'beta' });
});

function remoteCtx(allowedSources: string[]): OperationContext {
  // Federated remote client: no scalar ctx.sourceId, grant via allowedSources.
  return ctxOf({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: [], allowedSources } as any });
}

describe('engine.getPage honors sourceIds[] (federated grant)', () => {
  test('sourceIds[] matching the page returns it', async () => {
    const page = await engine.getPage('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(page?.title).toBe('Beta secret');
  });

  test('sourceIds[] NOT containing the page returns null', async () => {
    const page = await engine.getPage('secret/beta-doc', { sourceIds: ['alpha'] });
    expect(page).toBeNull();
  });

  test('sourceIds[] takes precedence over scalar sourceId', async () => {
    // scalar says alpha, array says beta-only — array wins, page found.
    const page = await engine.getPage('secret/beta-doc', { sourceId: 'alpha', sourceIds: ['beta'] });
    expect(page?.title).toBe('Beta secret');
  });
});

// ---------------------------------------------------------------------------
// #3931 — get_page returns a nondeterministic row when a slug is shadowed
// across federated sources. `shared/dup` (seeded above) exists in BOTH
// 'alpha' and 'beta' — the ambiguous case. Without an anchor-aware ORDER BY,
// LIMIT 1 either returns planner-order-dependent rows (pre-fix) or always
// prefers a hardcoded 'default' / lexical-first source regardless of which
// source the caller actually resolved to (the gap left after #4219, which
// fixed pure nondeterminism but hardcoded the anchor to 'default').
// ---------------------------------------------------------------------------
describe('#3931 engine.getPage same-slug shadowing across federated sources is deterministic', () => {
  test('anchor source (sourceIds[0]) wins even when it is not lexically first', async () => {
    // 'alpha' < 'beta' lexically, so a lexical-only tiebreak would always
    // prefer alpha regardless of caller intent. Anchor-first must override
    // that when the caller's own resolved source (position 0) is beta.
    const page = await engine.getPage('shared/dup', { sourceIds: ['beta', 'alpha'] });
    expect(page?.title).toBe('Dup beta');
  });

  test('re-anchoring the same slug flips the winner', async () => {
    const asAlphaAnchor = await engine.getPage('shared/dup', { sourceIds: ['alpha', 'beta'] });
    const asBetaAnchor = await engine.getPage('shared/dup', { sourceIds: ['beta', 'alpha'] });
    expect(asAlphaAnchor?.title).toBe('Dup alpha');
    expect(asBetaAnchor?.title).toBe('Dup beta');
  });

  test('anchor absent from the candidate rows falls back to lexical source_id order', async () => {
    // 'gamma' is a real granted source but owns no 'shared/dup' page — the
    // anchor itself has no matching row, so the tiebreak falls through to
    // plain `source_id ASC` among the sources that DO have the page.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('gamma', 'gamma', '/tmp/gamma') ON CONFLICT (id) DO NOTHING`,
    );
    const page = await engine.getPage('shared/dup', { sourceIds: ['gamma', 'beta', 'alpha'] });
    expect(page?.title).toBe('Dup alpha'); // 'alpha' < 'beta' lexically
  });

  test('repeated calls with the same scope are stable, not planner-order luck', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => engine.getPage('shared/dup', { sourceIds: ['beta', 'alpha'] })),
    );
    for (const page of results) {
      expect(page?.title).toBe('Dup beta');
    }
  });
});

describe('get_page handler closes the cross-source exact-read leak', () => {
  test('remote client granted only [alpha] CANNOT read a beta-only slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    // Pre-fix this returned the beta page (leak). Now it is scoped out → 404.
    await expect(get_page.handler(ctx, { slug: 'secret/beta-doc' })).rejects.toBeInstanceOf(OperationError);
  });

  test('remote client granted [alpha, beta] CAN read the beta slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha', 'beta'] } as any });
    const page: any = await get_page.handler(ctx, { slug: 'secret/beta-doc' });
    expect(page.title).toBe('Beta secret');
  });

  test('remote client granted only [alpha] CAN read its own alpha slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    const page: any = await get_page.handler(ctx, { slug: 'shared/alpha-doc' });
    expect(page.title).toBe('Alpha doc');
  });
});

// ---------------------------------------------------------------------------
// #4275 — get_page follows slug aliases inside the caller's source scope.
// resolveSlugWithAlias documents get_page as a consumer, but the handler
// never called it: direct reads of retired dedup/migration slugs 404ed while
// search and wikilinks followed the redirect.
// ---------------------------------------------------------------------------
describe('#4275 get_page follows slug aliases inside the caller source scope', () => {
  test('single-source read of a retired slug returns the active canonical page', async () => {
    const page: any = await get_page.handler(ctxOf({ remote: false, sourceId: 'alpha' }), {
      slug: 'legacy/alpha-doc',
    });
    expect(page.slug).toBe('shared/alpha-doc');
    expect(page.resolved_slug).toBe('shared/alpha-doc');
    expect(page.title).toBe('Alpha doc');
  });

  test('federated grant cannot resolve an alias outside its allowed sources', async () => {
    await expect(
      get_page.handler(remoteCtx(['alpha']), { slug: 'legacy/beta-doc' }),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('federated grant resolves an in-scope alias', async () => {
    const page: any = await get_page.handler(remoteCtx(['alpha', 'beta']), {
      slug: 'legacy/beta-doc',
    });
    expect(page.slug).toBe('secret/beta-doc');
    expect(page.resolved_slug).toBe('secret/beta-doc');
    expect(page.title).toBe('Beta secret');
  });

  test('unscoped trusted read follows aliases across every source (no default-only under-scope)', async () => {
    const page: any = await get_page.handler(ctxOf({ remote: false, sourceId: undefined }), {
      slug: 'legacy/beta-doc',
    });
    expect(page.slug).toBe('secret/beta-doc');
    expect(page.resolved_slug).toBe('secret/beta-doc');
  });

  test('a live page at the requested slug wins over the alias (redirect only on miss)', async () => {
    await engine.putPage('legacy/alpha-doc', {
      type: 'note', title: 'Still live at legacy slug', compiled_truth: 'live', frontmatter: {},
    }, { sourceId: 'alpha' });
    const page: any = await get_page.handler(ctxOf({ remote: false, sourceId: 'alpha' }), {
      slug: 'legacy/alpha-doc',
    });
    expect(page.slug).toBe('legacy/alpha-doc');
    expect(page.title).toBe('Still live at legacy slug');
    expect(page.resolved_slug).toBeUndefined();
  });

  test('#4352 composition: a private canonical page behaves like a missing one for remote callers', async () => {
    await expect(
      get_page.handler(remoteCtx(['beta']), { slug: 'legacy/priv-doc' }),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('ship-review: the alias hop reads the canonical in the OWNING source, not the anchor source', async () => {
    // beta owns legacy/beta-doc -> secret/beta-doc; alpha holds an UNRELATED
    // live page at the canonical slug. A federated grant anchors getPage on
    // sourceIds[0] (alpha), so a scope-wide read of the canonical returned
    // alpha's decoy as if it were the alias target.
    await engine.putPage('secret/beta-doc', {
      type: 'note', title: 'Alpha decoy at the canonical slug', compiled_truth: 'alpha decoy', frontmatter: {},
    }, { sourceId: 'alpha' });

    const federated: any = await get_page.handler(remoteCtx(['alpha', 'beta']), { slug: 'legacy/beta-doc' });
    expect(federated.source_id).toBe('beta');
    expect(federated.title).toBe('Beta secret');
    expect(federated.resolved_slug).toBe('secret/beta-doc');

    // Trusted unscoped read: same owner pin (the unscoped getPage tiebreak is
    // source_id ASC, which would also have picked alpha's decoy).
    const local: any = await get_page.handler(ctxOf({ remote: false, sourceId: undefined }), { slug: 'legacy/beta-doc' });
    expect(local.source_id).toBe('beta');
    expect(local.title).toBe('Beta secret');

    // An exact read of the canonical slug itself is untouched by the hop:
    // the anchor-source preference still applies to a direct lookup.
    const direct: any = await get_page.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' });
    expect(direct.source_id).toBe('alpha');
    expect(direct.resolved_slug).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2200 — secondary-fetch read ops honor the federated grant
// ---------------------------------------------------------------------------

describe('#2200 get_page resolves tags against the concrete page source', () => {
  test('federated [alpha,beta] read of the beta page returns BETA tags, not default decoy', async () => {
    const page: any = await get_page.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' });
    expect(page.title).toBe('Beta secret');
    expect(page.tags.sort()).toEqual(['beta-confidential', 'beta-tag']);
    expect(page.tags).not.toContain('default-secret-tag');
  });
});

describe('#2200 get_tags honors the federated grant', () => {
  test('[alpha,beta] returns the beta page tags', async () => {
    const tags = await get_tags.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' });
    expect((tags as string[]).sort()).toEqual(['beta-confidential', 'beta-tag']);
  });

  test('[alpha] only → empty, never the default decoy tags (isolation)', async () => {
    const tags = await get_tags.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' });
    expect(tags).toEqual([]);
  });

  test('D3A same-slug-across-sources → union of tags', async () => {
    const tags = await get_tags.handler(remoteCtx(['alpha', 'beta']), { slug: 'shared/dup' });
    expect((tags as string[]).sort()).toEqual(['alpha-only', 'beta-only']);
  });
});

describe('#2200 get_links honors the grant and scopes BOTH endpoints (D4A)', () => {
  test('[alpha,beta] returns the in-grant beta→beta link with exact endpoint identity', async () => {
    const links = (await get_links.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    const target = links.find(l => l.to_slug === 'secret/beta-target');
    expect(target).toBeDefined();
    expect(target).toMatchObject({
      from_source_id: 'beta',
      from_slug: 'secret/beta-doc',
      to_source_id: 'beta',
      to_slug: 'secret/beta-target',
    });
  });

  test('[alpha,beta] does NOT leak the beta→default far-endpoint link', async () => {
    const links = (await get_links.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    expect(links.map(l => l.to_slug)).not.toContain('default/only-doc');
    expect(links.map(l => l.context)).not.toContain('LEAK ctx');
  });

  test('[alpha] only → no beta links (isolation)', async () => {
    const links = (await get_links.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' })) as any[];
    expect(links).toEqual([]);
  });

  test('F1: in-grant link authored by an out-of-grant origin does NOT leak origin_slug', async () => {
    const links = (await get_links.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    const originLeakLink = links.find(l => l.link_type === 'mentions' && l.to_slug === 'secret/beta-target');
    expect(originLeakLink).toBeDefined();
    // origin page 'default/only-doc' is out of the [alpha,beta] grant → origin identity nulled.
    expect(originLeakLink.origin_slug ?? null).toBeNull();
    expect(originLeakLink.origin_source_id ?? null).toBeNull();
    expect(links.map(l => l.origin_slug)).not.toContain('default/only-doc');
  });

  test('D1: UNTRUSTED remote with a scalar source scope is promoted to all-endpoint scoping (no far-endpoint leak)', async () => {
    // legacy/pre-federated token: remote, scalar ctx.sourceId='beta', NO allowedSources.
    const ctx = ctxOf({ remote: true, sourceId: 'beta', auth: undefined });
    const links = (await get_links.handler(ctx, { slug: 'secret/beta-doc' })) as any[];
    expect(links.map(l => l.to_slug)).toContain('secret/beta-target');
    expect(links.map(l => l.to_slug)).not.toContain('default/only-doc'); // far endpoint out of scope
    expect(links.map(l => l.origin_slug)).not.toContain('default/only-doc'); // origin too
  });

  test('D1: TRUSTED local CLI scalar scope keeps cross-source view and identifies both endpoints', async () => {
    // reconcileLinks / validators depend on this — local CLI sees cross-source links.
    const ctx = ctxOf({ remote: false, sourceId: 'beta', auth: undefined });
    const links = (await get_links.handler(ctx, { slug: 'secret/beta-doc' })) as any[];
    const crossSource = links.find(l => l.to_slug === 'default/only-doc');
    expect(crossSource).toMatchObject({
      from_source_id: 'beta',
      from_slug: 'secret/beta-doc',
      to_source_id: 'default',
      to_slug: 'default/only-doc',
    });
  });
});

describe('#2200 get_backlinks honors the grant and scopes BOTH endpoints (D4A)', () => {
  test('[alpha,beta] returns the in-grant beta→beta backlink with exact endpoint identity', async () => {
    const back = (await get_backlinks.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    const referrer = back.find(l => l.from_slug === 'secret/beta-target');
    expect(referrer).toMatchObject({
      from_source_id: 'beta',
      from_slug: 'secret/beta-target',
      to_source_id: 'beta',
      to_slug: 'secret/beta-doc',
    });
  });

  test('[alpha,beta] does NOT leak the default→beta far-referrer backlink', async () => {
    const back = (await get_backlinks.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    expect(back.map(l => l.from_slug)).not.toContain('default/only-doc');
    expect(back.map(l => l.context)).not.toContain('LEAK back');
  });

  test('[alpha] only → no beta backlinks (isolation)', async () => {
    const back = (await get_backlinks.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' })) as any[];
    expect(back).toEqual([]);
  });
});

describe('#2200 get_timeline honors the federated grant', () => {
  test('[alpha,beta] returns the beta timeline entry', async () => {
    const tl = (await get_timeline.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    expect(tl.map(e => e.summary)).toContain('beta event');
  });

  test('[alpha] only → empty (isolation)', async () => {
    const tl = (await get_timeline.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' })) as any[];
    expect(tl).toEqual([]);
  });
});

describe('#2200 residual by-slug reads honor the federated grant', () => {
  test('get_chunks returns only in-grant chunks', async () => {
    const hit = await get_chunks.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' }) as any[];
    expect(hit.map(c => c.chunk_text)).toEqual(['beta chunk']);
    expect(await get_chunks.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' })).toEqual([]);
  });

  test('get_raw_data returns only in-grant rows', async () => {
    const hit = await get_raw_data.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc', source: 'crm' }) as any[];
    expect(hit.map(r => r.data.owner)).toEqual(['beta']);
    expect(await get_raw_data.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc', source: 'crm' })).toEqual([]);
  });

  test('get_versions returns only in-grant snapshots', async () => {
    const hit = await get_versions.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' }) as any[];
    expect(hit.map(v => v.compiled_truth)).toEqual(['beta-only content']);
    expect(await get_versions.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' })).toEqual([]);
  });
});

describe('#2200 engine secondary-fetch methods honor sourceIds[]', () => {
  test('getTags: sourceIds[] matching → returns; excluding → empty; union on collision', async () => {
    expect((await engine.getTags('secret/beta-doc', { sourceIds: ['alpha', 'beta'] })).sort())
      .toEqual(['beta-confidential', 'beta-tag']);
    expect(await engine.getTags('secret/beta-doc', { sourceIds: ['alpha'] })).toEqual([]);
    expect((await engine.getTags('shared/dup', { sourceIds: ['alpha', 'beta'] })).sort())
      .toEqual(['alpha-only', 'beta-only']);
  });

  test('getTags: sourceIds[] takes precedence over scalar sourceId', async () => {
    // scalar says default (decoy), array says beta — array wins.
    const tags = await engine.getTags('secret/beta-doc', { sourceId: 'default', sourceIds: ['beta'] });
    expect(tags.sort()).toEqual(['beta-confidential', 'beta-tag']);
  });

  test('engine contract: empty sourceIds[] is NOT a federated scope — falls through to scalar (length>0 guard)', async () => {
    // sourceScopeOpts never emits [] (it treats an empty grant as no-scope), but
    // the engine methods are public: the `sourceIds && length > 0` guard must NOT
    // treat [] as "match nothing" (ANY('{}')) NOR widen scope. It falls to scalar,
    // here defaulting to 'default'. Pins the guard so a future `>= 0` regression fails.
    // getTags scalar fallback defaults to 'default' → the decoy tag.
    expect(await engine.getTags('secret/beta-doc', { sourceIds: [] })).toEqual(['default-secret-tag']);
    // getTimeline's scalar branch with no sourceId is UNSCOPED (cross-source,
    // pre-v0.31.8 semantics) — so [] yields the cross-source view, here the beta
    // entry. The point: [] is treated as "no federated scope", never as ANY('{}').
    const tl = await engine.getTimeline('secret/beta-doc', { sourceIds: [] });
    expect(tl.map(e => e.summary)).toEqual(['beta event']);
  });

  test('getLinks: sourceIds[] scopes both endpoints (no far-endpoint leak); precedence over scalar', async () => {
    const links = await engine.getLinks('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(links.map(l => l.to_slug)).toContain('secret/beta-target');
    expect(links.map(l => l.to_slug)).not.toContain('default/only-doc');
    expect(await engine.getLinks('secret/beta-doc', { sourceIds: ['alpha'] })).toEqual([]);
    // array beats scalar: scalar 'default' would surface the leak link; array ['beta'] must not.
    const prec = await engine.getLinks('secret/beta-doc', { sourceId: 'default', sourceIds: ['beta'] });
    expect([...new Set(prec.map(l => l.to_slug))]).toEqual(['secret/beta-target']); // only in-grant targets (multiple link_types collapse)
    expect(prec.map(l => l.to_slug)).not.toContain('default/only-doc');
  });

  test('getBacklinks: sourceIds[] scopes both endpoints; precedence over scalar', async () => {
    const back = await engine.getBacklinks('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(back.map(l => l.from_slug)).toContain('secret/beta-target');
    expect(back.map(l => l.from_slug)).not.toContain('default/only-doc');
    const prec = await engine.getBacklinks('secret/beta-doc', { sourceId: 'default', sourceIds: ['beta'] });
    expect(prec.map(l => l.from_slug)).toEqual(['secret/beta-target']);
  });

  test('getTimeline: sourceIds[] matching → returns; excluding → empty; precedence over scalar', async () => {
    const hit = await engine.getTimeline('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(hit.map(e => e.summary)).toContain('beta event');
    expect(await engine.getTimeline('secret/beta-doc', { sourceIds: ['alpha'] })).toEqual([]);
    // array beats scalar: scalar 'default' page has no timeline entry; array ['beta'] returns the beta event.
    const prec = await engine.getTimeline('secret/beta-doc', { sourceId: 'default', sourceIds: ['beta'] });
    expect(prec.map(e => e.summary)).toContain('beta event');
  });

  test('getTimeline: date-window filters still correct after the fragment refactor (D5A regression guard)', async () => {
    await engine.addTimelineEntry('secret/beta-doc', { date: '2026-06-01', source: 'test', summary: 'june event', detail: 'd' }, { sourceId: 'beta' });
    const windowed = await engine.getTimeline('secret/beta-doc', { sourceIds: ['beta'], after: '2026-03-01', before: '2026-12-31' });
    expect(windowed.map(e => e.summary)).toEqual(['june event']);
  });
});

// ---------------------------------------------------------------------------
// #2555 — get_chunks honors the federated source grant (same class as #1393/
// #2200, chunk read path). Pre-fix the op used the pre-#2200 scalar pattern
// and engine.getChunks had no sourceIds[] support: a federated client that
// could read a page via get_page got [] from get_chunks.
// ---------------------------------------------------------------------------
describe('#2555 get_chunks federated scope', () => {
  const get_chunks = operations.find(o => o.name === 'get_chunks')!;

  beforeEach(async () => {
    await engine.upsertChunks('secret/beta-doc', [
      { chunk_index: 0, chunk_text: 'beta chunk zero', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'beta chunk one', chunk_source: 'compiled_truth' },
    ], { sourceId: 'beta' });
    // Same-slug decoy chunks in 'default' — the cross-source bleed guard.
    await engine.upsertChunks('secret/beta-doc', [
      { chunk_index: 0, chunk_text: 'default decoy chunk', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
  });

  test('op: federated grant including the page source returns its chunks (the #2555 repro)', async () => {
    const ctx = ctxOf({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha', 'beta'] } as any });
    const chunks = await get_chunks.handler(ctx, { slug: 'secret/beta-doc' }) as Array<{ chunk_text: string }>;
    expect(chunks.map(c => c.chunk_text)).toEqual(['beta chunk zero', 'beta chunk one']);
  });

  test('op: grant excluding the page source stays empty — never falls through to default', async () => {
    const ctx = ctxOf({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    const chunks = await get_chunks.handler(ctx, { slug: 'secret/beta-doc' }) as Array<{ chunk_text: string }>;
    expect(chunks).toEqual([]);
  });

  test('op: no grant + default floor sees only the default decoy, never beta chunks', async () => {
    const ctx = ctxOf({ remote: true, sourceId: 'default', auth: undefined });
    const chunks = await get_chunks.handler(ctx, { slug: 'secret/beta-doc' }) as Array<{ chunk_text: string }>;
    expect(chunks.map(c => c.chunk_text)).toEqual(['default decoy chunk']);
  });

  test('engine: sourceIds[] precedence over scalar; trimmed SELECT keeps the Chunk shape', async () => {
    // array beats scalar: scalar 'default' would return the decoy; array ['beta'] must win.
    const prec = await engine.getChunks('secret/beta-doc', { sourceId: 'default', sourceIds: ['beta'] });
    expect(prec.map(c => c.chunk_text)).toEqual(['beta chunk zero', 'beta chunk one']);
    // #2544 trim: embedding is deliberately not selected (rowToChunk discards
    // it here anyway) and the rest of the Chunk shape survives.
    expect(prec[0].embedding).toBeNull();
    expect(prec[0].chunk_index).toBe(0);
    expect(prec[0].chunk_source).toBe('compiled_truth');
    // Unset opts keep the historical 'default' floor (importCodeFile contract).
    const def = await engine.getChunks('secret/beta-doc');
    expect(def.map(c => c.chunk_text)).toEqual(['default decoy chunk']);
  });

  test('#2544 structural pin: getChunks never SELECTs cc.* and fetches cc.embedding only behind includeEmbedding', async () => {
    // The behavioral assertion above is vacuous for the trim itself —
    // rowToChunk hard-nulls embedding regardless of the SELECT. This pin
    // exists because a master merge once silently restored `SELECT cc.*`
    // while the doc comment kept claiming the trim: assert the SELECT shape
    // at the source level for BOTH engines.
    //
    // The vector column is not forbidden outright anymore: importCodeFile's
    // embedding-reuse cache CONSUMES it (embed-reuse.ts), opted in via
    // `includeEmbedding`. The invariant is unchanged in spirit and stricter
    // in letter: no unconditional vector fetch, and the opt-in path must
    // exist — a half-revert that strands the flag fails too.
    const { readFileSync } = await import('fs');
    for (const enginePath of ['src/core/postgres-engine.ts', 'src/core/pglite-engine.ts']) {
      const src = readFileSync(new URL(`../${enginePath}`, import.meta.url), 'utf-8');
      const start = src.indexOf('async getChunks(slug');
      expect(start).toBeGreaterThan(0);
      // The method's own close (`\n  }` at 2-space indent) — an inline
      // `async (tx) =>` callback must not truncate the body, and the NEXT
      // method (e.g. buildStaleChunkWhere's `cc.embedding IS NULL` WHERE
      // predicate) must not leak in. Strip line comments: the pin targets
      // the SQL, not prose that may cite the anti-pattern.
      const end = src.indexOf('\n  }\n', start + 10);
      const body = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
      expect(body, `${enginePath} getChunks must not SELECT cc.*`).not.toContain('cc.*');
      // Every non-vector field rowToChunk reads MUST be selected — omitting
      // one silently degrades round-trips (embed.ts getChunks→upsertChunks
      // rewrote image chunks as text when cc.modality was dropped).
      for (const col of ['chunk_text', 'chunk_source', 'model', 'token_count', 'embedded_at',
        'language', 'symbol_name', 'symbol_type', 'start_line', 'end_line',
        'parent_symbol_path', 'doc_comment', 'symbol_name_qualified', 'modality']) {
        expect(body, `${enginePath} getChunks must select cc.${col}`).toContain(`cc.${col}`);
      }
      // Two references to the vector column are legitimate; everything else is
      // the #2544 egress regression coming back.
      //   1. `(cc.<active column> IS NULL) AS embedding_is_null` — a cheap
      //      boolean, no vector egress (a schema rebuild NULLs vectors without
      //      touching embedded_at, and the per-slug embed filter needs that
      //      truth). S2: the column is the registry-ACTIVE one (resolved via
      //      activeEmbeddingColId), not the literal legacy `embedding` — a
      //      registry-routed brain's truth lives in the active column.
      //   2. the `includeEmbedding` opt-in — importCodeFile's reuse cache
      //      CONSUMES the vectors (see embed-reuse.ts), and #2544 silently made
      //      that cache a no-op by dropping the column unconditionally. It too
      //      selects the ACTIVE column (aliased AS embedding) so a reused
      //      vector matches the column upsertChunks writes.
      // Strip (1), then keep forbidding any bare legacy `cc.embedding` use,
      // require every surviving vector select to be gated by (2), and require
      // the gate to still exist so a half-revert stranding the flag also fails.
      const nullBooleanShape = /\(cc\..*? IS NULL\) AS embedding_is_null/g;
      const withoutNullBoolean = body.replace(nullBooleanShape, '');
      expect(withoutNullBoolean).not.toMatch(/cc\.embedding\b/);
      expect(body).toMatch(/\(cc\..*? IS NULL\) AS embedding_is_null/);
      expect(body, `${enginePath} getChunks embedding_is_null must key on the registry-active column`).toContain('activeEmbeddingColId');
      const vectorLines = withoutNullBoolean.split('\n').filter((l) => / AS embedding\b/.test(l));
      expect(vectorLines.length, `${enginePath} getChunks must keep the includeEmbedding opt-in`).toBeGreaterThan(0);
      for (const line of vectorLines) {
        expect(line, `${enginePath} getChunks must gate the vector select behind includeEmbedding`).toMatch(/includeEmbedding \?/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// #4275 ship-review follow-ups — the alias hop's scope and precedence.
//   - the trusted UNSCOPED hop consulted listAllSources({includeArchived:true})
//     while archived sources are excluded everywhere else in the ladder; it
//     now consults live sources only, unless include_deleted asks for
//     retired material;
//   - include_deleted returns the soft-deleted shell at the requested slug
//     (restore workflows need the shell, not a redirect);
//   - alias resolution runs BEFORE fuzzy (the alias table is authoritative);
//   - sourceIds[] (federated grant) beats the scalar ctx.sourceId in the
//     alias scope, exactly as it does for the exact read.
// ---------------------------------------------------------------------------
describe('#4275 alias hop scope: archived sources, include_deleted, fuzzy precedence, grant precedence', () => {
  async function seedArchivedGamma() {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, archived) VALUES ('gamma', 'gamma', '/tmp/gamma', true) ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('shared/gamma-doc', {
      type: 'note', title: 'Gamma doc', compiled_truth: 'gamma content', frontmatter: {},
    }, { sourceId: 'gamma' });
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
       VALUES ('gamma', 'legacy/gamma-doc', 'shared/gamma-doc', 'archived alias')`,
    );
  }

  test('trusted unscoped read does NOT follow an alias that lives only in an ARCHIVED source', async () => {
    await seedArchivedGamma();
    await expect(
      get_page.handler(ctxOf({ remote: false, sourceId: undefined }), { slug: 'legacy/gamma-doc' }),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('include_deleted opts the archived source alias rows back in (retired material was asked for)', async () => {
    await seedArchivedGamma();
    const page: any = await get_page.handler(ctxOf({ remote: false, sourceId: undefined }), {
      slug: 'legacy/gamma-doc', include_deleted: true,
    });
    expect(page.slug).toBe('shared/gamma-doc');
    expect(page.resolved_slug).toBe('shared/gamma-doc');
  });

  test('include_deleted returns the soft-deleted shell at the requested slug — no redirect', async () => {
    await engine.putPage('legacy/alpha-doc', {
      type: 'note', title: 'Retired shell', compiled_truth: 'old body', frontmatter: {},
    }, { sourceId: 'alpha' });
    await engine.softDeletePage('legacy/alpha-doc', { sourceId: 'alpha' });

    const shell: any = await get_page.handler(ctxOf({ remote: false, sourceId: 'alpha' }), {
      slug: 'legacy/alpha-doc', include_deleted: true,
    });
    expect(shell.slug).toBe('legacy/alpha-doc');
    expect(shell.title).toBe('Retired shell');
    expect(shell.deleted_at).not.toBeNull();
    expect(shell.resolved_slug).toBeUndefined();

    // Without include_deleted the retired slug is a miss → the alias redirect wins.
    const redirected: any = await get_page.handler(ctxOf({ remote: false, sourceId: 'alpha' }), {
      slug: 'legacy/alpha-doc',
    });
    expect(redirected.slug).toBe('shared/alpha-doc');
    expect(redirected.resolved_slug).toBe('shared/alpha-doc');
  });

  test('alias resolution beats fuzzy: fuzzy:true + a registered alias returns the canonical page', async () => {
    // A second alpha page whose slug CONTAINS the requested slug — the fuzzy
    // probe (slug substring match) would find it and either return it or
    // report ambiguous_slug. The alias table is authoritative and runs first,
    // so the canonical page wins deterministically.
    await engine.putPage('archive/legacy/alpha-doc-v1', {
      type: 'note', title: 'Fuzzy decoy', compiled_truth: 'decoy', frontmatter: {},
    }, { sourceId: 'alpha' });
    const page: any = await get_page.handler(ctxOf({ remote: false, sourceId: 'alpha' }), {
      slug: 'legacy/alpha-doc', fuzzy: true,
    });
    expect(page.slug).toBe('shared/alpha-doc');
    expect(page.resolved_slug).toBe('shared/alpha-doc');
    expect(page.title).toBe('Alpha doc');
  });

  test('sourceIds[] (federated grant) beats the scalar ctx.sourceId in the alias scope', async () => {
    // Scalar says alpha, the grant says beta: the grant wins, so the beta
    // alias resolves and the alpha alias behaves like a missing page.
    const ctx = ctxOf({
      remote: true, sourceId: 'alpha',
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['beta'] } as any,
    });
    const page: any = await get_page.handler(ctx, { slug: 'legacy/beta-doc' });
    expect(page.slug).toBe('secret/beta-doc');
    expect(page.resolved_slug).toBe('secret/beta-doc');
    await expect(
      get_page.handler(ctx, { slug: 'legacy/alpha-doc' }),
    ).rejects.toBeInstanceOf(OperationError);
  });
});
