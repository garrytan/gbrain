/**
 * v0.36.1.x #1024: bootstrap token resolution rules.
 *
 * The env override (GBRAIN_ADMIN_BOOTSTRAP_TOKEN) is security-sensitive —
 * a weak token silently accepted would let any reader of the env scope
 * impersonate admin. Test the validation directly via the pure helper so
 * the rule can't drift without the suite catching it.
 */
import { describe, test, expect } from 'bun:test';
import { resolveBootstrapToken, shouldSuppressBootstrapPrint } from '../src/commands/serve-http.ts';

describe('resolveBootstrapToken (v0.36.1.x #1024)', () => {
  test('unset env → generates a fresh token via the injected RNG', () => {
    const r = resolveBootstrapToken(undefined, () => 'a'.repeat(64));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.token).toBe('a'.repeat(64));
      expect(r.fromEnv).toBe(false);
    }
  });

  test('valid env token (32 chars, A-Za-z0-9_-) → ok + fromEnv:true', () => {
    const r = resolveBootstrapToken('abcdef0123456789abcdef0123456789');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.token).toBe('abcdef0123456789abcdef0123456789');
      expect(r.fromEnv).toBe(true);
    }
  });

  test('valid env token with hyphens and underscores → accepted', () => {
    const r = resolveBootstrapToken('A-B_C-D_E-F_G-H_I-J_K-L_M-N_O-P_');
    expect(r.kind).toBe('ok');
  });

  test('token shorter than 32 chars → error, refuse to start', () => {
    const r = resolveBootstrapToken('short-token-only-25-chars'); // 25 chars
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toMatch(/at least 32 chars/);
      expect(r.message).toMatch(/Refusing to start/);
    }
  });

  test('token with invalid characters (space, special chars) → error', () => {
    const r1 = resolveBootstrapToken('contains space '.padEnd(40, 'x'));
    expect(r1.kind).toBe('error');
    const r2 = resolveBootstrapToken('contains$dollar'.padEnd(40, 'x'));
    expect(r2.kind).toBe('error');
    const r3 = resolveBootstrapToken('contains/slash'.padEnd(40, 'x'));
    expect(r3.kind).toBe('error');
  });

  test('whitespace-padded token gets trimmed before validation', () => {
    const r = resolveBootstrapToken('  abcdef0123456789abcdef0123456789  ');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.token).toBe('abcdef0123456789abcdef0123456789');
  });

  test('empty string env (after trim, zero chars) → error', () => {
    const r = resolveBootstrapToken('');
    expect(r.kind).toBe('error');
  });

  test('exactly 32 chars hex (the boundary) → accepted', () => {
    const r = resolveBootstrapToken('0123456789abcdef0123456789abcdef');
    expect(r.kind).toBe('ok');
  });

  test('31 chars (one short) → error', () => {
    const r = resolveBootstrapToken('0123456789abcdef0123456789abcde'); // 31
    expect(r.kind).toBe('error');
  });
});

describe('shouldSuppressBootstrapPrint (#2624 log-leak default)', () => {
  const base = { suppress: false, fromEnv: false, forcePrint: false, isTty: true };

  test('generated token on non-TTY (container) → hidden by default', () => {
    expect(shouldSuppressBootstrapPrint({ ...base, isTty: false })).toBe(true);
  });

  test('generated token on interactive TTY → printed', () => {
    expect(shouldSuppressBootstrapPrint({ ...base, isTty: true })).toBe(false);
  });

  test('--print-admin-token forces raw value on non-TTY', () => {
    expect(shouldSuppressBootstrapPrint({ ...base, isTty: false, forcePrint: true })).toBe(false);
  });

  test('env-sourced token is never printed', () => {
    expect(shouldSuppressBootstrapPrint({ ...base, fromEnv: true, isTty: true })).toBe(true);
  });

  test('--suppress overrides even a forced print', () => {
    expect(shouldSuppressBootstrapPrint({ ...base, suppress: true, forcePrint: true, isTty: true })).toBe(true);
  });
});
