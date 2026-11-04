import { beforeEach, expect, test } from 'bun:test';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests, __hotMemoryCacheForTests, bumpHotMemoryCache, invalidateHotMemoryForEngine } from '../src/core/facts/meta-hook.ts';
import { buildOperationContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import type { FactRow } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';

beforeEach(__resetHotMemoryCacheForTests);
function fixture() {
  const reads: string[] = [];
  const factReads: string[] = [];
  let version = 0;
  const engine = {
    getConfig: async () => { reads.push('config'); return null; },
    executeRaw: async (sql: string, params?: unknown[]) => {
      reads.push('sql');
      return sql.includes('trust_policy_state') ? [{ generation: '0' }]
        : sql.includes('fact_withdrawals') ? [{ n: 0, at: null }]
        : sql.includes('AS flagged') ? ((params?.[0] as number[]) ?? []).map(id => ({ id, trust_tier: 'operator_curated', flagged: false })) : [];
    },
    listFactsSince: async (source: string) => {
      reads.push(`facts:${source}`); factReads.push(source);
      return [1, 2, 3].map(id => ({ id, source_id: source, entity_slug: `entity-${id}`, fact: `${source} fact ${id} v${version}`,
        kind: 'fact', visibility: 'world', notability: 'medium', valid_from: new Date('2026-01-01'), created_at: new Date('2026-01-01'),
        confidence: 0.9, trust_tier: 'operator_curated' } as FactRow));
    },
  } as unknown as OperationContext['engine'];
  const ctx = (grant: Partial<AuthInfo> = { sourceId: 'alpha' }, extra: Partial<OperationContext> = {}): OperationContext => ({
    engine, config: { engine: 'postgres' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false,
    remote: false, sourceId: 'transport-default', auth: { token: 'synthetic-token', clientId: 'synthetic-client', scopes: ['read'], ...grant }, ...extra,
  });
  return { engine, reads, factReads, ctx, advance: () => { version++; } };
}
function memory(meta: Record<string, unknown> | undefined) {
  return meta?.brain_hot_memory as { source_id: string; facts: { fact: string }[] } | undefined;
}

test('direct metadata normalizes auth before reads and refuses missing grants before any cache or DB access', async () => {
  const f = fixture();
  const result = await getBrainHotMemoryMeta('get_stats', f.ctx());
  expect(memory(result)?.source_id).toBe('alpha');
  expect(f.factReads).toEqual(['alpha']);
  f.reads.length = 0;
  await expect(getBrainHotMemoryMeta('get_stats', f.ctx({}))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.reads).toEqual([]);
  expect(__hotMemoryCacheForTests().size).toBe(1);
});

test('only server-created actual-source state can select an authorized page source, rechecked on every call', async () => {
  const f = fixture();
  const grant = { sourceId: 'alpha', allowedSources: ['alpha', 'beta'] };
  const server = buildOperationContext(f.engine, {}, { config: { engine: 'postgres' }, sourceId: 'transport-default', remote: false, auth: f.ctx(grant).auth });
  server.requestState!.effectiveReadSourceId = 'beta';
  expect(memory(await getBrainHotMemoryMeta('get_page', server))?.source_id).toBe('beta');
  const forged = f.ctx(grant, { requestState: { effectiveReadSourceId: 'beta' } });
  expect(memory(await getBrainHotMemoryMeta('get_page', forged))?.source_id).toBe('alpha');
  f.reads.length = 0;
  server.auth!.allowedSources = ['alpha'];
  await expect(getBrainHotMemoryMeta('get_page', server)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.reads).toEqual([]);
  server.auth!.allowedSources = ['alpha', 'beta'];
  server.requestState!.effectiveReadSourceId = '__all__';
  await expect(getBrainHotMemoryMeta('get_page', server)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.reads).toEqual([]);
});

test('the normalized topK cap partitions cache entries in both directions', async () => {
  const f = fixture();
  const one = await getBrainHotMemoryMeta('get_stats', f.ctx(), { topK: 1 });
  expect(memory(one)?.facts).toHaveLength(1);
  expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx(), { topK: 2 }))?.facts).toHaveLength(2);
  expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx(), { topK: 1 }))?.facts).toHaveLength(1);
  expect(f.factReads).toHaveLength(2);
});

test('current principal and grants partition the cache without credential material', async () => {
  const f = fixture();
  const base = { sourceId: 'alpha', allowedSources: ['alpha', 'beta'], principal: { kind: 'oauth_client' as const, id: 'principal-one' } };
  const grants: Partial<AuthInfo>[] = [base,
    { ...base, principal: { kind: 'oauth_client', id: 'principal-two' } },
    { ...base, allowedSources: ['alpha'] }, { ...base, scopes: ['read', 'write'] },
    { ...base, grantRevision: 2 }, { ...base, clientId: 'other-client' },
  ];
  for (const [i, grant] of grants.entries()) {
    f.advance();
    expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx(grant)))?.facts[0]?.fact).toContain(`v${i + 1}`);
  }
  expect(f.factReads).toHaveLength(grants.length);
  // A token rotation with identical verified authority reuses the same namespace.
  await getBrainHotMemoryMeta('get_stats', f.ctx({ ...base, token: 'different-synthetic-token', allowedSources: ['beta', 'alpha'] }));
  expect(f.factReads).toHaveLength(grants.length);
  const keys = [...__hotMemoryCacheForTests().keys()].join(' ');
  expect(keys).not.toContain('synthetic-token');
  expect(keys).not.toContain('different-synthetic-token');
});

test('source/session invalidation drops every principal and topK variant, keeping exact other pairs', async () => {
  const f = fixture();
  const variants = [
    f.ctx({ sourceId: 'alpha', clientId: 'client-one' }, { sessionId: 'session::a' }),
    f.ctx({ sourceId: 'alpha', clientId: 'client-two' }, { sessionId: 'session::a' }),
  ];
  // Empty session rows fall back to the synthetic recent facts.
  f.engine.listFactsBySession = async () => [];
  for (const ctx of variants) for (const topK of [1, 2]) await getBrainHotMemoryMeta('get_stats', ctx, { topK });
  await getBrainHotMemoryMeta('get_stats', f.ctx({ sourceId: 'beta' }, { sessionId: 'session::a' }));
  await getBrainHotMemoryMeta('get_stats', f.ctx({ sourceId: 'alpha' }, { sessionId: 'session::b' }));
  expect(__hotMemoryCacheForTests().size).toBe(6);
  bumpHotMemoryCache('alpha', 'session::a');
  expect(__hotMemoryCacheForTests().size).toBe(2);
  f.advance();
  for (const ctx of variants) for (const topK of [1, 2]) {
    expect(memory(await getBrainHotMemoryMeta('get_stats', ctx, { topK }))?.facts[0]?.fact).toContain('v1');
  }
  expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx({ sourceId: 'beta' }, { sessionId: 'session::a' })))?.facts[0]?.fact).toContain('v0');
  expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx({ sourceId: 'alpha' }, { sessionId: 'session::b' })))?.facts[0]?.fact).toContain('v0');
});

test('engine identity, visibility tier, holders, session-only and member identity remain separate', async () => {
  const f = fixture();
  const variants = [f.ctx(), f.ctx(undefined, { remote: true }), f.ctx(undefined, { takesHoldersAllowList: [] }), f.ctx(undefined, { takesHoldersAllowList: ['world'] })];
  for (const ctx of variants) expect(memory(await getBrainHotMemoryMeta('get_stats', ctx))?.source_id).toBe('alpha');
  expect(f.factReads).toHaveLength(4);
  const g = fixture();
  expect(memory(await getBrainHotMemoryMeta('get_stats', g.ctx()))?.source_id).toBe('alpha');
  expect(g.factReads).toHaveLength(1);
  expect(await getBrainHotMemoryMeta('get_stats', f.ctx(), { sessionOnly: true })).toBeUndefined();
  for (const member of ['alice', 'bob']) {
    await withCallerAccess({ identity: [`member:${member}`] }, () => getBrainHotMemoryMeta('get_stats', f.ctx(undefined, { remote: true })));
  }
  expect(f.factReads).toHaveLength(6);
});

test('an in-flight build cannot refill the engine cache after invalidation', async () => {
  const f = fixture();
  const list = f.engine.listFactsSince.bind(f.engine);
  f.engine.listFactsSince = async (...args) => { invalidateHotMemoryForEngine(f.engine); return list(...args); };
  expect(memory(await getBrainHotMemoryMeta('get_stats', f.ctx()))?.source_id).toBe('alpha');
  expect(__hotMemoryCacheForTests().size).toBe(0);
});

test('a real remote get_page response carries positive actual-source hot memory', async () => {
  const f = fixture();
  f.engine.readPageSnapshot = async () => ({ page: { id: 7, slug: 'synthetic/page', source_id: 'beta', title: 'Synthetic', type: 'note',
    compiled_truth: 'Synthetic body', timeline: '', frontmatter: {}, created_at: new Date(), updated_at: new Date() }, tags: ['beta-tag'], revision: 'synthetic-revision', bodyGeneration: 0 }) as never;
  const result = await dispatchToolCall(f.engine, 'get_page', { slug: 'synthetic/page' }, {
    remote: true, transport: 'http', sourceId: 'transport-default', config: { engine: 'postgres' },
    auth: f.ctx({ sourceId: 'alpha', allowedSources: ['alpha', 'beta'], member: null }).auth,
    metaHook: getBrainHotMemoryMeta,
  });
  expect(result.isError).not.toBe(true);
  expect(memory(result._meta)?.source_id).toBe('beta');
  expect(memory(result._meta)?.facts).toHaveLength(3);
  expect(f.factReads).toEqual(['beta']);
});

test('authless local and stdio actual-source stamps preserve the existing read admission policy', async () => {
  const f = fixture();
  for (const remote of [true, false]) {
    const ctx = buildOperationContext(f.engine, {}, { remote, transport: 'stdio', sourceId: 'alpha',
      localFederatedSourceIds: ['alpha', 'beta'], config: { engine: 'postgres' } });
    ctx.requestState!.effectiveReadSourceId = 'beta';
    expect(memory(await getBrainHotMemoryMeta('get_page', ctx))?.source_id).toBe('beta');
  }
});

test('malformed authority cannot reach a warm cache or engine', async () => {
  const f = fixture();
  await getBrainHotMemoryMeta('get_stats', f.ctx({}, { auth: undefined, sourceId: 'alpha' }));
  f.reads.length = 0;
  for (const grant of [{}, { sourceId: '__all__' }, { allowedSources: [] }, { allowedSources: ['alpha', ''] }, { allowedSources: Array(1) }]) {
    await expect(getBrainHotMemoryMeta('get_stats', f.ctx(grant, { sourceId: 'alpha' }))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.reads).toEqual([]);
  }
});
