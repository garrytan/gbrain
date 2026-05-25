/**
 * Tests for resolveTrustProxy() in src/commands/serve-http.ts.
 *
 * v0.41.3 (T8): GBRAIN_HTTP_TRUST_PROXY env var replaces the pre-fix hardcoded
 * `app.set('trust proxy', 'loopback')`. The Express trust-proxy value
 * determines whether X-Forwarded-For is honored (rate limit IP correctness)
 * and whether req.secure detects HTTPS termination at a proxy.
 *
 * Pure function — no Express, no fetch, no env mutation. Each case calls
 * resolveTrustProxy directly with the env string it would have read.
 */

import { describe, test, expect } from 'bun:test';
import { resolveTrustProxy } from '../src/commands/serve-http.ts';

describe('resolveTrustProxy', () => {
  test('unset → "loopback" (pre-v0.41.3 default)', () => {
    expect(resolveTrustProxy(undefined)).toBe('loopback');
  });

  test('empty string → "loopback" (env was set but blank, treat as unset)', () => {
    expect(resolveTrustProxy('')).toBe('loopback');
  });

  test('"0" → false (trust nothing — defeat X-Forwarded-For spoofing)', () => {
    expect(resolveTrustProxy('0')).toBe(false);
  });

  test('"false" → false', () => {
    expect(resolveTrustProxy('false')).toBe(false);
  });

  test('"1" → 1 (trust exactly one hop — Fly.io / Render / single-layer proxy)', () => {
    expect(resolveTrustProxy('1')).toBe(1);
  });

  test('"true" → 1', () => {
    expect(resolveTrustProxy('true')).toBe(1);
  });

  test('"2" → 2 (trust two hops — Cloudflare → nginx → gbrain)', () => {
    expect(resolveTrustProxy('2')).toBe(2);
  });

  test('"10" → 10 (deep proxy chain)', () => {
    expect(resolveTrustProxy('10')).toBe(10);
  });

  test('"loopback" → "loopback" (explicit pass-through)', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
  });

  test('"uniquelocal" → "uniquelocal" (Express named mode)', () => {
    expect(resolveTrustProxy('uniquelocal')).toBe('uniquelocal');
  });

  test('"linklocal" → "linklocal" (Express named mode)', () => {
    expect(resolveTrustProxy('linklocal')).toBe('linklocal');
  });

  test('CIDR list passes through verbatim (Express parses it)', () => {
    expect(resolveTrustProxy('10.0.0.0/8,192.168.1.0/24')).toBe('10.0.0.0/8,192.168.1.0/24');
  });

  test('garbage string passes through (Express will reject at startup if invalid)', () => {
    // Fail-loud strategy: don't silently fall back to a default on garbage.
    // Express's IP filter will throw at boot, surfacing the typo immediately
    // rather than silently producing an unexpected security posture.
    expect(resolveTrustProxy('frobnicate')).toBe('frobnicate');
  });

  test('numeric string with leading zero ("007") parses as 7', () => {
    // /^\d+$/ matches; parseInt accepts.
    expect(resolveTrustProxy('007')).toBe(7);
  });

  test('"-1" passes through as string (not numeric — Express rejects)', () => {
    // The /^\d+$/ regex deliberately excludes negative numbers; pass-through
    // means Express sees an invalid value and throws at boot rather than
    // silently treating it as 1 or false.
    expect(resolveTrustProxy('-1')).toBe('-1');
  });
});
