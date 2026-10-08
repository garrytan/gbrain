/**
 * whoami op contract tests — pins the v0.28 transport-detection shape.
 *
 * The test surface is the op's handler called against synthesized
 * OperationContext rather than the full HTTP stack — keeps the test pure
 * and fast. End-to-end coverage (real HTTP MCP) lives in
 * test/e2e/serve-http-oauth.test.ts and test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';

const whoami = operations.find(o => o.name === 'whoami')!;

function ctxWith(overrides: Partial<OperationContext>): OperationContext {
  // Shape exposes only what whoami reads. Every required field gets a
  // safe stub; the test-relevant overrides come last to win.
  return {
    engine: {} as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true, // default for tests; specific cases override
    ...overrides,
  } as OperationContext;
}

describe('whoami op contract', () => {
  test('local transport (ctx.remote === false) returns empty scopes', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: false }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('local transport ignores ctx.auth even if a stale value leaked through', async () => {
    // Defense in depth: even if some buggy transport set both remote=false
    // AND a stale auth blob, the local return shape stays explicit.
    const result = (await whoami.handler(
      ctxWith({
        remote: false,
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_123',
          scopes: ['admin'],
          expiresAt: 999999,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('oauth transport returns client identity and exact source grants', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_xxx',
      clientId: 'gbrain_cl_abc',
      clientName: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expiresAt: 1234567890,
      sourceId: 'hot-memory',
      allowedSources: ['hot-memory', 'canonical-brain'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, sourceId: 'transport-fallback', auth }),
      {},
    )) as any;
    expect(result).toMatchObject({
      transport: 'oauth',
      client_id: 'gbrain_cl_abc',
      client_name: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expires_at: 1234567890,
      source_id: 'hot-memory',
      federated_read: ['hot-memory', 'canonical-brain'],
    });
  });

  test('oauth transport uses fail-closed empty values when source grants are absent', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_pre_migration',
      clientId: 'gbrain_cl_pre_migration',
      scopes: ['read'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, sourceId: 'transport-fallback', auth }),
      {},
    )) as any;
    expect(result.source_id).toBeNull();
    expect(result.federated_read).toEqual([]);
  });

  test('oauth transport preserves an explicit empty federated grant', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_empty',
      clientId: 'gbrain_cl_empty',
      scopes: ['read', 'write'],
      sourceId: 'hot-memory',
      allowedSources: [],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.source_id).toBe('hot-memory');
    expect(result.federated_read).toEqual([]);
  });

  test('oauth transport does not widen federated_read with the write source', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_narrow',
      clientId: 'gbrain_cl_narrow',
      scopes: ['read', 'write'],
      sourceId: 'hot-memory',
      allowedSources: ['canonical-brain'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.source_id).toBe('hot-memory');
    expect(result.federated_read).toEqual(['canonical-brain']);
  });

  // The verifier-set principal wins over the id prefix: hand-provisioned OAuth
  // client ids need not start with gbrain_cl_, and a legacy token may be named
  // like one. The prefix-only tests above/below pin the no-principal fallback.
  test('principal oauth_client reports oauth even when the client id has no gbrain_cl_ prefix', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_xxx',
      clientId: 'research-custom-client',
      principal: { kind: 'oauth_client', id: 'research-custom-client' },
      clientName: 'Research client',
      scopes: ['read', 'write'],
      expiresAt: 1234567890,
      sourceId: 'research',
      allowedSources: ['research', 'default'],
    };
    const result = (await whoami.handler(ctxWith({ remote: true, auth }), {})) as any;
    expect(result).toMatchObject({
      transport: 'oauth',
      client_id: 'research-custom-client',
      client_name: 'Research client',
      expires_at: 1234567890,
      source_id: 'research',
      federated_read: ['research', 'default'],
    });
    expect(result.token_name).toBeUndefined();
  });

  test('principal legacy_token reports legacy even when the token name looks like an OAuth client id', async () => {
    const auth: AuthInfo = {
      token: 'legacy-token',
      clientId: 'gbrain_cl_lookalike',
      principal: { kind: 'legacy_token', id: '00000000-0000-4000-8000-000000000001' },
      clientName: 'gbrain_cl_lookalike',
      scopes: ['read'],
      expiresAt: 999999999,
    };
    const result = (await whoami.handler(ctxWith({ remote: true, auth }), {})) as any;
    // Agent contract v1 (F2): additive config-plane `readiness`.
    expect(result).toMatchObject({ transport: 'legacy', token_name: 'gbrain_cl_lookalike', scopes: ['read'], expires_at: null });
    expect(Array.isArray(result.readiness)).toBe(true);
  });

  test('legacy transport (token name as clientId, no gbrain_cl_ prefix)', async () => {
    const auth: AuthInfo = {
      token: 'legacy-token',
      clientId: 'my-personal-token',
      clientName: 'my-personal-token',
      scopes: ['read', 'write', 'admin'],
      // Legacy tokens have a synthetic 1y expiry — whoami exposes null
      // since legacy tokens don't actually expire.
      expiresAt: 999999999,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('legacy');
    expect(result.token_name).toBe('my-personal-token');
    expect(result.scopes).toEqual(['read', 'write', 'admin']);
    expect(result.expires_at).toBeNull();
  });

  // #1061: stdio MCP is remote/untrusted by design but has no per-token auth
  // (local pipe). The stdio dispatch marks ctx.transport='stdio'; whoami
  // reports it instead of throwing unknown_transport.
  test('stdio transport (remote=true, no auth, transport marker) reports stdio', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth: undefined, transport: 'stdio' }),
      {},
    )) as any;
    expect(result.transport).toBe('stdio');
    expect(result.scopes).toEqual([]);
  });

  test('stdio marker does not mask real auth (auth still wins)', async () => {
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        transport: 'stdio',
        auth: {
          token: 'gbrain_at_xxx',
          clientId: 'gbrain_cl_abc',
          scopes: ['read'],
          expiresAt: 1,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('oauth');
  });

  // Q3: ambiguous transport — fail-closed. The footgun this guards against
  // is a future transport that lands without threading auth, where a buggy
  // caller might trust whoami's output to gate sensitive ops.
  test('unknown_transport throws when remote=true AND auth is missing', async () => {
    try {
      await whoami.handler(ctxWith({ remote: true, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).message).toMatch(/unknown_transport|did not thread/);
    }
  });

  test('unknown_transport throws when remote is undefined (cast bypass guard)', async () => {
    // F7b contract: ctx.remote is REQUIRED. If a caller widens the type to
    // Partial<> and passes through undefined, whoami should treat it as
    // remote (the fail-closed default) and throw because auth is missing.
    try {
      await whoami.handler(ctxWith({ remote: undefined as any, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
    }
  });
});

describe('whoami op metadata', () => {
  test('description documents OAuth source grant fields', () => {
    expect(whoami.description).toContain('source_id');
    expect(whoami.description).toContain('federated_read');
  });

  test('scope is read (any authenticated caller can introspect itself)', () => {
    expect(whoami.scope).toBe('read');
  });

  test('not localOnly (must work over HTTP MCP for gstack /setup-gbrain)', () => {
    expect(whoami.localOnly).toBeFalsy();
  });

  test('mutating is false', () => {
    expect(whoami.mutating).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// D4: grant_diagnosis — proven blockers with counts and no operation names,
// inferred grant age kept apart, identity from the verifier's principal.
// ---------------------------------------------------------------------------

const EXCLUDED = ['put_pages', 'delete_page'];

async function diagnose(auth: AuthInfo, extra: Partial<OperationContext> = {}): Promise<any> {
  return (await whoami.handler(ctxWith({ remote: true, auth, ...extra }), {})) as any;
}

function oauthAuth(overrides: Partial<AuthInfo>): AuthInfo {
  return {
    token: 'gbrain_at_diag', clientId: 'display-only-id', clientName: 'diag-example',
    principal: { kind: 'oauth_client', id: 'gbrain_cl_diag_principal' },
    scopes: ['read', 'write'], expiresAt: 1, sourceId: 'default', allowedSources: ['default'],
    ...overrides,
  } as AuthInfo;
}

/** Every operation a read+write grant may call on this server: a no-snapshot full-surface grant lists exactly that set. */
async function eligibleFor(scopes: string[]): Promise<string[]> {
  return (await diagnose(oauthAuth({ scopes, allowedOperations: null }))).available_operations;
}

describe('whoami grant_diagnosis', () => {
  test('snapshot-blocked: names the operation snapshot, counts the excluded operations and names none', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    expect(eligible).toEqual(expect.arrayContaining(EXCLUDED));
    const result = await diagnose(oauthAuth({ allowedOperations: eligible.filter(name => !EXCLUDED.includes(name)), surface: 'full', surfaceSetBy: 'operator' }));
    const d = result.grant_diagnosis;
    expect(d.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 2 }]);
    expect(d.unreachable_count).toBe(2);
    expect(d.grant_age).toEqual({ state: 'intent_unknown', excluded_count: 2,
      statement: "This grant's snapshot excludes 2 currently eligible operations; original intent unknown." });
    expect(d.fix.next).toBe('tell_user_to_run');
    expect(d.fix.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_diag_principal', '--operations', '<OPERATIONS>', '--dry-run']);
    expect(d.fix.then_argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_diag_principal', '--operations', '<OPERATIONS>']);
    expect(d.fix.all_operations.argv).toContain('all');
    for (const name of EXCLUDED) expect(JSON.stringify(result)).not.toContain(name);
  });

  test('pin-blocked: names the client pin and its surface; the snapshot is complete', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const d = (await diagnose(oauthAuth({ allowedOperations: eligible, surface: 'starter', surfaceSetBy: 'operator' }))).grant_diagnosis;
    const outsideStarter = eligible.filter(name => !STARTER_OPS.has(name)).length;
    expect(outsideStarter).toBeGreaterThan(0);
    expect(d.blockers).toEqual([{ blocker: 'client_pin', surface: 'starter', set_by: 'operator', excluded_count: outsideStarter }]);
    expect(d.grant_age).toEqual({ state: 'snapshot_complete', excluded_count: 0 });
    expect(d.fix.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_diag_principal', '--surface', 'full', '--dry-run']);
    expect(d.fix.inputs).toBeUndefined();
    for (const name of EXCLUDED) expect(JSON.stringify(d)).not.toContain(name);
  });

  test('both: a client blocked by its snapshot and its pin gets both blockers and one command lifting both', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const d = (await diagnose(oauthAuth({ allowedOperations: eligible.filter(name => name !== 'put_pages'), surface: 'starter', surfaceSetBy: 'operator' }))).grant_diagnosis;
    const outsideStarter = eligible.filter(name => !STARTER_OPS.has(name));
    expect(d.blockers).toEqual([
      { blocker: 'operation_snapshot', excluded_count: 1 },
      { blocker: 'client_pin', surface: 'starter', set_by: 'operator', excluded_count: outsideStarter.length },
    ]);
    expect(d.unreachable_count).toBe(new Set([...outsideStarter, 'put_pages']).size);
    expect(d.fix.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_diag_principal', '--operations', '<OPERATIONS>', '--surface', 'full', '--dry-run']);
    expect(JSON.stringify(d)).not.toContain('put_pages');
  });

  test('scope-blocked: a reader names the missing write scope and counts no write operations', async () => {
    const eligible = await eligibleFor(['read']);
    expect(eligible).not.toContain('put_pages');
    const d = (await diagnose(oauthAuth({ scopes: ['read'], allowedOperations: eligible, surface: 'full' }))).grant_diagnosis;
    expect(d.blockers).toEqual([{ blocker: 'scope', missing_scopes: ['write'] }]);
    expect(d.unreachable_count).toBe(0);
    expect(d.fix).toBeNull();
  });

  test('server-ceiling: a narrower transport ceiling is its own blocker and no grant change is offered', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const d = (await diagnose(oauthAuth({ allowedOperations: eligible, effectiveSurface: 'starter' }), { surfaceCeiling: 'starter' })).grant_diagnosis;
    expect(d.blockers).toEqual([{ blocker: 'server_ceiling', surface: 'starter', excluded_count: eligible.filter(name => !STARTER_OPS.has(name)).length }]);
    expect(d.fix).toBeNull();
  });

  test('scope-eligible counting: a writer snapshot holding every read/write operation reports 0 though the catalog has admin-only operations', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const adminOnly = operations.filter(op => !op.localOnly && op.scope === 'admin').map(op => op.name);
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const name of adminOnly) expect(eligible).not.toContain(name);
    const d = (await diagnose(oauthAuth({ allowedOperations: eligible, surface: 'full' }))).grant_diagnosis;
    expect(d.blockers).toEqual([]);
    expect(d.unreachable_count).toBe(0);
    expect(d.grant_age).toEqual({ state: 'snapshot_complete', excluded_count: 0 });
  });

  test('legacy token: identity is the verifier principal id and the fix refreshes the snapshot', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const auth = { token: 'gbrain_x', clientId: 'shared-token-name', clientName: 'shared-token-name',
      principal: { kind: 'legacy_token', id: '00000000-0000-4000-8000-0000000000d4' }, scopes: ['read', 'write'],
      allowedOperations: eligible.filter(name => name !== 'put_pages'), expiresAt: 1 } as AuthInfo;
    const result = await diagnose(auth);
    expect(result.transport).toBe('legacy');
    const d = result.grant_diagnosis;
    expect(d.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    expect(d.grant_age.state).toBe('intent_unknown');
    expect(d.fix.argv).toEqual(['gbrain', 'auth', 'rescope', '--id', '00000000-0000-4000-8000-0000000000d4', '--refresh-operations']);
    expect(d.fix.then_argv).toEqual(['gbrain', 'auth', 'rescope', '--id', '00000000-0000-4000-8000-0000000000d4', '--refresh-operations', '--add', '<OPERATIONS>']);
    expect(JSON.stringify(result)).not.toContain('put_pages');
  });

  test('no principal: counts still report, but no host command is built from a display name', async () => {
    const eligible = await eligibleFor(['read', 'write']);
    const d = (await diagnose(oauthAuth({ principal: undefined, allowedOperations: eligible.filter(name => name !== 'put_pages') }))).grant_diagnosis;
    expect(d.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    expect(d.fix).toBeNull();
  });
});

describe('whoami grant_diagnosis grant age on a real grant record (PGLite)', () => {
  let engine: PGLiteEngine;
  let provider: GBrainOAuthProvider;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  }, 60_000);
  afterAll(async () => { await engine?.disconnect(); }, 15_000);

  async function writerWithout(name: string, excluded: string[]) {
    const created = await provider.registerClientManual(name, ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
    const grant = await readClientGrant(engine, created.clientId);
    await rescopeClientGrant(engine, created.clientId, { allowedOperations: grant.allowedOperations!.filter(op => !excluded.includes(op)) }, { actor: 'test' });
    return created;
  }
  async function liveDiagnosis(clientId: string, secret: string) {
    const token = await provider.exchangeClientCredentials(clientId, secret);
    const auth = await provider.verifyAccessToken(token.access_token) as unknown as AuthInfo;
    auth.effectiveSurface = 'full';
    return (await whoami.handler(ctxWith({ remote: true, auth, engine, config: { engine: 'pglite' } as any, surfaceCeiling: 'full' }), {}) as any).grant_diagnosis;
  }
  const dropFromCatalog = (clientId: string, name: string) => engine.executeRaw(
    `UPDATE oauth_grant_audit SET after_grant = jsonb_set(after_grant, '{catalogProvenance,operations}', (after_grant->'catalogProvenance'->'operations') - $2::text)
     WHERE client_id = $1 AND after_grant->'catalogProvenance' IS NOT NULL`, [clientId, name]);

  test('post-D4: a snapshot written without an operation that existed reports it as left out, not predated', async () => {
    const created = await writerWithout('age-left-out-example', ['put_pages']);
    const d = await liveDiagnosis(created.clientId, created.clientSecret!);
    expect(d.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    expect(d.grant_age).toMatchObject({ state: 'provenance_recorded', excluded_count: 1, predates_count: 0, excluded_at_snapshot_count: 1 });
    expect(d.grant_age.statement).toContain('all existed when the snapshot was written');
    expect(d.grant_age.statement).not.toContain('predates');
  });

  test('post-D4: an operation added after the snapshot was written is asserted as predated', async () => {
    const created = await writerWithout('age-predates-example', ['put_pages']);
    await dropFromCatalog(created.clientId, 'put_pages');
    const d = await liveDiagnosis(created.clientId, created.clientSecret!);
    expect(d.grant_age).toMatchObject({ state: 'provenance_recorded', excluded_count: 1, predates_count: 1, excluded_at_snapshot_count: 0 });
    expect(d.grant_age.statement).toStartWith('This grant predates 1 currently eligible operation:');
    expect(JSON.stringify(d)).not.toContain('put_pages');
  });

  test('a new admin-only operation outside a writer grant is not counted', async () => {
    const created = await writerWithout('age-admin-example', ['put_pages']);
    const adminOp = operations.find(op => !op.localOnly && op.scope === 'admin')!.name;
    await dropFromCatalog(created.clientId, adminOp);
    const d = await liveDiagnosis(created.clientId, created.clientSecret!);
    expect(d.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    expect(d.grant_age).toMatchObject({ excluded_count: 1, predates_count: 0 });
  });

  test('legacy: without recorded provenance the same snapshot says original intent unknown', async () => {
    const created = await writerWithout('age-legacy-example', ['put_pages']);
    await engine.executeRaw("UPDATE oauth_grant_audit SET after_grant = after_grant - 'catalogProvenance' WHERE client_id = $1", [created.clientId]);
    const d = await liveDiagnosis(created.clientId, created.clientSecret!);
    expect(d.grant_age).toEqual({ state: 'intent_unknown', excluded_count: 1,
      statement: "This grant's snapshot excludes 1 currently eligible operation; original intent unknown." });
  });
});
