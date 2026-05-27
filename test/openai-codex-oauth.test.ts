import { describe, expect, test } from 'bun:test';
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
  refreshOpenAICodexToken,
  singleFlightRefresh,
} from '../src/core/ai/openai-codex/oauth.ts';
import { InMemoryTokenStore } from '../src/core/ai/openai-codex/token-store.ts';

describe('openai-codex OAuth primitives', () => {
  test('creates PKCE verifier/challenge pair with S256-safe characters', async () => {
    const pair = await createPkcePair(() => new Uint8Array(32).fill(7));
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.method).toBe('S256');
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  test('builds authorization URL with loopback redirect, state, and PKCE challenge', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1:49152/callback',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      extraParams: {
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs',
      },
    });
    expect(url.origin + url.pathname).toBe('https://auth.example.test/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/callback');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
  });

  test('callback parser rejects non-loopback and invalid state', () => {
    expect(() => parseOAuthCallback('http://evil.test/callback?code=x&state=s', 's')).toThrow(/loopback/i);
    expect(() => parseOAuthCallback('http://127.0.0.1:49152/callback?code=x&state=wrong', 'expected')).toThrow(/state/i);
  });

  test('callback parser returns authorization code and rejects OAuth errors', () => {
    expect(parseOAuthCallback('http://127.0.0.1:49152/callback?code=abc&state=s', 's')).toEqual({ code: 'abc' });
    expect(() => parseOAuthCallback('http://localhost:49152/callback?error=access_denied&state=s', 's')).toThrow(/access_denied/);
  });

  test('exchanges authorization code with PKCE without leaking code in errors', async () => {
    await expect(exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'client-123',
      code: 'secret-auth-code-1234567890',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://127.0.0.1:49152/callback',
      fetch: async () => new Response('bad access_token=access-token-secret-1234567890', { status: 400 }),
    })).rejects.toThrow(/\[REDACTED\]/);
    await expect(exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'client-123',
      code: 'secret-auth-code-1234567890',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://127.0.0.1:49152/callback',
      fetch: async () => new Response('bad access_token=access-token-secret-1234567890', { status: 400 }),
    })).rejects.not.toThrow(/access-token-secret/);
  });

  test('exchanges authorization code with PKCE and computes absolute expiry', async () => {
    const calls: { url: string; body: string }[] = [];
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'client-123',
      code: 'secret-auth-code-1234567890',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://127.0.0.1:49152/callback',
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ access_token: 'access-token-secret-1234567890', refresh_token: 'refresh-token-secret-1234567890', expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('grant_type=authorization_code');
    expect(calls[0].body).toContain('code=secret-auth-code-1234567890');
    expect(token.expires_at).toBe('2026-05-24T13:00:00.000Z');
  });

  test('refreshes token and preserves old refresh token when response omits rotation', async () => {
    const token = await refreshOpenAICodexToken({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'client-123',
      refreshToken: 'refresh-token-secret-1234567890',
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      fetch: async () => new Response(JSON.stringify({ access_token: 'new-access-token-secret-1234567890', expires_in: 60, token_type: 'Bearer' }), { status: 200 }),
    });
    expect(token.access_token).toBe('new-access-token-secret-1234567890');
    expect(token.refresh_token).toBe('refresh-token-secret-1234567890');
    expect(token.expires_at).toBe('2026-05-24T12:01:00.000Z');
  });

  test('single-flight refresh stores one result for concurrent callers', async () => {
    const store = new InMemoryTokenStore();
    await store.set({ access_token: 'old-access-token-secret-1234567890', refresh_token: 'refresh-token-secret-1234567890', expires_at: '2026-05-24T11:00:00.000Z' });
    let calls = 0;
    const refresh = singleFlightRefresh(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { access_token: 'new-access-token-secret-1234567890', refresh_token: 'refresh-token-secret-1234567890', expires_at: '2026-05-24T13:00:00.000Z' };
    }, store);
    const [a, b, c] = await Promise.all([refresh(), refresh(), refresh()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect((await store.get())?.access_token).toBe('new-access-token-secret-1234567890');
  });
});
