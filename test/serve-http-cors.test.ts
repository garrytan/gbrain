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
import { parseCorsAllowlistOAuth, resolveCorsOrigin } from '../src/commands/serve-http.ts';
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
