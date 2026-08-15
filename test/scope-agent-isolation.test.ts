import { describe, it, expect } from 'bun:test';
import { hasScope, ALLOWED_SCOPES, ALLOWED_SCOPES_LIST } from '../src/core/scope.ts';

/**
 * v0.38 D13 regression guard — `agent` is a SIBLING of admin, NOT implied.
 *
 * The bug class this prevents:
 *
 *   Existing admin clients (legacy super-admin tokens, ops automation,
 *   personal `--scopes admin`) MUST NOT silently gain the ability to
 *   dispatch `submit_agent` jobs on upgrade. The submit_agent op spends
 *   real money against the OAuth client's bound_* fields, and admin
 *   clients pre-v0.38 have NULL bindings — so silent inheritance would
 *   either (a) refuse with a confusing "no bindings" error or worse
 *   (b) become exploitable if the bindings-missing check ever regresses.
 *
 * The contract: opt-in only. To submit agent jobs, the client must be
 * re-registered with `--scopes admin,agent` and explicit `--bound-*`
 * flags. This file is the regression guard that pins that contract.
 *
 * If this test fails, the scope hierarchy in src/core/scope.ts changed
 * such that admin now implies agent. That is a SECURITY REGRESSION —
 * don't relax this test, fix the scope table.
 */

describe('v0.38 D13 — agent scope isolation (regression guard)', () => {
  it('agent IS in the allow-list', () => {
    expect(ALLOWED_SCOPES.has('agent' as any)).toBe(true);
    expect(ALLOWED_SCOPES_LIST.includes('agent' as any)).toBe(true);
  });

  it('admin does NOT imply agent (sibling, not parent)', () => {
    // The load-bearing check: a token with only `admin` granted CANNOT
    // satisfy a required `agent` scope check. Without this, every existing
    // admin OAuth client would silently acquire submit_agent dispatch on
    // upgrade — security regression.
    expect(hasScope(['admin'], 'agent')).toBe(false);
  });

  it('admin implies its siblings (the v0.31 contract still holds)', () => {
    // Don't regress the existing admin hierarchy in the process of
    // isolating agent. admin still implies sources_admin, users_admin,
    // write, read.
    expect(hasScope(['admin'], 'sources_admin')).toBe(true);
    expect(hasScope(['admin'], 'users_admin')).toBe(true);
    expect(hasScope(['admin'], 'write')).toBe(true);
    expect(hasScope(['admin'], 'read')).toBe(true);
  });

  it('agent does NOT imply anything else (no inheritance the other way)', () => {
    // An agent-scoped token must NOT also satisfy read/write/admin. The
    // submit_agent op's bindings are the ONLY axis of capability — agent
    // doesn't piggyback on the broader permission tree.
    expect(hasScope(['agent'], 'read')).toBe(false);
    expect(hasScope(['agent'], 'write')).toBe(false);
    expect(hasScope(['agent'], 'admin')).toBe(false);
    expect(hasScope(['agent'], 'sources_admin')).toBe(false);
    expect(hasScope(['agent'], 'users_admin')).toBe(false);
  });

  it('agent satisfies a required agent scope (self-implies)', () => {
    expect(hasScope(['agent'], 'agent')).toBe(true);
  });

  it('explicit admin+agent compound grant satisfies both', () => {
    // Recommended re-registration for legacy admin clients that want
    // submit_agent capability: `--scopes admin,agent`.
    expect(hasScope(['admin', 'agent'], 'admin')).toBe(true);
    expect(hasScope(['admin', 'agent'], 'agent')).toBe(true);
    expect(hasScope(['admin', 'agent'], 'write')).toBe(true); // via admin
  });

  it('read+write does NOT imply agent (the most common legacy shape)', () => {
    // Pre-v0.38 OAuth clients registered with `--scopes read,write` (the
    // default for most thin-client MCP setups) MUST NOT silently gain
    // agent dispatch.
    expect(hasScope(['read', 'write'], 'agent')).toBe(false);
  });

  it('sources_admin and users_admin do NOT imply agent', () => {
    expect(hasScope(['sources_admin'], 'agent')).toBe(false);
    expect(hasScope(['users_admin'], 'agent')).toBe(false);
  });

  it('ALLOWED_SCOPES_LIST is sorted alphabetically (wire-format determinism)', () => {
    const sorted = [...ALLOWED_SCOPES_LIST].sort();
    expect([...ALLOWED_SCOPES_LIST]).toEqual(sorted);
    // Specifically: 'agent' must sort between 'admin' and 'read'.
    const idx = ALLOWED_SCOPES_LIST.indexOf('agent' as any);
    const adminIdx = ALLOWED_SCOPES_LIST.indexOf('admin' as any);
    const readIdx = ALLOWED_SCOPES_LIST.indexOf('read' as any);
    expect(idx).toBeGreaterThan(adminIdx);
    expect(idx).toBeLessThan(readIdx);
  });
});
