/**
 * #5231 / #5893 (O-ENG-7) on real Postgres: `rescopeLegacyToken` (the
 * `foresights auth rescope-token` core) stores real JSONB objects and arrays
 * (postgres.js double-encode class), binds its source list as text[], and the
 * explicit no-source grant is enforced by both HTTP auth paths and by
 * publication reauthorization. PGLite and the real CLI subprocess are covered
 * by test/auth-rescope-token.serial.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../../src/core/grants/legacy-token.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { NO_SOURCES } from '../../src/core/source-id.ts';
import type { AuthInfo, OperationContext } from '../../src/core/ops/contract.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { authorizeStoredRequest, submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';

const d = hasDatabase() ? describe : describe.skip;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const engine = await setupDB();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other-e2e','other-e2e') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/rescope-e2e', { type: 'note', title: 'Rescope', compiled_truth: 'rescope-e2e-marker prose', timeline: '', frontmatter: {} }, { sourceId: 'default' });
});
afterAll(async () => { if (hasDatabase()) await teardownDB(); });

const rescope = (...args: string[]) => rescopeLegacyToken(getEngine(), parseRescopeTokenArgs(args));
const provider = () => { const engine = getEngine(); return new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }); };

d('auth rescope-token on Postgres', () => {
  test('stores JSONB objects and arrays, preserving untouched keys', async () => {
    const engine = getEngine();
    const name = `rescope-e2e-${randomUUID().slice(0, 8)}`;
    const minted = await mintLegacyToken(engine, { name, takesHolders: ['world'], scopes: ['read', 'write'], allowedOperations: ['get_page', 'search'] });
    await rescope(name, '--sources', 'other-e2e,default', '--takes-holders', 'none');
    const [row] = await engine.executeRaw<{ permissions: Record<string, unknown>; kind: string; sources: string; holders: string }>(
      `SELECT permissions, jsonb_typeof(permissions) AS kind, jsonb_typeof(permissions->'source_id') AS sources,
              jsonb_typeof(permissions->'takes_holders') AS holders FROM access_tokens WHERE id = $1::uuid`, [minted.id]);
    expect(row).toMatchObject({ kind: 'object', sources: 'array', holders: 'array' });
    expect(row.permissions).toEqual({ source_id: ['other-e2e', 'default'], takes_holders: [], allowed_operations: ['get_page', 'search'] });
    await expect(rescope(name, '--sources', 'missing-e2e')).rejects.toThrow('Unknown or archived source: missing-e2e');
  });

  test('none is enforced on both HTTP auth paths and at publication', async () => {
    const engine = getEngine();
    const name = `rescope-e2e-${randomUUID().slice(0, 8)}`;
    const minted = await mintLegacyToken(engine, { name, takesHolders: ['world'], scopes: ['read', 'write'], sourceGrant: ['default'] });
    const before = await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
    const ctx = { engine, config: { engine: 'postgres' }, sourceId: 'default', auth: before, remote: true, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/rescope-e2e');
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'notes/rescope-e2e', requestId: randomUUID(), callerIntent: {}, intent: {} });

    await rescope(name, '--sources', 'none');
    await expect(authorizeStoredRequest(engine, admitted)).rejects.toMatchObject({ code: 'permission_denied' });

    const auth = await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
    expect(auth.sourceId).toBe(NO_SOURCES);
    for (const [op, args] of [['search', { query: 'rescope-e2e-marker' }], ['put_page', { slug: 'notes/rescope-e2e-new', content: 'x', source_id: 'other-e2e' }]] as const) {
      const result = await dispatchToolCall(engine, op, { ...args }, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });
      expect(JSON.parse(result.content[0].text).error).toBe('permission_denied');
    }
    const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST',
        headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'notes/rescope-e2e' } } }) });
      const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).error).toBe('permission_denied');
    } finally { server.stop?.(true); }
  });
});
