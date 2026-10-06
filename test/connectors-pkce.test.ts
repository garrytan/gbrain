/**
 * connectors-pkce.test.ts — S256 PKCE + authorize URL + loopback (ephemeral port).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  runLoopbackFlow,
} from '../src/core/connectors/oauth-pkce.ts';
import type { OAuthPkceConfig } from '../src/core/connectors/types.ts';

const CFG: OAuthPkceConfig = {
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'app_test',
  scopes: ['openid', 'offline_access'],
  redirectPort: 1455,
};

function b64url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('PKCE', () => {
  test('S256: challenge === base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()));
    expect(verifier.length).toBeGreaterThan(42);
  });

  test('authorize URL carries S256 + state + challenge', () => {
    const url = new URL(buildAuthorizeUrl(CFG, 'CHAL', 'STATE'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('client_id')).toBe('app_test');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/callback');
  });
});

function startFlow(expectedState: string, timeoutMs: number) {
  let reportPort!: (port: number) => void;
  const port = new Promise<number>((resolve) => { reportPort = resolve; });
  const flow = runLoopbackFlow(CFG, 'https://auth.example.com/authorize', expectedState, {
    portOverride: 0,
    onListen: reportPort,
    timeoutMs,
    log: () => {},
  });
  return { flow, port };
}

describe('loopback flow (ephemeral port)', () => {
  test('resolves the code when the redirect carries a matching state', async () => {
    const state = generateState();
    const { flow, port } = startFlow(state, 5000);
    const bound = await port;
    expect(bound).toBeGreaterThan(0);
    expect(bound).not.toBe(CFG.redirectPort);
    const res = await fetch(`http://127.0.0.1:${bound}/callback?code=THE_CODE&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    const { code } = await flow;
    expect(code).toBe('THE_CODE');
  });

  test('rejects on state mismatch (CSRF guard)', async () => {
    const { flow, port } = startFlow('EXPECTED', 5000);
    // Attach the rejection handler synchronously at creation so the reject
    // (which fires as soon as the mismatched callback lands) is never a
    // momentarily-unhandled rejection.
    const captured = flow.then(
      () => { throw new Error('flow should not have resolved'); },
      (e: unknown) => e,
    );
    const res = await fetch(`http://127.0.0.1:${await port}/callback?code=x&state=WRONG`);
    expect(res.status).toBe(400);
    const err = await captured;
    expect(String(err)).toMatch(/state mismatch/i);
  });

  test('times out when no callback arrives', async () => {
    const { flow, port } = startFlow('S', 200);
    expect(await port).toBeGreaterThan(0);
    await expect(flow).rejects.toThrow(/timed out/i);
  });
});
