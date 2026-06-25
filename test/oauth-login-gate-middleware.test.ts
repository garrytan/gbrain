/**
 * Integration-style test of the OPT-IN Google login-gate middleware shape
 * (the /authorize gate wired in src/commands/serve-http.ts).
 *
 * Spins up a minimal Express app that mounts the SAME gate middleware logic the
 * server uses — verifySession on the login cookie, otherwise sign a state +
 * 302 to the Google auth URL — and exercises the three required cases over real
 * HTTP with `fetch` (redirect:'manual'):
 *
 *   1. gate DISABLED            → request passes through (200)
 *   2. gate ENABLED, no cookie  → 302 to /login/google flow (accounts.google.com)
 *   3. gate ENABLED, valid cookie → passes through (200)
 *
 * The full OAuth provider + DB are intentionally out of scope here; the gate's
 * decision (next vs redirect) is the unit under test and is pure cookie/state
 * logic from oauth-google-login.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import {
  signSession,
  signPkce,
  buildGoogleAuthUrl,
  signState,
  verifySession,
  generateCodeVerifier,
  codeChallengeS256,
  generateNonce,
  LOGIN_SESSION_COOKIE,
  LOGIN_PKCE_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_TTL_SECONDS,
  GOOGLE_AUTH_URL,
} from '../src/core/oauth-google-login.ts';
import { randomUUID } from 'node:crypto';

const SECRET = 'integration-session-secret-long-enough';
const HD = 'example.com';
const CLIENT_ID = 'cid';

/** Build a tiny app whose /authorize is gated exactly like serve-http.ts. */
function buildApp(opts: { gateEnabled: boolean; publicBaseUrl: string }) {
  const app = express();
  app.use(cookieParser());

  if (opts.gateEnabled) {
    app.use('/authorize', (req: Request, res: Response, next: NextFunction) => {
      const cookie = (req.cookies as Record<string, string> | undefined)?.[LOGIN_SESSION_COOKIE];
      const session = verifySession(cookie, SECRET);
      if (session) return next();
      const now = Math.floor(Date.now() / 1000);
      const verifier = generateCodeVerifier();
      const nonce = generateNonce();
      const state = signState(
        { return_url: req.originalUrl, nonce: randomUUID(), exp: now + STATE_TTL_SECONDS },
        SECRET,
      );
      const pkce = signPkce({ verifier, nonce, exp: now + STATE_TTL_SECONDS }, SECRET);
      res.cookie(LOGIN_PKCE_COOKIE, pkce, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/login/google/callback',
        maxAge: STATE_TTL_SECONDS * 1000,
      });
      res.redirect(
        buildGoogleAuthUrl({
          clientId: CLIENT_ID,
          redirectUri: `${opts.publicBaseUrl}/login/google/callback`,
          hd: HD,
          state,
          codeChallenge: codeChallengeS256(verifier),
          nonce,
        }),
      );
    });
  }

  // Stand-in for the SDK's /authorize handler: if control reaches here, the
  // gate passed (or was disabled).
  app.get('/authorize', (_req: Request, res: Response) => {
    res.status(200).json({ reached: 'authorize' });
  });

  return app;
}

function listen(app: express.Express): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let disabledSrv: { url: string; server: Server };
let enabledSrv: { url: string; server: Server };

beforeAll(async () => {
  disabledSrv = await listen(buildApp({ gateEnabled: false, publicBaseUrl: 'http://127.0.0.1' }));
  enabledSrv = await listen(buildApp({ gateEnabled: true, publicBaseUrl: enabledBaseUrlPlaceholder() }));
});

// The publicBaseUrl in the redirect_uri doesn't affect the gate decision, so a
// placeholder is fine; the redirect target's host is accounts.google.com.
function enabledBaseUrlPlaceholder() {
  return 'http://127.0.0.1';
}

afterAll(() => {
  disabledSrv?.server.close();
  enabledSrv?.server.close();
});

describe('login-gate middleware', () => {
  test('gate DISABLED → /authorize passes through (200)', async () => {
    const r = await fetch(`${disabledSrv.url}/authorize?response_type=code`, { redirect: 'manual' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reached: 'authorize' });
  });

  test('gate ENABLED + no cookie → 302 to Google auth URL', async () => {
    const r = await fetch(`${enabledSrv.url}/authorize?response_type=code&client_id=x`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc.startsWith(GOOGLE_AUTH_URL)).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get('hd')).toBe(HD);
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('response_type')).toBe('code');
    // state must be present and signed (has the body.sig shape)
    expect((u.searchParams.get('state') ?? '').includes('.')).toBe(true);
    // PKCE + nonce on the Google leg (MEDIUM-1 + MEDIUM-2).
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect((u.searchParams.get('code_challenge') ?? '').length).toBeGreaterThan(0);
    expect((u.searchParams.get('nonce') ?? '').length).toBeGreaterThan(0);
    // The browser-bound PKCE cookie is set on the redirect, scoped to the
    // callback path and HttpOnly.
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${LOGIN_PKCE_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain('Path=/login/google/callback');
  });

  test('gate ENABLED + valid login cookie → passes through (200)', async () => {
    const session = signSession(
      { email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
      SECRET,
    );
    const r = await fetch(`${enabledSrv.url}/authorize?response_type=code`, {
      redirect: 'manual',
      headers: { cookie: `${LOGIN_SESSION_COOKIE}=${session}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reached: 'authorize' });
  });

  test('gate ENABLED + tampered cookie → still redirects (302)', async () => {
    const r = await fetch(`${enabledSrv.url}/authorize`, {
      redirect: 'manual',
      headers: { cookie: `${LOGIN_SESSION_COOKIE}=garbage.value` },
    });
    expect(r.status).toBe(302);
    expect((r.headers.get('location') ?? '').startsWith(GOOGLE_AUTH_URL)).toBe(true);
  });
});
