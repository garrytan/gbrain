/**
 * A self-registered (DCR) connector after the owner changes its scope with
 * `gbrain auth rescope --client <id> --scopes ...`.
 *
 * Browser connectors such as claude.ai repeat the scope they registered with on
 * every /authorize. Consent used to grant only that request intersected with the
 * client's grant, so after the owner widened a `read` connector to
 * `read write` every reconnect still came back read-only.
 *
 * Both directions are pinned here:
 * - widening reaches the connector at its next owner consent, never through a
 *   refresh (RFC 6749 §6) and never past what the owner set;
 * - narrowing takes effect at once, on issued access tokens, on refreshes of
 *   issued refresh tokens and on every new consent;
 * - a connector cannot widen itself, and operator-registered clients keep
 *   "an explicit subset is honored".
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { rescopeClientGrant } from '../src/core/grants/service.ts';
import { TEST_PKCE_VERIFIER, TEST_PKCE_CHALLENGE } from './helpers/oauth.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))), sql: sqlQueryForEngine(engine) });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM oauth_tokens');
  await (engine as any).db.exec('DELETE FROM oauth_codes');
  await (engine as any).db.exec('DELETE FROM oauth_clients');
});

const REDIRECT = 'https://connector.example/oauth/callback';

async function registerConnector(scope: string): Promise<string> {
  const info = await provider.clientsStore.registerClient!({
    client_name: 'connector-example', redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'], scope, token_endpoint_auth_method: 'none',
  } as any);
  return info.client_id;
}

/** /authorize as the connector, then the owner approves; returns what the owner saw and the tokens. */
async function connect(clientId: string, scopes: string[]) {
  const client = (await provider.clientsStore.getClient(clientId))!;
  let pendingUrl = '';
  await provider.authorize(client, { scopes, codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT, state: 's' } as any,
    { redirect: (url: string) => { pendingUrl = url; } } as any);
  const id = new URL(pendingUrl, 'https://brain.example').searchParams.get('oauth_request')!;
  const shown = provider.grants.details(id).scopes;
  const code = new URL(await provider.grants.decide(id, true)).searchParams.get('code')!;
  const tokens = await provider.exchangeAuthorizationCode(client, code, TEST_PKCE_VERIFIER, REDIRECT);
  return { shown: [...shown].sort(), tokens };
}

async function refresh(clientId: string, refreshToken: string) {
  const client = (await provider.clientsStore.getClient(clientId))!;
  return provider.exchangeRefreshToken(client, refreshToken);
}

async function scopesOf(accessToken: string): Promise<string[]> {
  return [...(await provider.verifyAccessToken(accessToken)).scopes].sort();
}

const rescope = (clientId: string, scopes: string[]) =>
  rescopeClientGrant(engine, clientId, { scopes }, { actor: 'operator:cli' });

describe('owner widens a self-registered connector', () => {
  test('its next connection carries the widened scope, and the owner sees it on the consent page', async () => {
    const clientId = await registerConnector('read');
    const first = await connect(clientId, ['read']);
    expect(await scopesOf(first.tokens.access_token)).toEqual(['read']);

    await rescope(clientId, ['read', 'write']);

    const again = await connect(clientId, ['read']);
    expect(again.shown).toEqual(['read', 'write']);
    expect(await scopesOf(again.tokens.access_token)).toEqual(['read', 'write']);
    expect(again.tokens.scope!.split(' ').sort()).toEqual(['read', 'write']);
    expect(await scopesOf((await refresh(clientId, again.tokens.refresh_token!)).access_token)).toEqual(['read', 'write']);
  });

  test('tokens issued before the widening, and their refreshes, keep the scope the owner approved then', async () => {
    const clientId = await registerConnector('read');
    const first = await connect(clientId, ['read']);
    await rescope(clientId, ['read', 'write']);
    expect(await scopesOf(first.tokens.access_token)).toEqual(['read']);
    expect(await scopesOf((await refresh(clientId, first.tokens.refresh_token!)).access_token)).toEqual(['read']);
  });

  test('a connection never gets more than the owner set', async () => {
    const clientId = await registerConnector('read');
    await rescope(clientId, ['read', 'write']);
    const asked = await connect(clientId, ['read', 'write', 'admin']);
    expect(await scopesOf(asked.tokens.access_token)).toEqual(['read', 'write']);
  });
});

describe('a connector cannot widen itself', () => {
  test('asking for more than its grant on /authorize gives only its grant', async () => {
    const clientId = await registerConnector('read');
    const asked = await connect(clientId, ['read', 'write', 'admin']);
    expect(asked.shown).toEqual(['read']);
    expect(await scopesOf(asked.tokens.access_token)).toEqual(['read']);
  });

  test('a request naming nothing it holds is still granted nothing', async () => {
    const clientId = await registerConnector('read');
    const asked = await connect(clientId, ['admin']);
    expect(asked.shown).toEqual([]);
    expect(await scopesOf(asked.tokens.access_token)).toEqual([]);
  });

  test('a refresh cannot ask past the refresh token it holds', async () => {
    const clientId = await registerConnector('read');
    const first = await connect(clientId, ['read']);
    await rescope(clientId, ['read', 'write']);
    const client = (await provider.clientsStore.getClient(clientId))!;
    await expect(provider.exchangeRefreshToken(client, first.tokens.refresh_token!, ['read', 'write'])).rejects.toThrow(/exceeds refresh token grant/);
  });
});

describe('owner narrows a self-registered connector', () => {
  test('takes effect at once on issued access tokens, refreshes and new connections', async () => {
    const clientId = await registerConnector('read write');
    const first = await connect(clientId, ['read', 'write']);
    expect(await scopesOf(first.tokens.access_token)).toEqual(['read', 'write']);

    await rescope(clientId, ['read']);

    expect(await scopesOf(first.tokens.access_token)).toEqual(['read']);
    const refreshed = await refresh(clientId, first.tokens.refresh_token!);
    expect(await scopesOf(refreshed.access_token)).toEqual(['read']);
    expect(refreshed.scope).toBe('read');
    const again = await connect(clientId, ['read', 'write']);
    expect(again.shown).toEqual(['read']);
    expect(await scopesOf(again.tokens.access_token)).toEqual(['read']);
  });

  test('a code approved before the narrowing is exchanged at the narrowed scope', async () => {
    const clientId = await registerConnector('read write');
    const client = (await provider.clientsStore.getClient(clientId))!;
    let pendingUrl = '';
    await provider.authorize(client, { scopes: ['read', 'write'], codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT, state: 's' } as any,
      { redirect: (url: string) => { pendingUrl = url; } } as any);
    const id = new URL(pendingUrl, 'https://brain.example').searchParams.get('oauth_request')!;
    const code = new URL(await provider.grants.decide(id, true)).searchParams.get('code')!;
    await rescope(clientId, ['read']);
    const tokens = await provider.exchangeAuthorizationCode((await provider.clientsStore.getClient(clientId))!, code, TEST_PKCE_VERIFIER, REDIRECT);
    expect(await scopesOf(tokens.access_token)).toEqual(['read']);
  });
});

describe('operator-registered clients are unchanged', () => {
  test('an explicit subset is still honored after a widening', async () => {
    const reg = await provider.registerClientManual('operator-example', ['authorization_code', 'refresh_token'], 'read', [REDIRECT]);
    await rescope(reg.clientId, ['read', 'write']);
    const asked = await connect(reg.clientId, ['read']);
    expect(asked.shown).toEqual(['read']);
    expect(await scopesOf(asked.tokens.access_token)).toEqual(['read']);
  });
});
