/**
 * v0.41.22.2 — shared connection-info redactor contract.
 *
 * Pins the privacy promise the audit channel makes: any text passed
 * through `redactConnectionInfo` does NOT contain Postgres DSNs,
 * credentials, hostnames, or IPv4 octets. Real-world fixtures drawn
 * from actual Supabase / PgBouncer / Node DNS error shapes so the
 * tests fail loud if real-world error formats drift past the patterns.
 *
 * Pure function tests, no fs / no env / no PGLite.
 */

import { describe, it, expect } from 'bun:test';
import {
  redactConnectionInfo,
  getRedactionKinds,
} from '../../src/core/audit/redact-connection-info.ts';

describe('redactConnectionInfo: per-pattern coverage', () => {
  it('case 1 — postgres:// URL with embedded credentials', () => {
    const out = redactConnectionInfo(
      'connection failed: postgres://garry:hunter2@db.example.com:5432/gbrain',
    );
    expect(out).toContain('<REDACTED:pg_url>');
    expect(out).not.toContain('garry');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('db.example.com');
    expect(out).not.toContain('5432/gbrain');
  });

  it('case 2 — postgresql:// (with -ql) treated the same as postgres://', () => {
    const out = redactConnectionInfo(
      'using postgresql://user:pass@host:5432/db?sslmode=require',
    );
    expect(out).toContain('<REDACTED:pg_url>');
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('host:5432');
  });

  it('case 3 — password=secret AND pwd=secret both redacted', () => {
    const a = redactConnectionInfo('FATAL: password=hunter2 connection denied');
    expect(a).toContain('<REDACTED:password>');
    expect(a).not.toContain('hunter2');

    const b = redactConnectionInfo('conninfo: pwd=admin123 user=postgres');
    expect(b).toContain('<REDACTED:password>');
    expect(b).not.toContain('admin123');
  });

  it('case 4 — user=postgres mid-string', () => {
    const out = redactConnectionInfo('conninfo: host=db user=postgres dbname=app');
    expect(out).toContain('<REDACTED:user>');
    expect(out).not.toContain('user=postgres');
  });

  it('case 5 — host=db.example.com', () => {
    const out = redactConnectionInfo('conninfo: host=db.example.com port=5432');
    expect(out).toContain('<REDACTED:host>');
    expect(out).not.toContain('db.example.com');
  });

  it('case 6 — IPv4 inside PG error context', () => {
    const out = redactConnectionInfo(
      'connection to server at "db.example.com" (192.168.1.42), port 5432 failed',
    );
    expect(out).toContain('<REDACTED:ipv4>');
    expect(out).not.toContain('192.168.1.42');
  });
});

describe('redactConnectionInfo: false-positive defense', () => {
  it('case 7 — version number v3.1.4.0 is NOT redacted (negative lookbehind/ahead)', () => {
    const out = redactConnectionInfo('tree-sitter version v3.1.4.0 loaded');
    expect(out).toContain('v3.1.4.0');
    expect(out).not.toContain('<REDACTED:ipv4>');
  });

  it('case 7b — semver-like 1.2.3.4 NOT redacted when surrounded by version-y tokens', () => {
    const out = redactConnectionInfo('tree-sitter@0.26.3.1 was loaded');
    expect(out).toContain('0.26.3.1');
    expect(out).not.toContain('<REDACTED:ipv4>');
  });

  it('case 8 — already-redacted text is idempotent', () => {
    const once = redactConnectionInfo('user=postgres host=db port=5432');
    const twice = redactConnectionInfo(once);
    expect(twice).toBe(once);
  });

  it('case 9 — plain text without secrets passes through unchanged', () => {
    const plain = 'Worker started; processing job 42; took 150ms';
    expect(redactConnectionInfo(plain)).toBe(plain);
  });

  it('case 9b — empty string passes through', () => {
    expect(redactConnectionInfo('')).toBe('');
  });
});

describe('redactConnectionInfo: real-world fixtures', () => {
  it('case 10 — real Supabase connection failure error: IP redacted, structure preserved', () => {
    const real =
      'PostgresError: connection to server at "aws-0-us-east-1.pooler.supabase.com" (3.215.142.117), port 6543 failed: FATAL: password authentication failed for user "postgres.abcdef123456"';
    const out = redactConnectionInfo(real);
    // IP is the load-bearing leak in this shape (publicly resolvable).
    expect(out).not.toContain('3.215.142.117');
    expect(out).toContain('<REDACTED:ipv4>');
    // Structure preserved enough to debug from.
    expect(out).toMatch(/PostgresError/);
    expect(out).toMatch(/port 6543/);
    // Documented limitation: bare-quoted hostname and bare-quoted
    // username are NOT caught by the bare-field matchers. The bare
    // hostname leak is mitigated by the `host=` pattern wrt conninfo
    // strings; the bare-quoted form is not (filed as a v0.42 TODO if
    // the threat model changes). Pinning current behavior so a future
    // widening shows up as a test diff, not a silent change.
    expect(out).toContain('aws-0-us-east-1.pooler.supabase.com');
  });

  it('case 11 — real getaddrinfo ENOTFOUND with no IP, just hostname', () => {
    const real =
      'Error: getaddrinfo ENOTFOUND db.example.invalid.host\n    at GetAddrInfoReqWrap.onlookup [as oncomplete]';
    const out = redactConnectionInfo(real);
    // Hostname appears WITHOUT host= prefix, so the bare-field matcher
    // doesn't catch it. The error structure is preserved; no false
    // claims of credential leakage. This is a documented limitation.
    expect(out).toContain('getaddrinfo ENOTFOUND');
    // Smoke test: IPv4 (if any) gone.
    expect(out).not.toMatch(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/);
  });

  it('case 12 — pattern order: URL with embedded password redacts as pg_url first, not double-redacted', () => {
    const out = redactConnectionInfo(
      'failed to connect: postgres://admin:s3cr3t@host.example.com:5432/db',
    );
    // The URL pattern wins because it's listed first. The substring
    // `password=` doesn't appear in the input (it's the URL-form), so
    // we get exactly ONE redaction kind.
    expect(out.match(/<REDACTED:pg_url>/g)?.length).toBe(1);
    expect(out).not.toContain('<REDACTED:password>');
    expect(out).not.toContain('admin');
    expect(out).not.toContain('s3cr3t');
  });
});

describe('getRedactionKinds: pattern-set surface', () => {
  it('exposes all 5 expected kinds for surface-stability tests', () => {
    const kinds = getRedactionKinds();
    expect(kinds).toEqual(['pg_url', 'password', 'user', 'host', 'ipv4']);
  });
});
