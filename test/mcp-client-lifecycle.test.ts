import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, resolveGrantProfile, rescopeClientGrant } from '../src/core/grants/service.ts';
import { mutateClientLifecycle } from '../src/core/grants/lifecycle.ts';
import { currentDelegationGrant, DelegationDeniedError } from '../src/core/minions/delegated-policy.ts';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import express from 'express';
import { mountAdminClients } from '../src/commands/serve-http-clients.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

async function registered() {
  const patch = resolveGrantProfile({ profile: 'delegating-agent', sourceId: 'default', boundTools: ['search'] });
  return provider.registerClientManual('lifecycle-example', ['client_credentials', 'authorization_code', 'refresh_token'], patch.scopes!.join(' '),
    ['https://client.example/callback'], 'default', undefined, 'client_secret_post', undefined, patch);
}
async function pending(clientId: string) {
  return provider.grants.begin(clientId, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: 'https://client.example/callback' });
}

test('preview is inert, apply requires confirmation and the reviewed revision', async () => {
  const c = await registered();
  const token = await provider.exchangeClientCredentials(c.clientId, c.clientSecret!);
  const preview = await mutateClientLifecycle(engine, c.clientId, 'delete', { actor: 'test' });
  expect(preview.dry_run).toBe(true);
  await expect(provider.verifyAccessToken(token.access_token)).resolves.toBeDefined();
  await expect(mutateClientLifecycle(engine, c.clientId, 'delete', { actor: 'test', dryRun: false })).rejects.toThrow('preview first');
  await rescopeClientGrant(engine, c.clientId, { budgetUsdPerDay: '1.00' }, { actor: 'test' });
  await expect(mutateClientLifecycle(engine, c.clientId, 'delete', { actor: 'test', dryRun: false, yes: true, expectedRevision: preview.before.revision })).rejects.toThrow('fresh lifecycle preview');
  await expect(provider.verifyAccessToken(token.access_token)).resolves.toBeDefined();
});

test('invalidation clears access, refresh and codes, cancels pending approval, and retains secret and delegated authority', async () => {
  const c = await registered();
  const client = (await provider.clientsStore.getClient(c.clientId))!;
  const code = new URL(await provider.grants.decide(await pending(c.clientId), true)).searchParams.get('code')!;
  const pair = await provider.exchangeAuthorizationCode(client, code, TEST_PKCE_VERIFIER, 'https://client.example/callback');
  await provider.grants.decide(await pending(c.clientId), true); // outstanding authorization code
  const approval = await pending(c.clientId);
  const before = await readClientGrant(engine, c.clientId);
  const result = await mutateClientLifecycle(engine, c.clientId, 'invalidate-tokens', { actor: 'test', dryRun: false, yes: true, expectedRevision: before.revision });
  expect(result.grant!.revision).toBe(before.revision + 1);
  expect(result.grant!.revoked).toBe(false);
  await expect(provider.verifyAccessToken(pair.access_token)).rejects.toThrow();
  await expect(provider.exchangeRefreshToken(client, pair.refresh_token!)).rejects.toThrow();
  expect(await engine.executeRaw('SELECT * FROM oauth_codes WHERE client_id = $1', [c.clientId])).toHaveLength(0);
  await expect(provider.grants.decide(approval, true)).rejects.toThrow('permissions changed');
  await expect(provider.exchangeClientCredentials(c.clientId, c.clientSecret!)).resolves.toBeDefined();
  await expect(currentDelegationGrant(engine, c.clientId)).resolves.toBeDefined();
});

test('revoke then delete deny delegated execution and issuance while retaining request and audit history', async () => {
  const c = await registered();
  await engine.executeRaw("INSERT INTO mcp_request_log(token_name,operation,status) VALUES ($1,'search','success')", [c.clientId]);
  const grant = await readClientGrant(engine, c.clientId);
  const revoked = await mutateClientLifecycle(engine, c.clientId, 'revoke', { actor: 'test', dryRun: false, yes: true, expectedRevision: grant.revision });
  await expect(provider.exchangeClientCredentials(c.clientId, c.clientSecret!)).rejects.toThrow();
  await expect(currentDelegationGrant(engine, c.clientId)).rejects.toBeInstanceOf(DelegationDeniedError);
  await mutateClientLifecycle(engine, c.clientId, 'delete', { actor: 'test', dryRun: false, yes: true, expectedRevision: revoked.grant!.revision });
  await expect(currentDelegationGrant(engine, c.clientId)).rejects.toBeInstanceOf(DelegationDeniedError);
  await expect(currentDelegationGrant(engine, c.clientId)).rejects.toThrow(/client_deleted.*grant a new client and submit a new job/);
  expect(await engine.executeRaw('SELECT * FROM mcp_request_log WHERE token_name = $1', [c.clientId])).toHaveLength(1);
  const audit = await engine.executeRaw<{ after_grant: { deleted: boolean }; action: string }>('SELECT action, after_grant FROM oauth_grant_audit WHERE client_id = $1 ORDER BY revision', [c.clientId]);
  expect(audit.map(a => a.action)).toEqual(['register', 'revoke', 'delete']);
  expect(audit[2].after_grant.deleted).toBe(true);
});

test('transient lookup failures remain retryable errors', async () => {
  const transient = new Error('connection reset');
  const failing = { executeRaw: async () => { throw transient; } } as unknown as BrainEngine;
  await expect(currentDelegationGrant(failing, 'example')).rejects.toBe(transient);
});

test('HTTP lifecycle previews fail without mutation uncertainty while lost apply acknowledgements remain unknown', async () => {
  const c = await registered();
  const token = await provider.exchangeClientCredentials(c.clientId, c.clientSecret!);
  const before = await readClientGrant(engine, c.clientId);
  const uncertain = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async (fn: Parameters<BrainEngine['transaction']>[0]) => {
      await target.transaction(fn); throw new Error('fixture private acknowledgement lost');
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = express();
  mountAdminClients(app, (_req, _res, next) => next(), uncertain, 'https://brain.example/mcp');
  const server = app.listen(0, '127.0.0.1');
  try {
    const { port } = server.address() as { port: number };
    const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/admin/api/clients/${c.clientId}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke', ...body }),
    });
    const preview = await post({ dryRun: true });
    expect(preview.status).toBe(503);
    expect(await preview.json()).toMatchObject({ code: 'administration_unavailable', stage: 'lifecycle', outcome: 'failed' });
    await expect(provider.verifyAccessToken(token.access_token)).resolves.toBeDefined();
    expect((await readClientGrant(engine, c.clientId)).revision).toBe(before.revision);
    const applied = await post({ dryRun: false, yes: true, expectedRevision: before.revision });
    expect(applied.status).toBe(503);
    const receipt = await applied.json();
    expect(receipt).toMatchObject({ code: 'administration_unavailable', stage: 'lifecycle', outcome: 'unknown' });
    expect(JSON.stringify(receipt)).not.toContain('fixture private');
    expect((await readClientGrant(engine, c.clientId)).revoked).toBe(true);
    await expect(provider.verifyAccessToken(token.access_token)).rejects.toThrow();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
