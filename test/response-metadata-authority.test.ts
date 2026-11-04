import { afterEach, expect, test } from 'bun:test';
import { buildOperationContext, dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/ops/contract.ts';
import { effectiveReadSourceId } from '../src/core/ops/request-state.ts';

const engine = { getConfig: async () => null, executeRaw: async () => [] } as unknown as OperationContext['engine'];
const opts: DispatchOpts = { remote: false, sourceId: 'transport-default', config: { engine: 'postgres' },
  auth: { token: 'synthetic-token', clientId: 'synthetic-client', scopes: ['read', 'write'], sourceId: 'alpha' } };
const added: Operation[] = [];
function register(handler: Operation['handler'], mutating = false, params: Operation['params'] = {}): string {
  const op: Operation = { name: `synthetic_meta_${added.length}`, description: 'Synthetic metadata fixture',
    params, mutating, outputRedaction: 'no_stored_text', handler };
  operations.push(op); added.push(op); return op.name;
}
afterEach(() => { for (const op of added.splice(0)) operations.splice(operations.indexOf(op), 1); });

test('dispatch normalizes read authority before the handler and its concurrent hook', async () => {
  const seen: string[] = [];
  const name = register(async ctx => { seen.push(`handler:${ctx.sourceId}`); return { ok: true }; });
  const result = await dispatchToolCall(engine, name, {}, { ...opts, metaHook: async (_name, ctx) => {
    seen.push(`hook:${ctx.sourceId}`); return { brain_hot_memory: { source_id: ctx.sourceId } };
  } });
  expect(result.isError).not.toBe(true);
  expect(seen.sort()).toEqual(['handler:alpha', 'hook:alpha']);
  expect(result._meta?.brain_hot_memory).toEqual({ source_id: 'alpha' });
  expect(opts.sourceId).toBe('transport-default');
});

test('a write clone keeps its own authority while sharing only fresh server request state', async () => {
  const forged = { effectiveReadSourceId: 'foreign' };
  const a = buildOperationContext(engine, { requestState: forged, _meta: { requestState: forged } }, opts);
  const b = buildOperationContext(engine, {}, { ...opts, requestState: forged } as DispatchOpts);
  expect(a.requestState).toEqual({});
  expect(b.requestState).toEqual({});
  expect(a.requestState).not.toBe(b.requestState);
  let handlerCtx: OperationContext | undefined;
  const name = register(async ctx => { expect(ctx.sourceId).toBe('writer'); handlerCtx = ctx; ctx.sourceId = 'handler-mutated'; return { ok: true }; }, true);
  const result = await dispatchToolCall(engine, name, {}, { ...opts,
    auth: { ...opts.auth!, sourceId: 'writer', allowedSources: ['alpha', 'beta'] },
    metaHook: async (_name, ctx) => {
      expect(ctx.sourceId).toBe('alpha');
      expect(handlerCtx).not.toBe(ctx);
      expect(handlerCtx?.requestState).toBe(ctx.requestState);
      return { brain_hot_memory: { source_id: ctx.sourceId } };
    } });
  expect(result.isError).not.toBe(true);
  expect(result._meta?.brain_hot_memory).toEqual({ source_id: 'alpha' });
});

test('get_page defers its hook until the authorized snapshot source is known', async () => {
  const events: string[] = [];
  const page = { id: 7, slug: 'synthetic/resolved', source_id: 'beta', title: 'Synthetic page', type: 'note',
    compiled_truth: 'Synthetic body', timeline: '', frontmatter: {}, created_at: new Date(), updated_at: new Date() };
  const db = { ...engine, readPageSnapshot: async (_slug: string, scope: unknown) => {
    events.push('lookup'); expect(scope).toMatchObject({ sourceIds: ['alpha', 'beta'], resolveAlias: true });
    return { page, tags: ['beta-tag'], revision: 'synthetic-revision', bodyGeneration: 0 };
  } } as unknown as OperationContext['engine'];
  const result = await dispatchToolCall(db, 'get_page', { slug: 'synthetic/alias' }, { ...opts,
    auth: { ...opts.auth!, sourceId: 'alpha', allowedSources: ['alpha', 'beta'] },
    metaHook: async (_name, ctx) => {
      events.push('hook');
      return { brain_hot_memory: { source_id: ctx.requestState?.effectiveReadSourceId } };
    } });
  expect(result.isError).not.toBe(true);
  expect(events).toEqual(['lookup', 'hook']);
  expect(result._meta?.brain_hot_memory).toEqual({ source_id: 'beta' });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ source_id: 'beta', tags: ['beta-tag'], resolved_slug: 'synthetic/resolved' });
});

test('an explicit authorized get_page keeps actual-source metadata instead of blanket suppression', async () => {
  const page = { id: 8, slug: 'synthetic/page', source_id: 'beta', title: 'Synthetic', type: 'note',
    compiled_truth: 'body', timeline: '', frontmatter: {}, created_at: new Date(), updated_at: new Date() };
  const db = { ...engine, executeRaw: async (sql: string) => sql.includes('SELECT 1 AS ok FROM sources') ? [{ ok: 1 }] : [],
    readPageSnapshot: async () => ({ page, tags: [], revision: 'synthetic-revision', bodyGeneration: 0 }),
  } as unknown as OperationContext['engine'];
  const result = await dispatchToolCall(db, 'get_page', { slug: page.slug, source_id: 'beta' }, { ...opts,
    auth: { ...opts.auth!, allowedSources: ['alpha', 'beta'] },
    metaHook: async (_name, ctx) => ({ brain_hot_memory: { source_id: effectiveReadSourceId(ctx) } }),
  });
  expect(result.isError).not.toBe(true);
  expect(result._meta?.brain_hot_memory).toEqual({ source_id: 'beta' });
});

test('known_as_of get_page stamps the authorized historical response source without changing lookup', async () => {
  const at = '2026-01-01T00:00:00Z';
  const db = { ...engine, executeRaw: async (sql: string) => {
    if (sql.includes('SELECT DISTINCT e.source_id')) return [{ source_id: 'beta' }];
    if (sql.includes('clock_timestamp() AS now')) return [{ now: '2026-01-02T00:00:00Z' }];
    if (sql.includes('AS proven')) return [{ id: 3, lifetime: 'synthetic-lifetime', slug: 'synthetic/page', event_type: 'baseline', origin: 'sync', visibility: 'world', recorded_at: at, observed_at: at, source_time: null, value: { revision_after: 'synthetic-revision' }, proven: true }];
    if (sql.includes("e.subject_kind = 'coverage'")) return [
      { id: 1, event_type: 'coverage.started', recorded_at: at, incarnation: 'synthetic-incarnation' },
      { id: 2, event_type: 'coverage.complete', recorded_at: at, cause: { certified: true, pages: 1 }, incarnation: 'synthetic-incarnation' },
    ];
    if (sql.includes('SELECT recorded_at FROM belief_events')) return [{ recorded_at: at }];
    return [];
  } } as unknown as OperationContext['engine'];
  const result = await dispatchToolCall(db, 'get_page', { slug: 'synthetic/page', known_as_of: at, body: 'none' }, { ...opts,
    auth: { ...opts.auth!, allowedSources: ['alpha', 'beta'] },
    metaHook: async (_name, ctx) => ({ brain_hot_memory: { source_id: effectiveReadSourceId(ctx) } }),
  });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ source_id: 'beta', known_as_of: '2026-01-01T00:00:00.000Z' });
  expect(result._meta?.brain_hot_memory).toEqual({ source_id: 'beta' });
});

test('missing read or write authority refuses before invoking either handler or metadata hook', async () => {
  for (const mutating of [false, true]) {
    let calls = 0;
    const name = register(async () => { calls++; return {}; }, mutating);
    for (const auth of [{ ...opts.auth!, sourceId: undefined, allowedSources: [] },
      ...(mutating ? [{ ...opts.auth!, sourceId: undefined, allowedSources: ['alpha'] }] : [])]) {
      const result = await dispatchToolCall(engine, name, {}, { ...opts, auth, metaHook: async () => { calls++; return {}; } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).code).toBe('permission_denied');
      expect(calls).toBe(0);
    }
  }
});

test('explicit multi-source responses retain other metadata but never ambient hot memory without one page stamp', async () => {
  let hooks = 0;
  const name = register(async ctx => { ctx.emitResponseMeta?.('retrieval', { synthetic: true }); return []; }, false,
    { source_ids: { type: 'array', items: { type: 'string' } }, source_id: { type: 'string' } });
  for (const params of [{ source_ids: ['alpha', 'beta'] }, { source_id: 'beta' }]) {
    const result = await dispatchToolCall(engine, name, params, { ...opts, metaHook: async () => { hooks++; return { brain_hot_memory: {} }; } });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.retrieval).toEqual({ synthetic: true });
    expect(result._meta?.brain_hot_memory).toBeUndefined();
  }
  expect(hooks).toBe(0);
});

test('hot-memory opt-outs and hook failures preserve independent handler metadata', async () => {
  let hooks = 0;
  const name = register(async ctx => { ctx.emitResponseMeta?.('retrieval', { synthetic: true }); return {}; });
  for (const [params, extra] of [[{ _meta: { hot_memory: 'off' } }, {}], [{}, { hotMemoryOff: true }]] as const) {
    const result = await dispatchToolCall(engine, name, params, { ...opts, ...extra, metaHook: async () => { hooks++; return { brain_hot_memory: {} }; } });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.retrieval).toEqual({ synthetic: true });
    expect(result._meta?.brain_hot_memory).toBeUndefined();
  }
  expect(hooks).toBe(0);
  const warnings: string[] = [];
  const result = await dispatchToolCall(engine, name, {}, { ...opts, logger: { info() {}, error() {}, warn: m => { warnings.push(m); } },
    metaHook: async () => { throw new Error('synthetic hook failure'); } });
  expect(result.isError).not.toBe(true);
  expect(result._meta?.retrieval).toEqual({ synthetic: true });
  expect(warnings).toHaveLength(1);
});

test('an ambiguous federated get_page never runs a hook without an actual authorized page source', async () => {
  let hooks = 0;
  const db = { ...engine, readPageSnapshot: async () => null,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...engine, resolveSlugs: async () => ['synthetic/a', 'synthetic/b'] }),
  } as unknown as OperationContext['engine'];
  const result = await dispatchToolCall(db, 'get_page', { slug: 'synthetic', fuzzy: true }, { ...opts,
    auth: { ...opts.auth!, allowedSources: ['alpha', 'beta'] },
    metaHook: async () => { hooks++; return { brain_hot_memory: { source_id: 'alpha' } }; } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'ambiguous_slug', candidates: ['synthetic/a', 'synthetic/b'] });
  expect(hooks).toBe(0);
  expect(result._meta?.brain_hot_memory).toBeUndefined();
});

test('a failed get_page does not invoke a deferred hook or retain a previous request source', async () => {
  let hooks = 0;
  const db = { ...engine, readPageSnapshot: async () => null, getPage: async () => null } as unknown as OperationContext['engine'];
  const result = await dispatchToolCall(db, 'get_page', { slug: 'synthetic/missing' }, { ...opts,
    metaHook: async () => { hooks++; return { brain_hot_memory: {} }; } });
  expect(result.isError).toBe(true);
  expect(hooks).toBe(0);
  expect(result._meta?.brain_hot_memory).toBeUndefined();
});
