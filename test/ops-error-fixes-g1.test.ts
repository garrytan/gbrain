/**
 * Agent contract v1, Lane B (B2/B6/B7/B8) — representative op error sites in
 * the context / pages / search / code-intel / insights / embedding-migration
 * group carry a filled suggestion and, where a next step exists, a fix that
 * names real ids and renders for the caller's surface.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type AuthInfo, type OperationContext } from '../src/core/operations.ts';
import {
  enforceBoundClientOpAllowList,
  noSourceGrantError,
  parseSourceIdParam,
  requireWritablePage,
  resolveCodeIntelScope,
  resolvePerCallMode,
  resolveRequestedScope,
  validatePageSlug,
} from '../src/core/ops/context.ts';
import { toAgentError } from '../src/core/agent-output.ts';

const LEGACY_PRINCIPAL_UUID = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const oauth = (over: Partial<AuthInfo> = {}): AuthInfo => ({
  token: 't', clientId: 'cli-alpha', scopes: ['read', 'write'], principal: { kind: 'oauth_client', id: 'cli-alpha' }, ...over,
});
const ctxOf = (over: Partial<OperationContext> = {}): OperationContext =>
  ({ engine: {} as OperationContext['engine'], config: {} as OperationContext['config'], remote: true, transport: 'http', ...over }) as OperationContext;
const opNamed = (name: string) => {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`no op ${name}`);
  return op;
};
const caught = async (fn: () => unknown): Promise<OperationError> => {
  try { await fn(); } catch (e) { expect(e).toBeInstanceOf(OperationError); return e as OperationError; }
  throw new Error('expected a throw');
};
const render = (transport: 'stdio' | 'http', callable: string[] = []) => ({
  transport, isCallable: (t: string) => callable.includes(t), preapproved: () => false,
});

describe('context.ts grant and fence refusals (B6/B7)', () => {
  test('no-source grant names the token and asks for the sources as an input', () => {
    const e = noSourceGrantError('put_page', oauth({ clientId: 'tok', principal: { kind: 'legacy_token', id: LEGACY_PRINCIPAL_UUID } }));
    expect(e.code).toBe('permission_denied');
    expect(e.suggestion).not.toContain('<name>');
    expect(e.fix).toMatchObject({
      argv: ['gbrain', 'auth', 'rescope-token', '--id', LEGACY_PRINCIPAL_UUID, '--sources', '<sources>'],
      actor: 'host_admin', consent: ['credentials'], inputs: [{ name: 'sources' }],
    });
    const env = toAgentError(e, { transport: 'http', op: 'put_page', render: render('http') });
    expect(env.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'host_admin' });
  });

  test('no-source grant without a nameable token lists the tokens instead of printing a placeholder', () => {
    for (const auth of [undefined, oauth({ clientId: 'tok', principal: { kind: 'legacy_token', id: 'not-a-uuid' } })]) {
      const e = noSourceGrantError('POST /ingest', auth);
      expect(e.fix).toMatchObject({ argv: ['gbrain', 'auth', 'list'], actor: 'host_admin', consent: [] });
      expect(e.fix?.inputs).toBeUndefined();
      expect(e.suggestion).toContain('token list');
      const env = toAgentError(e, { transport: 'http', op: 'put_page', render: render('http') });
      expect(JSON.stringify(env)).not.toMatch(/<name>|<sources>|<id/);
    }
  });

  test('operation-snapshot refusal regrants the exact op for an OAuth client', async () => {
    const e = await caught(() => enforceBoundClientOpAllowList(oauth({ allowedOperations: ['get_page'] }), { name: 'put_page', scope: 'write', mutating: true }));
    expect(e.detail).toBe('fence=operation_grant');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'auth', 'rescope-client', 'cli-alpha', '--allowed-operations', 'get_page,put_page'], actor: 'host_admin' });
  });

  test('slug-bound refusal fills the client id instead of <id>', async () => {
    const e = await caught(() => enforceBoundClientOpAllowList(oauth({ boundSlugPrefixes: ['wiki/agents/alpha/'] }), { name: 'sources_remove', scope: 'admin', mutating: true }));
    expect(e.suggestion).toContain('gbrain auth rescope-client cli-alpha --bound-slug-prefixes none');
    expect(e.suggestion).not.toContain('<id>');
  });

  test('degraded fence projection points the host at the migrations', async () => {
    const e = await caught(() => enforceBoundClientOpAllowList(oauth({ fenceProjectionDegraded: true }), { name: 'delete_page', scope: 'write', mutating: true }));
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], actor: 'host_admin' });
  });
});

describe('context.ts source scope (B2)', () => {
  test('out-of-grant source keeps its hint and lists the readable sources', async () => {
    const e = await caught(() => resolveRequestedScope(ctxOf({ auth: oauth({ allowedSources: ['work'] }) }), 'notes'));
    expect(e.suggestion).toBe('Request access to this source, or omit source_id to search within your grant.');
    expect(e.fix).toMatchObject({ mcp: { tool: 'sources_list', arguments: {} }, argv: ['gbrain', 'sources', 'list', '--json'] });
  });

  test('explicit-read denial on a bound connection names the federate command for that source', async () => {
    const ctx = ctxOf({ transport: 'stdio', explicitReadBinding: { sourceId: 'work', via: 'GBRAIN_SOURCE', sourceIds: ['work'], optedOut: [] } } as Partial<OperationContext>);
    const e = await caught(() => resolveRequestedScope(ctx, 'notes', false, ['work']));
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'sources', 'federate', 'notes'], actor: 'user' });
  });

  test('an invalid source_id points at sources_list (not the nonexistent list_sources)', async () => {
    const e = await caught(() => parseSourceIdParam('Bad Id', 'get_page'));
    expect(e.code).toBe('invalid_params');
    expect(e.suggestion).not.toContain('list_sources');
    expect(e.fix?.mcp).toEqual({ tool: 'sources_list', arguments: {} });
  });

  test('code traversal over several granted sources lists them as choices', async () => {
    const e = await caught(() => resolveCodeIntelScope(ctxOf({ auth: oauth({ allowedSources: ['work', 'notes'] }) }), undefined, false, 'code_blast'));
    expect(e.code).toBe('invalid_params');
    expect(e.suggestion).toBe('Pass `source_id` as one of: work, notes. Example: code_blast {"source_id": "work"}.');
  });

  test('an unknown search mode renders the CLI flag on the CLI (B8)', async () => {
    const e = await caught(() => resolvePerCallMode(ctxOf({ remote: false }), 'NUKE', 'search'));
    expect(e.suggestion).toBe('Pass --mode as one of: conservative, balanced, tokenmax. Example: --mode balanced.');
  });

  test('slug validation explains the accepted shape', async () => {
    const e = await caught(() => validatePageSlug('../etc'));
    expect(e.code).toBe('invalid_params');
    expect(e.suggestion).toContain('people/alice-example');
    expect(e.contractVersion).toBe(1);
  });
});

describe('op handlers (B2/B6/B8)', () => {
  test('volunteer_context names stats on the caller surface', async () => {
    const op = opNamed('volunteer_context');
    const mcp = await caught(() => op.handler(ctxOf({ transport: 'stdio' }), {}));
    expect(mcp.message).toBe('window is required unless stats: true');
    expect(mcp.suggestion).not.toContain('--stats');
    const cli = await caught(() => op.handler(ctxOf({ remote: false }), {}));
    expect(cli.message).toBe('window is required unless --stats');
    expect(cli.suggestion).toContain('--stats');
  });

  test('remote code reads name the trusted local call with the symbol and source', async () => {
    const e = await caught(() => opNamed('code_callers').handler(ctxOf(), { symbol: 'parseMarkdown', source_id: 'work' }));
    expect(e.code).toBe('permission_denied');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'call', '--source', 'work', 'code_callers', '{"symbol":"parseMarkdown"}'], actor: 'host_admin' });
    const odd = await caught(() => opNamed('code_flow').handler(ctxOf(), { entry_point: '$(rm -rf)' }));
    expect(odd.fix).toBeUndefined();
  });

  test('migrate_embeddings refusal routes to the caller brain explicitly', async () => {
    const e = await caught(() => opNamed('migrate_embeddings').handler(ctxOf({ transport: 'stdio', brainId: 'work-brain' }), { to: 'openai:text-embedding-3-small' }));
    expect(e.fix).toMatchObject({
      argv: ['gbrain', '--brain', 'work-brain', 'migrate', 'embeddings', '--to', 'openai:text-embedding-3-small', '--dry-run'],
      actor: 'user',
    });
  });

  test('find_experts without a topic lists the param on each surface', async () => {
    const op = opNamed('find_experts');
    expect((await caught(() => op.handler(ctxOf({ transport: 'stdio' }), {}))).suggestion).toContain('find_experts {"topic": "vector search"}');
    expect((await caught(() => op.handler(ctxOf({ remote: false }), {}))).suggestion).toContain('--topic vector search');
  });
});

describe('page misses carry a read-only lookup (B2)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('get_page miss on the CLI suggests the soft-delete check as a flag', async () => {
    const e = await caught(() => opNamed('get_page').handler(ctxOf({ engine, remote: false }), { slug: 'people/nobody-example' }));
    expect(e.code).toBe('page_not_found');
    expect(e.suggestion).toContain('--include-deleted');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'get', 'people/nobody-example', '--include-deleted'], mcp: { tool: 'get_page', arguments: { slug: 'people/nobody-example', include_deleted: true } } });
  });

  test('graph-write endpoint miss looks the slug up in the write source', async () => {
    const e = await caught(() => requireWritablePage(ctxOf({ engine, remote: false, sourceId: 'default' }), 'people/nobody-example', 'add_link', 'to'));
    expect(e.code).toBe('page_not_found');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'get', 'people/nobody-example', '--fuzzy', '--source', 'default'] });
  });
});
