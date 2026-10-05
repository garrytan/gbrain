import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { TimelineOpts, PageReadPolicy } from '../src/core/types.ts';

const getTimeline = operationsByName['get_timeline'];

function makeCtx(): OperationContext {
  const calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> = [];
  const engine = {
    getTimeline: async (slug: string, opts?: TimelineOpts & PageReadPolicy) => {
      calls.push({ slug, opts });
      return [];
    },
    // The empty read checks the page exists; it does here.
    getPage: async (slug: string) => ({ slug, source_id: 'alpha' }),
    // Remote callers resolve the private-pages config (no opt-out here).
    getConfig: async () => null,
    executeRaw: async () => [],
  };

  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['read'],
      sourceId: 'default',
      allowedSources: ['alpha', 'beta'],
    },
    __calls: calls,
  } as unknown as OperationContext & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> };
}

describe('get_timeline op', () => {
  test('declares date-window and limit params', () => {
    expect(getTimeline.params.after.type).toBe('string');
    expect(getTimeline.params.before.type).toBe('string');
    expect(getTimeline.params.since.type).toBe('string');
    expect(getTimeline.params.until.type).toBe('string');
    expect(getTimeline.params.limit.type).toBe('number');
  });

  test('threads after/before/limit with federated source scope', async () => {
    const ctx = makeCtx();
    await getTimeline.handler(ctx, {
      slug: 'people/alice-example',
      after: '2026-01-01',
      before: '2026-03-31',
      limit: 7,
    });

    expect((ctx as typeof ctx & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> }).__calls).toEqual([{
      slug: 'people/alice-example',
      opts: {
        sourceIds: ['alpha', 'beta'],
        excludePrivate: true,
        requireSafeChunks: true,
        takesHoldersAllowList: ['world'],
        after: '2026-01-01',
        before: '2026-03-31',
        limit: 7,
      },
    }]);
  });

  test('accepts since/until as aliases for after/before', async () => {
    const ctx = makeCtx();
    await getTimeline.handler(ctx, {
      slug: 'people/alice-example',
      since: '2026-04-01',
      until: '2026-04-30',
    });

    expect((ctx as typeof ctx & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> }).__calls[0]?.opts).toMatchObject({
      sourceIds: ['alpha', 'beta'],
      excludePrivate: true,
      requireSafeChunks: true,
      takesHoldersAllowList: ['world'],
      after: '2026-04-01',
      before: '2026-04-30',
    });
  });
});

/**
 * An empty timeline must not hide a missing page: an unknown slug throws
 * get_page's page_not_found, while a real page with no rows still reads [].
 * A page the caller may not see (private for an untrusted caller, or outside
 * its source scope) throws the byte-identical envelope a missing slug does,
 * so the error is no existence oracle.
 */
describe('get_timeline: unknown slug vs empty timeline (real engine)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
    const put = (slug: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'synthetic body', timeline: '', frontmatter }, { sourceId });
    await put('notes/with-events');
    await put('notes/no-events');
    await put('notes/private-page', { visibility: 'private' });
    await put('notes/soft-deleted');
    await put('notes/beta-only', {}, 'beta');
    await engine.addTimelineEntry('notes/with-events', { date: '2026-04-03', source: 'test', summary: 'public event' });
    await engine.addTimelineEntry('notes/private-page', { date: '2026-05-01', source: 'test', summary: 'private event' });
    await engine.addTimelineEntry('notes/beta-only', { date: '2026-06-01', source: 'test', summary: 'beta event' }, { sourceId: 'beta' });
    await engine.softDeletePage('notes/soft-deleted', { sourceId: 'default' });
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      ...overrides,
    } as unknown as OperationContext;
  }
  const federated = (allowedSources: string[]) =>
    ctxOf({ sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources } as never });

  async function summaries(ctx: OperationContext, p: Record<string, unknown>): Promise<string[]> {
    return ((await getTimeline.handler(ctx, p)) as Array<{ summary: string }>).map((e) => e.summary);
  }

  /** The serialized page_not_found envelope, with the slug masked so two misses compare. */
  async function missEnvelope(ctx: OperationContext, slug: string): Promise<string> {
    try {
      await getTimeline.handler(ctx, { slug });
    } catch (e) {
      if (!(e instanceof OperationError)) throw e;
      expect(e.code).toBe('page_not_found');
      return JSON.stringify(e).replaceAll(slug, '<slug>');
    }
    throw new Error(`expected page_not_found for ${slug}`);
  }

  test('an unknown slug throws page_not_found for local and remote callers', async () => {
    for (const ctx of [ctxOf({ remote: false }), ctxOf(), federated(['default'])]) {
      await expect(getTimeline.handler(ctx, { slug: 'notes/no-such-page' }))
        .rejects.toMatchObject({ code: 'page_not_found', message: 'Page not found: notes/no-such-page' });
    }
    await expect(getTimeline.handler(ctxOf(), { slug: 'notes/no-such-page', after: '2030-01-01' }))
      .rejects.toMatchObject({ code: 'page_not_found' });
  });

  test('a real page without rows in scope still reads []', async () => {
    for (const ctx of [ctxOf({ remote: false }), ctxOf()]) {
      expect(await summaries(ctx, { slug: 'notes/no-events' })).toEqual([]);
      expect(await summaries(ctx, { slug: 'notes/with-events', after: '2030-01-01' })).toEqual([]);
      // Soft-deleted pages count as existing: the read still returns their rows.
      expect(await summaries(ctx, { slug: 'notes/soft-deleted' })).toEqual([]);
    }
  });

  test('a real page with rows returns them', async () => {
    expect(await summaries(ctxOf(), { slug: 'notes/with-events' })).toEqual(['public event']);
    expect(await summaries(federated(['beta']), { slug: 'notes/beta-only' })).toEqual(['beta event']);
  });

  test('remote: a private or out-of-scope page throws exactly what a missing slug throws', async () => {
    const missing = await missEnvelope(ctxOf(), 'notes/no-such-page');
    expect(await missEnvelope(ctxOf(), 'notes/private-page')).toBe(missing);
    expect(await missEnvelope(ctxOf(), 'notes/beta-only')).toBe(missing);
    expect(await missEnvelope(federated(['default']), 'notes/beta-only'))
      .toBe(await missEnvelope(federated(['default']), 'notes/no-such-page'));
    // The trusted local caller still sees the private page's timeline.
    expect(await summaries(ctxOf({ remote: false }), { slug: 'notes/private-page' })).toEqual(['private event']);
  });

  test('a trusted local scoped miss names the source that holds the slug; a remote one does not', async () => {
    await expect(getTimeline.handler(ctxOf({ remote: false }), { slug: 'notes/beta-only' }))
      .rejects.toMatchObject({ code: 'page_not_found', suggestion: expect.stringContaining('--source beta') });
    expect(await missEnvelope(ctxOf(), 'notes/beta-only')).not.toContain('beta');
  });
});
