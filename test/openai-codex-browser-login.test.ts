import { describe, expect, test } from 'bun:test';
import { InMemoryTokenStore } from '../src/core/ai/openai-codex/token-store.ts';
import {
  createLoopbackRedirectUri,
  loginWithBrowserOpenAICodex,
  waitForLoopbackOAuthCallback,
  type BrowserLoginCallbackWaiter,
} from '../src/core/ai/openai-codex/browser-login.ts';

describe('openai-codex browser localhost login wrapper', () => {
  test('creates loopback redirect uri with explicit host and port', () => {
    expect(createLoopbackRedirectUri({ host: '127.0.0.1', port: 48888, path: '/oauth/callback' }))
      .toBe('http://127.0.0.1:48888/oauth/callback');
  });

  test('opens browser, waits for callback, exchanges code, and stores token', async () => {
    const opened: string[] = [];
    const store = new InMemoryTokenStore();
    const waitForCallback: BrowserLoginCallbackWaiter = async ({ state, redirectUri }) => ({
      callbackUrl: `${redirectUri}?code=auth-code-secret-1234567890&state=${state}`,
    });

    const result = await loginWithBrowserOpenAICodex({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'codex-client-id',
      scopes: ['openid', 'profile', 'offline_access'],
      redirect: { host: '127.0.0.1', port: 48888, path: '/oauth/callback' },
      tokenStore: store,
      randomState: () => 'state-123',
      randomPkceBytes: () => new Uint8Array(32).fill(7),
      openBrowser: async url => { opened.push(url.toString()); },
      waitForCallback,
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      fetch: async (_url, init) => {
        const body = init?.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('auth-code-secret-1234567890');
        expect(body.get('redirect_uri')).toBe('http://127.0.0.1:48888/oauth/callback');
        expect(body.get('code_verifier')).toBeTruthy();
        return new Response(JSON.stringify({
          access_token: 'access-token-secret-1234567890',
          refresh_token: 'refresh-token-secret-1234567890',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { status: 200 });
      },
    });

    expect(opened).toHaveLength(1);
    const authUrl = new URL(opened[0]!);
    expect(authUrl.searchParams.get('state')).toBe('state-123');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:48888/oauth/callback');
    expect(result.redirectUri).toBe('http://127.0.0.1:48888/oauth/callback');
    expect(result.token.expires_at).toBe('2026-05-24T13:00:00.000Z');
    expect((await store.get())?.access_token).toBe('access-token-secret-1234567890');
  });

  test('rejects callback state mismatch and does not store token', async () => {
    const store = new InMemoryTokenStore();
    await expect(loginWithBrowserOpenAICodex({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'codex-client-id',
      scopes: ['openid'],
      redirect: { host: '127.0.0.1', port: 48888, path: '/oauth/callback' },
      tokenStore: store,
      randomState: () => 'expected-state',
      openBrowser: async () => {},
      waitForCallback: async ({ redirectUri }) => ({ callbackUrl: `${redirectUri}?code=abc&state=wrong-state` }),
      fetch: async () => new Response('{}', { status: 200 }),
    })).rejects.toThrow('state mismatch');
    expect(await store.get()).toBeNull();
  });

  test('redacts callback/token material from login failures', async () => {
    const store = new InMemoryTokenStore();
    await expect(loginWithBrowserOpenAICodex({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'codex-client-id',
      scopes: ['openid'],
      redirect: { host: '127.0.0.1', port: 48888, path: '/oauth/callback' },
      tokenStore: store,
      randomState: () => 'state-123',
      openBrowser: async () => {},
      waitForCallback: async () => { throw new Error('failed access-token-secret-1234567890 sk-proj-abcdefghijklmnop'); },
      fetch: async () => new Response('{}', { status: 200 }),
    })).rejects.toThrow('[REDACTED]');
  });

  test('loopback callback waiter resolves one localhost HTTP callback then closes', async () => {
    const waiter = waitForLoopbackOAuthCallback({ timeoutMs: 1000 });
    const promise = waiter({ state: 'state-123', redirectUri: 'http://127.0.0.1:48991/oauth/callback' });
    const response = await fetch('http://127.0.0.1:48991/oauth/callback?code=abc&state=state-123');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('GBrain OpenAI Codex login complete');
    const result = await promise;
    expect(result.callbackUrl).toBe('http://127.0.0.1:48991/oauth/callback?code=abc&state=state-123');
    await expect(fetch('http://127.0.0.1:48991/oauth/callback?code=again&state=state-123')).rejects.toThrow();
  });
});
