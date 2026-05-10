/**
 * v0.31.1 (Issue #734, CDX-5): unit tests for the oauth_client_scopes_probe
 * doctor check's pure-function builder.
 *
 * The probe itself (probeScopes) makes real MCP calls, so it's covered by
 * E2E tests. Here we just exercise buildScopeCheck against synthetic
 * ScopeProbeResult inputs to pin the status semantics:
 *
 *   read.missing_scope  → fail (broken setup)
 *   admin.missing_scope → warn (the load-bearing case for v0.29.2/v0.30.0
 *                              thin clients without admin scope)
 *   both ok             → ok
 *   inconclusive        → ok with detail.inconclusive=true
 */

import { describe, test, expect } from 'bun:test';
import { buildScopeCheck, type ScopeProbeResult } from '../src/core/doctor-remote.ts';

describe('buildScopeCheck', () => {
  test('both probes succeed → status=ok with confirmation message', () => {
    const probe: ScopeProbeResult = { read_ok: true, admin_ok: true };
    const check = buildScopeCheck('read write admin', probe);
    expect(check.name).toBe('oauth_client_scopes_probe');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('verified');
    expect(check.detail?.read_ok).toBe(true);
    expect(check.detail?.admin_ok).toBe(true);
    expect(check.detail?.inconclusive).toBeUndefined();
  });

  test('read missing_scope → status=fail (broken setup)', () => {
    const probe: ScopeProbeResult = {
      read_ok: false,
      admin_ok: false,
      read_error: 'missing_scope',
    };
    const check = buildScopeCheck('', probe);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('read scope');
    expect(check.detail?.read_ok).toBe(false);
  });

  test('admin missing_scope → status=warn with pinpoint hint (the load-bearing case)', () => {
    const probe: ScopeProbeResult = {
      read_ok: true,
      admin_ok: false,
      admin_error: 'missing_scope',
    };
    const check = buildScopeCheck('read write', probe);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('admin scope MISSING');
    // The pinpoint remediation must name the exact CLI invocation.
    expect(check.message).toContain('gbrain auth register-client');
    expect(check.message).toContain('read,write,admin');
    expect(check.detail?.read_ok).toBe(true);
    expect(check.detail?.admin_ok).toBe(false);
    expect(check.detail?.admin_error).toBe('missing_scope');
  });

  test('admin probe fails for non-scope reason (e.g. parse) → status=ok inconclusive', () => {
    const probe: ScopeProbeResult = {
      read_ok: true,
      admin_ok: false,
      admin_error: 'parse',
    };
    const check = buildScopeCheck('read write admin', probe);
    expect(check.status).toBe('ok'); // doctor should NOT fail on probe noise
    expect(check.message).toContain('inconclusive');
    expect(check.detail?.inconclusive).toBe(true);
    expect(check.detail?.admin_error).toBe('parse');
  });

  test('both probes fail for non-scope reasons → status=ok inconclusive', () => {
    const probe: ScopeProbeResult = {
      read_ok: false,
      admin_ok: false,
      read_error: 'network',
      admin_error: 'network',
    };
    const check = buildScopeCheck('', probe);
    expect(check.status).toBe('ok'); // informational
    expect(check.message).toContain('inconclusive');
    expect(check.detail?.inconclusive).toBe(true);
  });

  test('granted scope is surfaced in detail (and message when ok)', () => {
    const probe: ScopeProbeResult = { read_ok: true, admin_ok: true };
    const check = buildScopeCheck('read write admin', probe);
    expect(check.detail?.granted).toBe('read write admin');
    expect(check.message).toContain('read write admin');
  });

  test('empty granted scope renders as "unspecified"', () => {
    const probe: ScopeProbeResult = { read_ok: true, admin_ok: true };
    const check = buildScopeCheck('', probe);
    expect(check.detail?.granted).toBe(null);
    expect(check.message).toContain('unspecified');
  });

  test('admin probe fails with read also failing (not missing_scope) → fail (read takes precedence)', () => {
    // Defense-in-depth: if read genuinely missing_scope, that's the
    // headline diagnosis; admin status is secondary.
    const probe: ScopeProbeResult = {
      read_ok: false,
      admin_ok: false,
      read_error: 'missing_scope',
      admin_error: 'missing_scope',
    };
    const check = buildScopeCheck('', probe);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('read');
  });
});
