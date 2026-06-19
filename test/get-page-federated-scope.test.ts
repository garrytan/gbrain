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
  test('[alpha,beta] returns the in-grant beta→beta link', async () => {
    const links = (await get_links.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    expect(links.map(l => l.to_slug)).toContain('secret/beta-target');
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
    // origin page 'default/only-doc' is out of the [alpha,beta] grant → origin_slug nulled.
    expect(originLeakLink.origin_slug ?? null).toBeNull();
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

  test('D1: TRUSTED local CLI (remote=false) with a scalar scope keeps the cross-source view', async () => {
    // reconcileLinks / validators depend on this — local CLI sees cross-source links.
    const ctx = ctxOf({ remote: false, sourceId: 'beta', auth: undefined });
    const links = (await get_links.handler(ctx, { slug: 'secret/beta-doc' })) as any[];
    expect(links.map(l => l.to_slug)).toContain('default/only-doc'); // cross-source visible for trusted local
  });
});

describe('#2200 get_backlinks honors the grant and scopes BOTH endpoints (D4A)', () => {
  test('[alpha,beta] returns the in-grant beta→beta backlink', async () => {
    const back = (await get_backlinks.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' })) as any[];
    expect(back.map(l => l.from_slug)).toContain('secret/beta-target');
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
