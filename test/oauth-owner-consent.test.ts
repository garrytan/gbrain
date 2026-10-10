import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resolveGrantProfile, rescopeClientGrant } from '../src/core/grants/service.ts';
import { TEST_PKCE_CHALLENGE } from './helpers/oauth.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({
    sql: sqlQueryForEngine(engine),
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
  });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);

async function pending() {
  const grant = resolveGrantProfile({ profile: 'delegating-agent', sourceId: 'default', boundTools: ['search'] });
  const client = await provider.registerClientManual('consent-profile-example', ['authorization_code'], grant.scopes!.join(' '),
    ['https://client.example.com/callback'], 'default', undefined, 'none', undefined, grant);
  const id = await provider.grants.begin(client.clientId, {
    codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: 'https://client.example.com/callback', scopes: grant.scopes,
  });
  return { id, clientId: client.clientId };
}

test('owner review includes operation and delegation ceilings without creating a code', async () => {
  const { id, clientId } = await pending();
  const details = provider.grants.details(id);
  expect(details.allowedOperations).toContain('submit_agent');
  expect(details.delegatedTools).toEqual(['search']);
  expect(details.delegatedNamespace).toBe('job');
  expect(details.sourceId).toBe('default');
  expect(await engine.executeRaw('SELECT code_hash FROM oauth_codes WHERE client_id = $1', [clientId])).toHaveLength(0);
  // A UI consumer cannot mutate the stored review snapshot through a returned array.
  details.allowedOperations!.push('shell');
  details.delegatedTools!.push('file_list');
  expect(provider.grants.details(id).allowedOperations).not.toContain('shell');
  expect(provider.grants.details(id).delegatedTools).toEqual(['search']);
});

for (const patch of [
  { allowedOperations: ['search'] },
  { boundTools: ['get_page'] },
  { delegatedNamespace: 'prefixes' as const, delegatedSlugPrefixes: ['reviewed-example/'] },
]) {
  test(`changing ${Object.keys(patch).join(', ')} requires a new review and never issues a code`, async () => {
    const { id, clientId } = await pending();
    await rescopeClientGrant(engine, clientId, patch, { actor: 'test' });
    await expect(provider.grants.decide(id, true)).rejects.toThrow('Client permissions changed');
    await expect(provider.grants.decide(id, true)).rejects.toThrow('Restart the connection');
    expect(await engine.executeRaw('SELECT code_hash FROM oauth_codes WHERE client_id = $1', [clientId])).toHaveLength(0);
  });
}

test('unchanged profile grants still require one owner decision', async () => {
  const { id, clientId } = await pending();
  const redirect = new URL(await provider.grants.decide(id, true));
  expect(redirect.origin).toBe('https://client.example.com');
  expect(redirect.searchParams.get('code')).toStartWith('gbrain_code_');
  await expect(provider.grants.decide(id, true)).rejects.toThrow('Restart the connection');
  expect(await engine.executeRaw('SELECT code_hash FROM oauth_codes WHERE client_id = $1', [clientId])).toHaveLength(1);
});

describe('#6202: the owner picks a self-registered client\'s source at its first consent', () => {
  const REDIRECT = 'https://dcr-client.example.com/callback';
  let dcrProvider: GBrainOAuthProvider;
  beforeAll(async () => {
    dcrProvider = new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine),
      transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
      allowClientCredentialsDcr: true,
    });
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki'), ('archive-example', 'archive-example') ON CONFLICT (id) DO NOTHING`);
  });
  beforeEach(async () => {
    await engine.executeRaw(`UPDATE sources SET archived = false WHERE id IN ('wiki', 'archive-example')`);
  });

  async function registerDcr(grantTypes = ['authorization_code']) {
    const client = await dcrProvider.clientsStore.registerClient!({
      client_name: 'self-registered-example', redirect_uris: [REDIRECT], grant_types: grantTypes,
      scope: grantTypes.includes('client_credentials') ? 'read' : 'read write',
      token_endpoint_auth_method: grantTypes.includes('client_credentials') ? 'client_secret_post' : 'none',
    } as never);
    return client.client_id;
  }
  const beginFor = (clientId: string) => dcrProvider.grants.begin(clientId, {
    codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT, scopes: ['read'],
  });
  const clientRow = async (clientId: string) => (await engine.executeRaw<Record<string, unknown>>(
    'SELECT source_id, federated_read, grant_revision, registered_via FROM oauth_clients WHERE client_id = $1', [clientId]))[0]!;
  const audits = (clientId: string) => engine.executeRaw<Record<string, unknown>>(
    'SELECT actor, action, revision FROM oauth_grant_audit WHERE client_id = $1 ORDER BY id', [clientId]);
  const codes = (clientId: string) => engine.executeRaw('SELECT code_hash FROM oauth_codes WHERE client_id = $1', [clientId]);

  test('an eligible request offers the active sources; approving with one moves the client and records consent', async () => {
    const clientId = await registerDcr();
    expect((await clientRow(clientId)).registered_via).toBe('dcr');
    const id = await beginFor(clientId);
    const { sourceChoice } = dcrProvider.grants.details(id);
    expect(sourceChoice.editable).toBe(true);
    expect(sourceChoice.options.map(o => o.id)).toEqual(expect.arrayContaining(['default', 'wiki']));
    expect(new URL(await dcrProvider.grants.decide(id, true, { sourceId: 'wiki' })).searchParams.get('code')).toStartWith('gbrain_code_');
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'wiki', federated_read: ['wiki'], grant_revision: 1 });
    expect((await audits(clientId)).filter(a => a.action === 'consent')).toEqual([{ actor: 'owner', action: 'consent', revision: 1 }]);
    expect(await codes(clientId)).toHaveLength(1);
  });

  test('approving the unchanged source still consumes eligibility; a second pending request fails and later requests are read-only', async () => {
    const clientId = await registerDcr();
    const first = await beginFor(clientId);
    const second = await beginFor(clientId);
    await dcrProvider.grants.decide(first, true);
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', federated_read: ['default'], grant_revision: 1 });
    expect((await audits(clientId)).filter(a => a.action === 'consent')).toHaveLength(1);
    await expect(dcrProvider.grants.decide(second, true)).rejects.toMatchObject({ status: 409, code: 'client_policy_changed' });
    const later = await beginFor(clientId);
    expect(dcrProvider.grants.details(later).sourceChoice).toEqual({ editable: false, options: [] });
    await expect(dcrProvider.grants.decide(later, true, { sourceId: 'wiki' })).rejects.toMatchObject({ status: 403 });
    expect(dcrProvider.grants.details(later).sourceChoice.editable).toBe(false);
    expect(await codes(clientId)).toHaveLength(1);
  });

  test('denial is non-mutating and a choice on a denial is refused before the request is claimed', async () => {
    const clientId = await registerDcr();
    const id = await beginFor(clientId);
    await expect(dcrProvider.grants.decide(id, false, { sourceId: 'wiki' })).rejects.toMatchObject({ status: 403, code: 'invalid_consent' });
    expect(dcrProvider.grants.details(id).sourceChoice.editable).toBe(true);
    expect(new URL(await dcrProvider.grants.decide(id, false)).searchParams.get('error')).toBe('access_denied');
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
    expect(await audits(clientId)).toEqual([]);
  });

  test('a source outside the offered list is refused and the request stays pending', async () => {
    const clientId = await registerDcr();
    const id = await beginFor(clientId);
    await expect(dcrProvider.grants.decide(id, true, { sourceId: 'no-such-source' })).rejects.toMatchObject({ status: 403 });
    expect(dcrProvider.grants.details(id).sourceChoice.editable).toBe(true);
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
  });

  test('an operator-registered client is read-only and a choice creates no code', async () => {
    const { id, clientId } = await pending();
    const before = await clientRow(clientId);
    expect(before).toMatchObject({ source_id: 'default', registered_via: null });
    expect(provider.grants.details(id).sourceChoice).toEqual({ editable: false, options: [] });
    await expect(provider.grants.decide(id, true, { sourceId: 'wiki' })).rejects.toMatchObject({ status: 403 });
    expect(await clientRow(clientId)).toEqual(before);
    expect(await codes(clientId)).toHaveLength(0);
  });

  test('a client_credentials DCR client never reaches consent and stays on default', async () => {
    const clientId = await registerDcr(['client_credentials']);
    await expect(beginFor(clientId)).rejects.toThrow('Authorization code grant not authorized');
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
    const both = await registerDcr(['authorization_code', 'client_credentials']);
    expect(dcrProvider.grants.details(await beginFor(both)).sourceChoice.editable).toBe(false);
  });

  test('a source archived between review and approval fails 409, issues no code and leaves the request terminal', async () => {
    const clientId = await registerDcr();
    const id = await beginFor(clientId);
    expect(dcrProvider.grants.details(id).sourceChoice.options.map(o => o.id)).toContain('archive-example');
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'archive-example'`);
    await expect(dcrProvider.grants.decide(id, true, { sourceId: 'archive-example' })).rejects.toMatchObject({ status: 409, code: 'client_policy_changed' });
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
    expect(await audits(clientId)).toEqual([]);
    expect(await codes(clientId)).toHaveLength(0);
    expect(() => dcrProvider.grants.details(id)).toThrow('Restart the connection');
  });

  test('a client that already holds a token or code is never offered or given the choice', async () => {
    const issued = await registerDcr();
    await engine.executeRaw(`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at) VALUES ($1, 'access', $2, '{read}', 9999999999)`,
      [`synthetic-${issued}`, issued]);
    expect(dcrProvider.grants.details(await beginFor(issued)).sourceChoice.editable).toBe(false);
    const racing = await registerDcr();
    const id = await beginFor(racing);
    await engine.executeRaw(`INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
      VALUES ($1, $2, '{read}', $3, 'S256', $4, 9999999999)`, [`synthetic-${racing}`, racing, TEST_PKCE_CHALLENGE, REDIRECT]);
    await expect(dcrProvider.grants.decide(id, true, { sourceId: 'wiki' })).rejects.toMatchObject({ status: 409, code: 'client_policy_changed' });
    expect(await clientRow(racing)).toMatchObject({ source_id: 'default', grant_revision: 0 });
  });

  test('a pre-migration DCR row (no marker) keeps read-only consent', async () => {
    const clientId = await registerDcr();
    await engine.executeRaw('UPDATE oauth_clients SET registered_via = NULL WHERE client_id = $1', [clientId]);
    const id = await beginFor(clientId);
    expect(dcrProvider.grants.details(id).sourceChoice.editable).toBe(false);
    await dcrProvider.grants.decide(id, true);
    expect(await clientRow(clientId)).toMatchObject({ source_id: 'default', grant_revision: 0 });
  });
});
