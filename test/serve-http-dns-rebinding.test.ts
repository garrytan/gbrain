/**
 * Tests for resolveDnsRebindingOptions() in src/commands/serve-http.ts.
 *
 * The MCP Streamable HTTP spec requires the server to validate the `Origin`
 * header. The SDK ships that middleware but defaults it off for backwards
 * compatibility, so before this landed the transport was constructed with
 * only `sessionIdGenerator` and no validation ran at all.
 *
 * The attack is DNS rebinding: a page the operator visits re-resolves its own
 * hostname to 127.0.0.1 and then talks to a loopback-bound MCP server from
 * inside the browser's same-origin bubble. The request genuinely originates
 * on the operator's machine, so firewalls and bind addresses don't help — the
 * Host/Origin headers are the control.
 *
 * The failure mode of getting this WRONG is equally sharp: the SDK does an
 * exact string match on Host, so a missing entry means 421 on every request.
 * Most of these tests are about the derived host list being generous enough
 * to never lock an operator out, while still being a closed set.
 */

import { describe, test, expect } from 'bun:test';
import { resolveDnsRebindingOptions } from '../src/commands/serve-http.ts';

describe('resolveDnsRebindingOptions — enablement', () => {
  test('enabled by default (the spec-mandated posture)', () => {
    const r = resolveDnsRebindingOptions({ port: 8787, env: {} });
    expect(r.enableDnsRebindingProtection).toBe(true);
  });

  test('GBRAIN_HTTP_DNS_REBINDING_PROTECTION=0 is the escape hatch', () => {
    const r = resolveDnsRebindingOptions({
      port: 8787,
      env: { GBRAIN_HTTP_DNS_REBINDING_PROTECTION: '0' },
    });
    expect(r.enableDnsRebindingProtection).toBe(false);
    // No lists when disabled — the SDK short-circuits before reading them,
    // and emitting them would imply a check that isn't running.
    expect(r.allowedHosts).toBeUndefined();
    expect(r.allowedOrigins).toBeUndefined();
  });

  test("'false' also disables (matches resolveTrustProxy's accepted spellings)", () => {
    const r = resolveDnsRebindingOptions({
      port: 8787,
      env: { GBRAIN_HTTP_DNS_REBINDING_PROTECTION: 'false' },
    });
    expect(r.enableDnsRebindingProtection).toBe(false);
  });
});

describe('resolveDnsRebindingOptions — derived hosts', () => {
  test('no public URL → loopback forms for the bound port', () => {
    const r = resolveDnsRebindingOptions({ port: 8787, env: {} });
    // Both bare and :port forms: browsers omit the port only for 80/443, and
    // an omitted entry is a 421 on every request.
    expect(r.allowedHosts).toContain('localhost:8787');
    expect(r.allowedHosts).toContain('127.0.0.1:8787');
    expect(r.allowedHosts).toContain('[::1]:8787');
    expect(r.allowedHosts).toContain('localhost');
  });

  test('an attacker-controlled hostname is NOT in the derived set', () => {
    const r = resolveDnsRebindingOptions({ port: 8787, env: {} });
    expect(r.allowedHosts).not.toContain('evil.example');
    expect(r.allowedHosts).not.toContain('evil.example:8787');
  });

  test('https public URL → bare host (Host omits the default 443 port)', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'https://brain.example.com',
      port: 8787,
      env: {},
    });
    expect(r.allowedHosts).toContain('brain.example.com');
  });

  test('public URL with an explicit port → both host and host:port', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'https://brain.example.com:8443',
      port: 8787,
      env: {},
    });
    expect(r.allowedHosts).toContain('brain.example.com:8443');
    expect(r.allowedHosts).toContain('brain.example.com');
  });

  test('loopback stays allowed alongside a public URL (local health probes)', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'https://brain.example.com',
      port: 8787,
      env: {},
    });
    expect(r.allowedHosts).toContain('localhost:8787');
  });

  test('malformed public URL degrades to loopback rather than locking out', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'not a url',
      port: 8787,
      env: {},
    });
    expect(r.enableDnsRebindingProtection).toBe(true);
    expect(r.allowedHosts).toContain('localhost:8787');
  });

  test('GBRAIN_HTTP_ALLOWED_HOSTS overrides derivation entirely', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'https://brain.example.com',
      port: 8787,
      env: { GBRAIN_HTTP_ALLOWED_HOSTS: 'proxy.internal, brain.example.com' },
    });
    expect(r.allowedHosts!.sort()).toEqual(['brain.example.com', 'proxy.internal']);
    // Override means override: no loopback smuggled back in.
    expect(r.allowedHosts).not.toContain('localhost:8787');
  });

  test('host list is deduplicated', () => {
    const r = resolveDnsRebindingOptions({
      publicUrl: 'http://localhost:8787',
      port: 8787,
      env: {},
    });
    const counts = new Map<string, number>();
    for (const h of r.allowedHosts!) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });
});

describe('resolveDnsRebindingOptions — origins', () => {
  test('no origins configured → key omitted (SDK skips the origin check)', () => {
    // Deliberate: Claude Code and Copilot CLI send no Origin header at all,
    // and the host check already covers them. An empty-but-present list
    // would be indistinguishable from "check nothing" to the SDK anyway.
    const r = resolveDnsRebindingOptions({ port: 8787, env: {} });
    expect(r.allowedOrigins).toBeUndefined();
  });

  test('falls back to the CORS allowlist so operators maintain ONE list', () => {
    const r = resolveDnsRebindingOptions({
      port: 8787,
      corsAllowlist: new Set(['https://claude.ai']),
      env: {},
    });
    expect(r.allowedOrigins).toEqual(['https://claude.ai']);
  });

  test('GBRAIN_HTTP_ALLOWED_ORIGINS wins over the CORS allowlist', () => {
    const r = resolveDnsRebindingOptions({
      port: 8787,
      corsAllowlist: new Set(['https://claude.ai']),
      env: { GBRAIN_HTTP_ALLOWED_ORIGINS: 'https://other.app' },
    });
    expect(r.allowedOrigins).toEqual(['https://other.app']);
  });

  test('whitespace in the env list is trimmed and blanks dropped', () => {
    const r = resolveDnsRebindingOptions({
      port: 8787,
      env: { GBRAIN_HTTP_ALLOWED_ORIGINS: ' https://a.app , , https://b.app ' },
    });
    expect(r.allowedOrigins).toEqual(['https://a.app', 'https://b.app']);
  });
});
