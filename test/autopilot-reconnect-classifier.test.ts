/**
 * v0.37.7.0 #1162 — autopilot reconnect-error classifier + launchd plist
 * generator regression tests.
 *
 * Pre-fix: autopilot's DB-health-check reconnect loop caught every error
 * and looped forever. When `database_url` was unset/malformed the loop
 * spammed `config.database_url undefined` until the user killed launchd.
 *
 * Fix: classify errors into recoverable (transient, retry) vs
 * unrecoverable (config / auth — exit). Combined with launchd plist's
 * `ThrottleInterval=60`, unrecoverable exits trigger a real 60s
 * backoff instead of immediate respawn.
 */

import { describe, test, expect } from 'bun:test';
import { classifyReconnectError, generateLaunchdPlist } from '../src/commands/autopilot.ts';

describe('classifyReconnectError (#1162)', () => {
  test('database_url undefined → unrecoverable (the #1162 fingerprint)', () => {
    const err = new Error('config.database_url undefined');
    expect(classifyReconnectError(err)).toBe('unrecoverable');
  });

  describe('crash vs config verdict — the 71-day-outage class', () => {
    test('real Bun null-deref → crash, NOT unrecoverable', () => {
      // Verbatim Bun/V8 text. Lowercased it contains BOTH "database_url" and
      // "undefined", so the substring rules below used to classify it as a
      // config verdict and exit the daemon permanently. It is a gbrain bug.
      const err = new TypeError("undefined is not an object (evaluating 'config.database_url')");
      expect(classifyReconnectError(err)).toBe('crash');
    });

    test('any TypeError → crash, by error type', () => {
      expect(classifyReconnectError(new TypeError('cfg.foo is not a function'))).toBe('crash');
    });

    test('V8-worded null-deref arriving as a plain Error → crash, by message shape', () => {
      // Some hosts lose the error class across a serialization boundary.
      expect(classifyReconnectError(new Error("Cannot read properties of undefined (reading 'database_url')")))
        .toBe('crash');
    });

    test('a genuine missing-config error is still unrecoverable', () => {
      // Guard against over-broadening: the crash rules must not swallow the
      // real "operator never set a URL" case, which SHOULD stop the daemon.
      expect(classifyReconnectError(new Error('GBRAIN_DATABASE_URL is not set'))).toBe('unrecoverable');
      expect(classifyReconnectError(new Error('No brain configured. Run: gbrain init'))).toBe('unrecoverable');
    });

    test('a malformed URL is a config verdict even though JS throws it as a TypeError', () => {
      // `new URL('garbage')` throws TypeError('Invalid URL'). The blanket
      // TypeError-means-crash rule would spend the whole 30-attempt reconnect
      // budget on an error only the operator can fix (adversarial review
      // catch); the message pattern is tested first.
      expect(classifyReconnectError(new TypeError('Invalid URL'))).toBe('unrecoverable');
      expect(classifyReconnectError(new Error('failed to parse URL from postgres://'))).toBe('unrecoverable');
    });
  });

  test('database_url empty → unrecoverable', () => {
    expect(classifyReconnectError(new Error('database_url is empty'))).toBe('unrecoverable');
  });

  test('database_url missing → unrecoverable', () => {
    expect(classifyReconnectError(new Error('database_url missing'))).toBe('unrecoverable');
  });

  test('malformed URL → unrecoverable', () => {
    expect(classifyReconnectError(new Error('Invalid URL: not a postgres connection string'))).toBe('unrecoverable');
    expect(classifyReconnectError(new Error('Failed to parse URL'))).toBe('unrecoverable');
  });

  test('auth failure → unrecoverable (creds don\'t fix themselves)', () => {
    expect(classifyReconnectError(new Error('password authentication failed for user "gbrain"'))).toBe('unrecoverable');
    expect(classifyReconnectError(new Error('role "ghost" does not exist'))).toBe('unrecoverable');
  });

  test('no brain configured → unrecoverable', () => {
    expect(classifyReconnectError(new Error('No brain configured. Run: gbrain init'))).toBe('unrecoverable');
  });

  test('network blip → recoverable', () => {
    expect(classifyReconnectError(new Error('ECONNREFUSED 127.0.0.1:5432'))).toBe('recoverable');
    expect(classifyReconnectError(new Error('connection terminated unexpectedly'))).toBe('recoverable');
  });

  test('pool saturated → recoverable', () => {
    expect(classifyReconnectError(new Error('connection pool timed out'))).toBe('recoverable');
    expect(classifyReconnectError(new Error('remaining connection slots are reserved'))).toBe('recoverable');
  });

  test('Supabase 503 → recoverable', () => {
    expect(classifyReconnectError(new Error('HTTP 503 Service Unavailable'))).toBe('recoverable');
  });

  test('non-Error inputs degrade safely', () => {
    expect(classifyReconnectError(null)).toBe('recoverable');
    expect(classifyReconnectError(undefined)).toBe('recoverable');
    expect(classifyReconnectError('plain string error')).toBe('recoverable');
    expect(classifyReconnectError({ weird: 'object' })).toBe('recoverable');
  });

  test('case-insensitive match', () => {
    expect(classifyReconnectError(new Error('DATABASE_URL UNDEFINED'))).toBe('unrecoverable');
    expect(classifyReconnectError(new Error('Password Authentication FAILED'))).toBe('unrecoverable');
  });
});

describe('generateLaunchdPlist (#1162)', () => {
  test('plist contains ThrottleInterval=60', () => {
    const plist = generateLaunchdPlist('/Users/me/.gbrain/autopilot-run.sh', '/Users/me');
    expect(plist).toMatch(/<key>ThrottleInterval<\/key><integer>60<\/integer>/);
  });

  test('plist contains KeepAlive (existing behavior preserved)', () => {
    const plist = generateLaunchdPlist('/Users/me/.gbrain/autopilot-run.sh', '/Users/me');
    expect(plist).toMatch(/<key>KeepAlive<\/key><true\/>/);
  });

  test('plist references the wrapper path correctly', () => {
    const plist = generateLaunchdPlist('/path/to/wrapper.sh', '/home');
    expect(plist).toContain('/path/to/wrapper.sh');
  });

  test('plist escapes XML special chars in paths', () => {
    const plist = generateLaunchdPlist('/path/with&amp/test.sh', '/home');
    // The path with `&` should be escaped to `&amp;` (idempotent on
    // already-escaped strings is acceptable; the key contract is "no
    // raw `&` in the XML output").
    expect(plist).not.toContain('with&/test'); // raw unescaped `&` between with and `/`
  });

  test('plist writes StandardErrorPath under the home dir (#1162 — error visibility)', () => {
    const plist = generateLaunchdPlist('/wrapper.sh', '/Users/alice');
    expect(plist).toContain('/Users/alice/.gbrain/autopilot.err');
  });
});
