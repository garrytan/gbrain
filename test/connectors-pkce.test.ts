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
  });
});

describe('loopback flow (ephemeral port)', () => {
  test('resolves the code when the redirect carries a matching state', async () => {
    const state = generateState();
    const port = 45219; // fixed high port for the test redirect
    const cfg = { ...CFG, redirectPort: port };
    const flow = runLoopbackFlow(cfg, 'https://auth.example.com/authorize', state, {
      timeoutMs: 5000,
      log: () => {},
    });
    // Simulate the browser redirect after a short delay.
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`http://127.0.0.1:${port}/callback?code=THE_CODE&state=${encodeURIComponent(state)}`).catch(() => {});
    const { code } = await flow;
    expect(code).toBe('THE_CODE');
  });

  test('rejects on state mismatch (CSRF guard)', async () => {
    const port = 45220;
    const cfg = { ...CFG, redirectPort: port };
    const flow = runLoopbackFlow(cfg, 'https://auth.example.com/authorize', 'EXPECTED', {
      timeoutMs: 5000,
      log: () => {},
    });
    // Attach the rejection handler synchronously at creation so the reject
    // (which fires as soon as the mismatched callback lands) is never a
    // momentarily-unhandled rejection.
    const captured = flow.then(
      () => { throw new Error('flow should not have resolved'); },
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`http://127.0.0.1:${port}/callback?code=x&state=WRONG`).catch(() => {});
    const err = await captured;
    expect(String(err)).toMatch(/state mismatch/i);
  });

  test('times out when no callback arrives', async () => {
    const port = 45221;
    const cfg = { ...CFG, redirectPort: port };
    await expect(
      runLoopbackFlow(cfg, 'https://auth.example.com/authorize', 'S', { timeoutMs: 200, log: () => {} }),
    ).rejects.toThrow(/timed out/i);
  });
});
