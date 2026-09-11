import { authorizeAsOwner } from './helpers/oauth.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { hasScope } from '../src/core/scope.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile, intersectGrantedScopes, grantValidationContext, delegationReasons } from '../src/core/grants/service.ts';
import { repairLegacyClientGrants } from '../src/core/grants/migration.ts';
import { parseRescopeGrantArgs } from '../src/core/grants/cli.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { Response } from 'express';
import { opAllowedForBoundClient } from '../src/core/ops/context.ts';
import { operations } from '../src/core/operations.ts';
import { parseAdminGrantRequest, previewNewAdminGrant } from '../src/commands/serve-http-grants.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);

async function memoryClient(name: string) {
  return provider.registerClientManual(name, ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
    resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
}

describe('client capability grants', () => {
  test('profile defaults are explicit unlimited, concurrency one, renewable hour or static 30 days', () => {
    const grant = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    expect(grant.budgetUsdPerDay).toBeNull();
    expect(grant.boundMaxConcurrent).toBe(1);
    expect(grant.tokenTtlSeconds).toBe(3600);
    expect(grant.allowedOperations).toContain('remember');
    expect(grant.allowedOperations).not.toContain('submit_agent');
    expect(resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default', staticToken: true }).tokenTtlSeconds).toBe(2592000);
    expect(() => resolveGrantProfile({ profile: 'full', sourceId: 'default' })).toThrow('explicit non-empty --bound-tools');
    expect(resolveGrantProfile({ profile: 'full', sourceId: 'default', boundTools: ['search'] }).delegatedNamespace).toBe('job');
  });

  test('new profile persists an operation snapshot and registration audit without secrets', async () => {
    const created = await memoryClient('snapshot-example');
    const grant = await readClientGrant(engine, created.clientId);
    expect(grant.allowedOperations).toContain('remember');
    expect(grant.revision).toBe(1);
    const rows = await engine.executeRaw('SELECT after_grant FROM oauth_grant_audit WHERE client_id = $1', [created.clientId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(created.clientSecret!);
    expect(JSON.stringify(rows)).not.toContain('client_secret_hash');
  });

  test('raw agent registration rejects incomplete or unavailable delegation before insert', async () => {
    await expect(provider.registerClientManual('missing-bindings-example', ['client_credentials'], 'agent')).rejects.toThrow('delegated_tools_missing');
    await expect(provider.registerClientManual('unknown-tools-example', ['client_credentials'], 'agent', [], 'default', undefined, undefined, {
      boundTools: ['shell'], boundSourceId: 'default', delegatedNamespace: 'job',
    })).rejects.toThrow('delegated_tools_unavailable');
    await expect(provider.registerClientManual('local-tools-example', ['client_credentials'], 'agent', [], 'default', undefined, undefined, {
      boundTools: ['file_list', 'file_url'], boundSourceId: 'default', delegatedNamespace: 'job',
    })).rejects.toThrow('delegated_tools_unavailable');
    const rows = await engine.executeRaw("SELECT client_id FROM oauth_clients WHERE client_name IN ('missing-bindings-example', 'unknown-tools-example')");
    expect(rows).toHaveLength(0);
  });

  test('valid agent-only bindings independently authorize safe job-owned delegation', async () => {
    const created = await provider.registerClientManual('agent-only-example', ['client_credentials'], 'agent', [], 'default', undefined, undefined, {
      boundTools: ['search'], boundSourceId: 'default', delegatedNamespace: 'job',
    });
    const grant = await readClientGrant(engine, created.clientId);
    expect(grant.scopes).toEqual(['agent']);
    expect(delegationReasons(grant, await grantValidationContext(engine))).toEqual([]);
    await rescopeClientGrant(engine, created.clientId, { boundBrainId: 'host' }, { actor: 'test' });
    expect((await readClientGrant(engine, created.clientId)).boundBrainId).toBeNull();
    await expect(rescopeClientGrant(engine, created.clientId, { boundBrainId: 'other-brain-example' }, { actor: 'test' })).rejects.toThrow('delegated_brain_unavailable');
  });

  test('DCR cannot grant agent even with ordinary read scope', async () => {
    await expect(provider.clientsStore.registerClient!({ redirect_uris: ['https://example.test/callback'], scope: 'read agent', grant_types: ['authorization_code'] })).rejects.toThrow('operator-approved');
  });

  test('ordinary source/read asymmetry remains valid; delegation cannot invent read access', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('grant-read-only-example', 'grant-read-only-example')");
    const created = await provider.registerClientManual('asymmetric-source-example', ['client_credentials'], 'read write', [], 'default', ['grant-read-only-example']);
    expect((await readClientGrant(engine, created.clientId)).federatedRead).toEqual(['grant-read-only-example']);
    await expect(rescopeClientGrant(engine, created.clientId, { scopes: ['read', 'write', 'agent'], boundTools: ['search'], boundSourceId: 'default', delegatedNamespace: 'job' }, { actor: 'test' })).rejects.toThrow('delegated_read_source_missing');
  });

  test('scope intersection preserves implications without adding agent', () => {
    expect(intersectGrantedScopes(['admin'], ['write'])).toEqual(['write']);
    expect(intersectGrantedScopes(['write'], ['read'])).toEqual(['read']);
    expect(intersectGrantedScopes(['admin'], ['admin', 'agent'])).toEqual(['admin']);
    expect(intersectGrantedScopes(['read', 'write'], ['read', 'write'])).toEqual(['read', 'write']);
  });

  test('scope removal affects existing tokens; added scopes need a newly issued token', async () => {
    const created = await memoryClient('token-policy-example');
    const original = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    const initial = await readClientGrant(engine, created.clientId);
    await rescopeClientGrant(engine, created.clientId, { scopes: ['read'] }, { actor: 'test', expectedRevision: initial.revision });
    expect(hasScope((await provider.verifyAccessToken(original.access_token)).scopes, 'write')).toBe(false);
    await rescopeClientGrant(engine, created.clientId, {
      scopes: ['read', 'write', 'agent'], boundTools: ['search'], boundSourceId: 'default', delegatedNamespace: 'job', delegatedSlugPrefixes: null,
    }, { actor: 'test' });
    const stillOriginal = await provider.verifyAccessToken(original.access_token);
    expect(hasScope(stillOriginal.scopes, 'agent')).toBe(false);
    const renewed = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    expect(hasScope((await provider.verifyAccessToken(renewed.access_token)).scopes, 'agent')).toBe(true);
  });

  test('CAS rejects stale operators without changing grant or credential hash', async () => {
    const created = await memoryClient('cas-example');
    const before = await readClientGrant(engine, created.clientId);
    await rescopeClientGrant(engine, created.clientId, { surface: 'full' }, { actor: 'first', expectedRevision: before.revision });
    await expect(rescopeClientGrant(engine, created.clientId, { scopes: ['admin'] }, { actor: 'stale', expectedRevision: before.revision })).rejects.toThrow('Grant changed');
    const after = await readClientGrant(engine, created.clientId);
    expect(after.scopes).toEqual(before.scopes);
    const secret = await engine.executeRaw('SELECT client_secret_hash FROM oauth_clients WHERE client_id = $1', [created.clientId]);
    expect(secret[0].client_secret_hash).toBe(hashToken(created.clientSecret!));
  });

  test('audit failure rolls back the associated grant update', async () => {
    const created = await memoryClient('audit-rollback-example');
    const before = await readClientGrant(engine, created.clientId);
    await engine.executeRaw(`CREATE FUNCTION reject_grant_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor = 'reject-test' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER reject_grant_test_audit BEFORE INSERT ON oauth_grant_audit FOR EACH ROW EXECUTE FUNCTION reject_grant_test_audit()');
    try {
      await expect(rescopeClientGrant(engine, created.clientId, { scopes: ['read'] }, { actor: 'reject-test' })).rejects.toThrow('audit unavailable');
      expect(await readClientGrant(engine, created.clientId)).toEqual(before);
    } finally {
      await engine.executeRaw('DROP TRIGGER reject_grant_test_audit ON oauth_grant_audit');
      await engine.executeRaw('DROP FUNCTION reject_grant_test_audit()');
    }
  });

  test('repair preserves finite caps, concurrency, direct fences, and operation snapshots', async () => {
    const created = await memoryClient('repair-example');
    await rescopeClientGrant(engine, created.clientId, { budgetUsdPerDay: '2.50', boundMaxConcurrent: 2, boundSlugPrefixes: ['work-example/'] }, { actor: 'test' });
    const before = await readClientGrant(engine, created.clientId);
    const result = await rescopeClientGrant(engine, created.clientId, { budgetUsdPerDay: null, boundMaxConcurrent: 1, boundSlugPrefixes: null, allowedOperations: ['search'], boundTools: ['search'] }, { actor: 'test', repair: true });
    expect(result.after.budgetUsdPerDay).toBe('2.50');
    expect(result.after.boundMaxConcurrent).toBe(2);
    expect(result.after.boundSlugPrefixes).toEqual(['work-example/']);
    expect(result.after.allowedOperations).toEqual(before.allowedOperations);
  });

  test('repair preserves explicitly empty operation and scope ceilings', async () => {
    const created = await memoryClient('deny-all-repair-example');
    await rescopeClientGrant(engine, created.clientId, { scopes: [], allowedOperations: [] }, { actor: 'test' });
    const before = await readClientGrant(engine, created.clientId);
    const result = await rescopeClientGrant(engine, created.clientId, resolveGrantProfile({ profile: 'operator', sourceId: 'default', existing: before }), { actor: 'test', repair: true });
    expect(result.after.scopes).toEqual([]);
    expect(result.after.allowedOperations).toEqual([]);
    expect(result.revision).toBe(before.revision);
  });

  for (const profile of ['memory-reader', 'memory-writer', 'delegating-agent'] as const) {
    test(`harness TTL-only update preserves the ${profile} grant and customized operation ceiling`, async () => {
      const patch = resolveGrantProfile({ profile, sourceId: 'default', boundTools: ['search'] });
      const created = await provider.registerClientManual(`ttl-preserve-${profile}`, ['client_credentials'], patch.scopes!.join(' '), [], 'default', undefined, undefined, undefined, patch);
      if (profile === 'memory-writer') {
        await rescopeClientGrant(engine, created.clientId, { allowedOperations: ['search'] }, { actor: 'test' });
      }
      const before = await readClientGrant(engine, created.clientId);
      const input = { name: before.clientName, harness: 'muse', url: 'https://brain.example.com/mcp',
        clientId: created.clientId, expectedRevision: before.revision, patch: { tokenTtlSeconds: 7200 } };
      const preview = await provisionHarnessGrant(engine, { ...input, dryRun: true }, 'test');
      expect(preview.grant).toEqual({ ...before, revision: before.revision + 1, tokenTtlSeconds: 7200 });
      expect(await readClientGrant(engine, created.clientId)).toEqual(before);
      const changed = await provisionHarnessGrant(engine, input, 'test');
      expect(changed.grant).toEqual(preview.grant);
      expect(changed.credentials).toBeNull();
      await expect(provider.exchangeClientCredentials(created.clientId, created.clientSecret!)).resolves.toHaveProperty('access_token');
    });
  }

  test('explicit harness profile changes regrant operations while preserving existing coding fences', async () => {
    const created = await memoryClient('explicit-regrant-example');
    await rescopeClientGrant(engine, created.clientId, { allowedOperations: ['search'], boundSlugPrefixes: ['existing-example/'] }, { actor: 'test' });
    const before = await readClientGrant(engine, created.clientId);
    const input = { name: before.clientName, harness: 'codex', url: 'https://brain.example.com/mcp', clientId: created.clientId,
      expectedRevision: before.revision, profile: 'coding-agent' as const, dryRun: true };
    const changed = await provisionHarnessGrant(engine, input, 'test');
    expect(changed.grant.profile).toBe('coding-agent');
    expect(changed.grant.allowedOperations).toContain('put_page');
    expect(changed.grant.boundSlugPrefixes).toEqual(['existing-example/']);
    expect(changed.grant.surface).toBe('starter');
    const cleared = await provisionHarnessGrant(engine, { ...input, profile: 'memory-writer', patch: { boundSlugPrefixes: null } }, 'test');
    expect(cleared.grant.boundSlugPrefixes).toBeNull();
    expect(cleared.grant.allowedOperations).toContain('remember');
  });

  test('archived read sources disappear on the next verification and inactive primary source disables capabilities', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('grant-extra-example', 'grant-extra-example')");
    const created = await provider.registerClientManual('archive-example', ['client_credentials'], 'read', [], 'default', ['default', 'grant-extra-example']);
    const tokens = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'grant-extra-example'");
    expect((await provider.verifyAccessToken(tokens.access_token) as unknown as AuthInfo).allowedSources).toEqual(['default']);
    await expect(rescopeClientGrant(engine, created.clientId, { sourceId: 'grant-extra-example' }, { actor: 'test' })).rejects.toThrow('source_inactive');
  });

  test('legacy NULL read metadata safely falls back to its own source', async () => {
    const created = await memoryClient('legacy-null-reads-example');
    const token = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    await engine.executeRaw('ALTER TABLE oauth_clients ALTER COLUMN federated_read DROP NOT NULL');
    try {
      await engine.executeRaw('UPDATE oauth_clients SET federated_read = NULL WHERE client_id = $1', [created.clientId]);
      expect((await provider.verifyAccessToken(token.access_token) as unknown as AuthInfo).allowedSources).toEqual(['default']);
    } finally {
      await engine.executeRaw("UPDATE oauth_clients SET federated_read = ARRAY['default'] WHERE client_id = $1", [created.clientId]);
      await engine.executeRaw('ALTER TABLE oauth_clients ALTER COLUMN federated_read SET NOT NULL');
    }
  });

  test('shared operation eligibility honors explicit snapshots and refuses degraded grants', () => {
    const search = operations.find(op => op.name === 'search')!;
    expect(opAllowedForBoundClient({ allowedOperations: [] }, search)).toBe(false);
    expect(opAllowedForBoundClient({ allowedOperations: ['search'] }, search)).toBe(true);
    expect(opAllowedForBoundClient({ allowedOperations: null }, search)).toBe(true);
    expect(opAllowedForBoundClient({ grantProjectionDegraded: true }, search)).toBe(false);
  });

  test('repeat repair is idempotent and rejects immutable metadata in patches', async () => {
    const created = await memoryClient('idempotent-repair-example');
    const before = await readClientGrant(engine, created.clientId);
    const result = await rescopeClientGrant(engine, created.clientId, { budgetUsdPerDay: null }, { actor: 'test', repair: true });
    expect(result.revision).toBe(before.revision);
    await expect(rescopeClientGrant(engine, created.clientId, { clientId: 'other' } as any, { actor: 'test' })).rejects.toThrow('Unknown grant field');
    expect(await engine.executeRaw('SELECT id FROM oauth_grant_audit WHERE client_id = $1', [created.clientId])).toHaveLength(1);
  });

  test('admin preview validates profiles and bindings without creating clients or audits', async () => {
    const request = parseAdminGrantRequest({ profile: 'delegating-agent', boundTools: ['search'], budgetUsdPerDay: 'unlimited', dryRun: true });
    const preview = await previewNewAdminGrant(engine, 'preview-only-example', request.patch, { sourceId: 'default', scopes: 'read' });
    expect(preview.scopes).toContain('agent');
    expect(preview.boundMaxConcurrent).toBe(1);
    expect(preview.budgetUsdPerDay).toBeNull();
    expect(await engine.executeRaw("SELECT client_id FROM oauth_clients WHERE client_name = 'preview-only-example'")).toHaveLength(0);
    expect(() => parseAdminGrantRequest({ profile: 'full' })).toThrow('explicit non-empty');
    for (const malformed of [{ tokenTtl: 31536000 }, { tokenTtl: -1 }, { dryRun: 'true' }, { expectedRevision: 0.5 }, { boundTools: 'search' }, { budgetUsdPerDay: -1 }, { boundMaxConcurrent: 0 }]) {
      expect(() => parseAdminGrantRequest(malformed)).toThrow();
    }
  });

  test('a missing new-profile snapshot fails closed instead of becoming a legacy full catalog', async () => {
    const created = await memoryClient('missing-snapshot-example');
    const tokens = await provider.exchangeClientCredentials(created.clientId, created.clientSecret!);
    await engine.executeRaw('UPDATE oauth_clients SET allowed_operations = NULL WHERE client_id = $1', [created.clientId]);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  test('explicit widening freezes original legacy job cap and job namespace atomically', async () => {
    const created = await provider.registerClientManual('legacy-job-ceiling-example', ['client_credentials'], 'read write agent', [], 'default', undefined, undefined, undefined,
      resolveGrantProfile({ profile: 'delegating-agent', sourceId: 'default', boundTools: ['search'] }));
    await rescopeClientGrant(engine, created.clientId, { budgetUsdPerDay: '2.50', boundMaxConcurrent: 2 }, { actor: 'test' });
    const data = JSON.stringify({ __owner_client_id: created.clientId, allowed_tools: ['search'], source_id: 'default' });
    const [job] = await engine.executeRaw("INSERT INTO minion_jobs (name, status, data, submission_authority) VALUES ('subagent', 'paused', $1::text::jsonb, '{\"version\":1,\"kind\":\"application\"}'::jsonb) RETURNING id", [data]);
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [job.id]);
    await rescopeClientGrant(engine, created.clientId, { budgetUsdPerDay: null, boundMaxConcurrent: 9 }, { actor: 'test' });
    const [row] = await engine.executeRaw('SELECT data FROM minion_jobs WHERE id = $1', [job.id]);
    const frozen = (row.data as any).__delegation_grant;
    expect(frozen.budgetUsdPerDay).toBe('2.50');
    expect(frozen.maxConcurrent).toBe(2);
    expect(frozen.sourceId).toBe('default');
    expect(frozen.tools).toEqual(['search']);
    expect(frozen.allowedOperations).toContain('submit_agent');
    expect(frozen.readSources).toEqual(['default']);
    expect(frozen.namespace).toBe('job');
    expect(frozen.slugPrefixes).toEqual(['wiki/agents/{job_id}/*']);
    expect((await readClientGrant(engine, created.clientId)).budgetUsdPerDay).toBeNull();
  });

  test('migration installs grant constraints even without delegated clients', async () => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_complete_agent_grant');
    await repairLegacyClientGrants(engine);
    await expect(engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read)
      VALUES ('empty-migration-invalid-example', 'empty-migration-invalid-example', 'agent', 'default', ARRAY['default'])`))
      .rejects.toThrow('oauth_clients_complete_agent_grant');
  });

  test('migration narrows invalid agent grants, preserves valid job namespace and other credentials', async () => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_complete_agent_grant');
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, bound_tools, bound_source_id)
      VALUES ('legacy-invalid-example', 'legacy-invalid-example', 'read write agent', 'default', ARRAY['default'], NULL, NULL),
             ('legacy-valid-example', 'legacy-valid-example', 'agent', 'default', ARRAY['default'], ARRAY['search'], 'default')`);
    await repairLegacyClientGrants(engine);
    const invalid = await readClientGrant(engine, 'legacy-invalid-example');
    expect(invalid.scopes).toEqual(['read', 'write']);
    expect(invalid.allowedOperations).toBeNull();
    expect(invalid.repairReasons).toContain('delegated_tools_missing');
    const valid = await readClientGrant(engine, 'legacy-valid-example');
    expect(valid.scopes).toEqual(['agent']);
    expect(valid.delegatedNamespace).toBe('job');
    await expect(engine.executeRaw("UPDATE oauth_clients SET scope = 'agent' WHERE client_id = 'legacy-invalid-example'")).rejects.toThrow('oauth_clients_complete_agent_grant');
  });

  test('rescope flags distinguish explicit unlimited, repair, profile and optimistic revision', () => {
    const parsed = parseRescopeGrantArgs(['--profile', 'delegating-agent', '--bound-tools', 'search', '--budget-usd-per-day', 'unlimited', '--delegated-namespace', 'job', '--if-version', '3', '--repair', '--dry-run', '--json']);
    expect(parsed.patch.budgetUsdPerDay).toBeNull();
    expect(parsed.expectedRevision).toBe(3);
    expect(parsed.repair).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(() => parseRescopeGrantArgs(['--if-version', '-1'])).toThrow('non-negative');
  });
});

describe('OAuth code and refresh grant boundaries', () => {
  const verifier = 'test-verifier-example-'.repeat(4);
  const challenge = Buffer.from(hashToken(verifier), 'hex').toString('base64url');
  const redirect = 'https://example.test/callback';
  const resource = new URL('https://example.test/mcp');
  async function authorization(authMethod: 'none' | 'client_secret_post') {
    const created = await provider.registerClientManual(`pkce-${authMethod}-example`, ['authorization_code', 'refresh_token'], 'read write', [redirect], 'default', undefined, authMethod);
    const client = (await provider.clientsStore.getClient(created.clientId))!;
    let destination = '';
    await authorizeAsOwner(provider, client, { redirectUri: redirect, codeChallenge: challenge, scopes: ['read', 'write'], resource }, { redirect(url: string) { destination = url; } } as Response);
    return { client, code: new URL(destination).searchParams.get('code')! };
  }

  for (const method of ['none', 'client_secret_post'] as const) {
    test(`${method}: invalid PKCE or resource preserves code; valid exchange binds audience`, async () => {
      const { client, code } = await authorization(method);
      await expect(provider.exchangeAuthorizationCode(client, code, 'x'.repeat(64), redirect, resource)).rejects.toThrow('PKCE');
      await expect(provider.exchangeAuthorizationCode(client, code, verifier, redirect, new URL('https://other.example/mcp'))).rejects.toThrow('resource');
      const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, redirect);
      expect((await provider.verifyAccessToken(tokens.access_token)).resource?.toString()).toBe(resource.toString());
      await expect(provider.exchangeAuthorizationCode(client, code, verifier, redirect)).rejects.toThrow('not found');
    });
  }

  test('refresh is capped by both original token scopes and live grant', async () => {
    const { client, code } = await authorization('none');
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, redirect);
    await rescopeClientGrant(engine, client.client_id, { scopes: ['read'] }, { actor: 'test' });
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.scope).toBe('read');
    await rescopeClientGrant(engine, client.client_id, { scopes: ['read', 'write', 'admin'] }, { actor: 'test' });
    const again = await provider.exchangeRefreshToken(client, refreshed.refresh_token!);
    expect(again.scope).toBe('read');
  });
});
