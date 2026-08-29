/**
 * Tests for parseCorsAllowlistOAuth() and resolveCorsOrigin() in
 * src/commands/serve-http.ts.
 *
 * v0.41.3 (T7): pre-fix every OAuth endpoint (/mcp, /token, /authorize,
 * /register, /revoke) used bare `cors()` which defaults to
 * Access-Control-Allow-Origin: * — any web origin could complete a token
 * exchange from a logged-in operator's browser. The fix gates every OAuth
 * surface behind GBRAIN_HTTP_CORS_ORIGIN with default-deny.
 *
 * Two pure functions, no Express integration needed for the unit shape.
 * The end-to-end Express-router behavior (cors middleware + browser
 * preflight) is verified by test/e2e/serve-http-oauth.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import express from 'express';
import cors from 'cors';
import type { Server } from 'http';
import { parseCorsAllowlistOAuth, resolveCorsOrigin, mountOAuthCorsGate } from '../src/commands/serve-http.ts';
import { withEnv } from './helpers/with-env.ts';

describe('parseCorsAllowlistOAuth', () => {
  test('unset → null (default-deny posture)', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: undefined }, async () => {
      expect(parseCorsAllowlistOAuth()).toBeNull();
    });
  });

  test('empty string → null', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: '' }, async () => {
      expect(parseCorsAllowlistOAuth()).toBeNull();
    });
  });

  test('whitespace-only → null (no usable origins)', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: '  ,   ,' }, async () => {
      expect(parseCorsAllowlistOAuth()).toBeNull();
    });
  });

  test('single origin → Set of one', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: 'https://claude.ai' }, async () => {
      const set = parseCorsAllowlistOAuth();
      expect(set).not.toBeNull();
      expect(set!.size).toBe(1);
      expect(set!.has('https://claude.ai')).toBe(true);
    });
  });

  test('comma-separated origins → Set of N', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: 'https://claude.ai,https://chatgpt.com,https://my.app' }, async () => {
      const set = parseCorsAllowlistOAuth();
      expect(set!.size).toBe(3);
      expect(set!.has('https://claude.ai')).toBe(true);
      expect(set!.has('https://chatgpt.com')).toBe(true);
      expect(set!.has('https://my.app')).toBe(true);
    });
  });

  test('whitespace around values is trimmed', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: ' https://a.app , https://b.app ' }, async () => {
      const set = parseCorsAllowlistOAuth();
      expect(set!.has('https://a.app')).toBe(true);
      expect(set!.has('https://b.app')).toBe(true);
    });
  });

  test('case-sensitive match (Origin headers are case-sensitive per RFC 6454)', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: 'https://Claude.AI' }, async () => {
      const set = parseCorsAllowlistOAuth();
      expect(set!.has('https://Claude.AI')).toBe(true);
      expect(set!.has('https://claude.ai')).toBe(false);
    });
  });
});

describe('resolveCorsOrigin', () => {
  test('null allowlist → false (cors middleware sends no Allow-Origin)', () => {
    expect(resolveCorsOrigin(null)).toBe(false);
  });

  test('allowlist + missing Origin → cb(null, true) (same-origin requests aren\'t cross-origin)', () => {
    const fn = resolveCorsOrigin(new Set(['https://claude.ai']));
    expect(typeof fn).toBe('function');
    const calls: Array<{err: Error | null; allow?: boolean}> = [];
    (fn as Function)(undefined, (err: Error | null, allow?: boolean) => calls.push({err, allow}));
    expect(calls).toHaveLength(1);
    expect(calls[0].err).toBeNull();
    expect(calls[0].allow).toBe(true);
  });

  test('allowlist + matching Origin → cb(null, true)', () => {
    const fn = resolveCorsOrigin(new Set(['https://claude.ai']));
    const calls: Array<{err: Error | null; allow?: boolean}> = [];
    (fn as Function)('https://claude.ai', (err: Error | null, allow?: boolean) => calls.push({err, allow}));
    expect(calls[0].allow).toBe(true);
  });

  test('allowlist + NON-matching Origin → cb(null, false) — the regression', () => {
    const fn = resolveCorsOrigin(new Set(['https://claude.ai']));
    const calls: Array<{err: Error | null; allow?: boolean}> = [];
    (fn as Function)('https://evil.example', (err: Error | null, allow?: boolean) => calls.push({err, allow}));
    expect(calls[0].err).toBeNull();
    expect(calls[0].allow).toBe(false);
  });

  test('multi-origin allowlist + match → true', () => {
    const fn = resolveCorsOrigin(new Set(['https://claude.ai', 'https://chatgpt.com']));
    const calls: Array<boolean | undefined> = [];
    (fn as Function)('https://chatgpt.com', (_err: unknown, allow?: boolean) => calls.push(allow));
    expect(calls[0]).toBe(true);
  });

  test('case-sensitive — "https://Claude.AI" does NOT match "https://claude.ai"', () => {
    const fn = resolveCorsOrigin(new Set(['https://claude.ai']));
    const calls: Array<boolean | undefined> = [];
    (fn as Function)('https://Claude.AI', (_err: unknown, allow?: boolean) => calls.push(allow));
    expect(calls[0]).toBe(false);
  });
});

/**
 * Integration coverage for #3845.
 *
 * The MCP SDK's mcpAuthRouter mounts a bare `cors()` (origin `*`) as the first
 * middleware on /token, /revoke, and /register. gbrain's own gate runs first,
 * but with a denied/default-deny origin cors@2.8.x neither sets a header nor
 * short-circuits — it calls next() — so the SDK's `*` answered the preflight,
 * leaking the endpoint surface to any web origin.
 *
 * These tests wire the REAL exported `mountOAuthCorsGate` in front of a
 * bare-cors "SDK" router (same ordering as serve-http.ts) and assert the
 * preflight is default-deny. A plain `cors(oauthOptions)` mount fails every
 * "no allow-origin" assertion below (that is the pre-fix regression).
 */
describe('mountOAuthCorsGate — OAuth preflight is default-deny (#3845)', () => {
  function buildApp(allowlist: Set<string> | null): express.Express {
    const oauthOptions: cors.CorsOptions = {
      origin: resolveCorsOrigin(allowlist),
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    };
    const app = express();
    // gbrain gate (runs first) — mirrors serve-http.ts.
    app.use('/token', mountOAuthCorsGate(oauthOptions));
    app.use('/revoke', mountOAuthCorsGate(oauthOptions));
    // Downstream SDK-style router: bare cors() then the POST handler.
    const sdk = express.Router();
    sdk.use('/token', cors());
    sdk.post('/token', (_req, res) => res.json({ ok: true }));
    sdk.use('/revoke', cors());
    sdk.post('/revoke', (_req, res) => res.json({ ok: true }));
    app.use(sdk);
    return app;
  }

  async function withServer<T>(
    allowlist: Set<string> | null,
    fn: (base: string) => Promise<T>,
  ): Promise<T> {
    const server: Server = buildApp(allowlist).listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  function preflight(base: string, path: string, origin: string) {
    return fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
  }

  test('allowlist unset → OPTIONS /token carries no Allow-Origin (was: *)', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: undefined }, async () => {
      await withServer(null, async base => {
        const res = await preflight(base, '/token', 'https://evil.example');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(res.status).toBe(204);
      });
    });
  });

  test('allowlist unset → OPTIONS /revoke carries no Allow-Origin (was: *)', async () => {
    await withServer(null, async base => {
      const res = await preflight(base, '/revoke', 'https://evil.example');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.status).toBe(204);
    });
  });

  test('allowlist set → non-listed Origin preflight is denied (no Allow-Origin)', async () => {
    await withServer(new Set(['https://claude.ai']), async base => {
      const res = await preflight(base, '/token', 'https://evil.example');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.status).toBe(204);
    });
  });

  test('allowlist set → listed Origin preflight reflects that Origin', async () => {
    await withServer(new Set(['https://claude.ai']), async base => {
      const res = await preflight(base, '/token', 'https://claude.ai');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
      expect(res.status).toBe(204);
    });
  });

  test('actual POST still reaches the downstream handler (gate only guards preflight)', async () => {
    await withServer(null, async base => {
      const res = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: '{}',
      });
      // The gate never touches non-OPTIONS requests — they fall straight
      // through to the token handler untouched.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });
});
