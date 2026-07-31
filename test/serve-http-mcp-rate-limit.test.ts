/**
 * Tests for resolveMcpRateLimit() in src/commands/serve-http.ts.
 *
 * SECURITY.md has documented a pre-auth IP bucket and a post-auth token
 * bucket on `/mcp` for several releases, but both lived only in the
 * superseded src/mcp/http-transport.ts. The Express server that actually
 * serves /mcp had no limiter on it at all — /token, /admin/auth/:token and
 * /ingest each had one, and the busiest authenticated surface had none.
 *
 * These assertions pin the numbers to what SECURITY.md promises, so the doc
 * and the code can't drift apart again silently.
 */

import { describe, test, expect } from 'bun:test';
import { resolveMcpRateLimit } from '../src/commands/serve-http.ts';

describe('resolveMcpRateLimit — defaults match SECURITY.md', () => {
  test('60s window', () => {
    expect(resolveMcpRateLimit({}).windowMs).toBe(60_000);
  });

  test('pre-auth IP bucket: 30 req / 60s', () => {
    expect(resolveMcpRateLimit({}).ipMax).toBe(30);
  });

  test('post-auth token bucket: 60 req / 60s', () => {
    expect(resolveMcpRateLimit({}).tokenMax).toBe(60);
  });

  test('token bucket is looser than the IP bucket', () => {
    // Intentional: an authenticated client has already proved it holds a
    // credential, so it gets more headroom than an anonymous IP.
    const r = resolveMcpRateLimit({});
    expect(r.tokenMax).toBeGreaterThan(r.ipMax);
  });
});

describe('resolveMcpRateLimit — env overrides', () => {
  test('GBRAIN_HTTP_RATE_LIMIT_IP overrides the IP bucket', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_IP: '5' }).ipMax).toBe(5);
  });

  test('GBRAIN_HTTP_RATE_LIMIT_TOKEN overrides the token bucket', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_TOKEN: '500' }).tokenMax).toBe(500);
  });

  test('GBRAIN_HTTP_RATE_LIMIT_WINDOW_MS overrides the window', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_WINDOW_MS: '10000' }).windowMs).toBe(10_000);
  });

  test('buckets are independent — setting one leaves the other at default', () => {
    const r = resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_IP: '5' });
    expect(r.tokenMax).toBe(60);
    expect(r.windowMs).toBe(60_000);
  });
});

describe('resolveMcpRateLimit — malformed values fall back, never open', () => {
  // parsePositiveIntEnv's contract. Asserted here because a limiter that
  // silently becomes unlimited is worse than no limiter: it reads as
  // protected on inspection.
  test('non-numeric falls back to the default', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_IP: 'lots' }).ipMax).toBe(30);
  });

  test('zero falls back rather than disabling the bucket', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_IP: '0' }).ipMax).toBe(30);
  });

  test('negative falls back', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_TOKEN: '-1' }).tokenMax).toBe(60);
  });

  test('empty string falls back', () => {
    expect(resolveMcpRateLimit({ GBRAIN_HTTP_RATE_LIMIT_TOKEN: '' }).tokenMax).toBe(60);
  });
});
