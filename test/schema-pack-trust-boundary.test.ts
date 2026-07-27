// v0.38 T8: schema_pack per-call trust gate (D13 + codex F4).
//
// Per-call schema_pack opt is the tier-1 highest-priority resolution
// chain entry. Remote/MCP callers passing it could broaden their
// effective read scope or escape strict-mode validation — the v0.26.9
// + v0.34.1.0 trust-boundary hardening waves explicitly closed this
// for source_id; v0.38 re-applies the same posture for schema_pack.
//
// This test pins:
//   - CLI callers (ctx.remote === false) override via per-call freely.
//   - MCP callers (ctx.remote === true) get permission_denied.
//   - Fail-closed default: undefined/missing remote rejects.
//   - Non-string param shapes reject.
//   - Undefined/null per-call passes through (no-op).

import { describe, expect, test } from 'bun:test';
import {
  validateSchemaPackTrustGate,
  SchemaPackTrustGateError,
} from '../src/core/schema-pack/index.ts';
import type { OperationContext } from '../src/core/operations.ts';

// Stub OperationContext factory — only the fields the gate consults.
function ctx(remote: boolean | undefined): OperationContext {
  return { remote } as OperationContext;
}

describe('validateSchemaPackTrustGate (T8 D13)', () => {
  test('CLI caller (remote=false) accepts per-call schema_pack', () => {
    expect(validateSchemaPackTrustGate(ctx(false), 'custom-pack')).toBe('custom-pack');
  });

  test('MCP caller (remote=true) rejects per-call schema_pack', () => {
    expect(() => validateSchemaPackTrustGate(ctx(true), 'malicious-pack'))
      .toThrow(SchemaPackTrustGateError);
    expect(() => validateSchemaPackTrustGate(ctx(true), 'malicious-pack'))
      .toThrow(/rejected for remote\/MCP callers/);
  });

  test('fail-closed: undefined remote treated as remote', () => {
    expect(() => validateSchemaPackTrustGate(ctx(undefined), 'p'))
      .toThrow(SchemaPackTrustGateError);
  });

  test('undefined per-call is a no-op (no error, returns undefined)', () => {
    expect(validateSchemaPackTrustGate(ctx(false), undefined)).toBeUndefined();
    expect(validateSchemaPackTrustGate(ctx(true), undefined)).toBeUndefined();
    expect(validateSchemaPackTrustGate(ctx(undefined), undefined)).toBeUndefined();
  });

  test('null per-call is a no-op', () => {
    expect(validateSchemaPackTrustGate(ctx(false), null)).toBeUndefined();
  });

  test('non-string per-call rejects with type error', () => {
    expect(() => validateSchemaPackTrustGate(ctx(false), 42)).toThrow(/must be a string/);
    expect(() => validateSchemaPackTrustGate(ctx(false), { name: 'x' })).toThrow(/must be a string/);
    expect(() => validateSchemaPackTrustGate(ctx(false), ['p'])).toThrow(/must be a string/);
  });

  test('error code is permission_denied (D13 dispatch envelope)', () => {
    try {
      validateSchemaPackTrustGate(ctx(true), 'p');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaPackTrustGateError);
      expect((e as SchemaPackTrustGateError).code).toBe('permission_denied');
    }
  });

  test('error message names the safe channels for the rejected caller', () => {
    try {
      validateSchemaPackTrustGate(ctx(true), 'p');
    } catch (e) {
      const msg = (e as Error).message;
      // Names every alternate channel so an MCP-client operator knows
      // how to configure the pack without per-call.
      expect(msg).toContain('gbrain.yml');
      expect(msg).toContain('GBRAIN_SCHEMA_PACK');
      expect(msg).toContain('config.json');
      expect(msg).toContain('gbrain config set');
    }
  });
});
