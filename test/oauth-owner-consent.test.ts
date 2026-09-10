import { afterAll, beforeAll, expect, test } from 'bun:test';
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
