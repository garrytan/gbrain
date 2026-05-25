/**
 * v0.39.3.0 WARN-9 + CV12 — normalizeScopesInput contract.
 *
 * The admin SPA at /admin/api/register-client sends `scopes` as either a
 * string ('read write') or an array (['read', 'write']) depending on UI
 * version. OAuth wire format prefers `scope` (singular, space-string).
 * Pre-fix, the admin route did `scopes || 'read'` which broke on array
 * input AND silently ignored requests using `scope` (singular).
 *
 * This file pins the validator's behavior across every input shape codex
 * flagged plus a few defensive cases.
 *
 * Hermetic — pure-function unit tests, no engine.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeScopesInput, InvalidScopeError } from '../src/core/scope.ts';

describe('normalizeScopesInput — happy paths', () => {
  test('undefined → "read" default', () => {
    expect(normalizeScopesInput(undefined)).toBe('read');
  });

  test('null → "read" default', () => {
    expect(normalizeScopesInput(null)).toBe('read');
  });

  test('string "read" → "read"', () => {
    expect(normalizeScopesInput('read')).toBe('read');
  });

  test('string "read write" → sorted "read write" (deterministic)', () => {
    expect(normalizeScopesInput('read write')).toBe('read write');
  });

  test('string "write read" → sorted "read write" (regardless of input order)', () => {
    expect(normalizeScopesInput('write read')).toBe('read write');
  });

  test('array ["read", "write"] → "read write"', () => {
    expect(normalizeScopesInput(['read', 'write'])).toBe('read write');
  });

  test('array ["admin"] → "admin"', () => {
    expect(normalizeScopesInput(['admin'])).toBe('admin');
  });

  test('string "admin write read" → sorted "admin read write"', () => {
    expect(normalizeScopesInput('admin write read')).toBe('admin read write');
  });

  test('dedupes repeated scopes in array', () => {
    expect(normalizeScopesInput(['read', 'read', 'write'])).toBe('read write');
  });

  test('dedupes repeated scopes in string', () => {
    expect(normalizeScopesInput('read read write')).toBe('read write');
  });

  test('extra whitespace in string normalized', () => {
    expect(normalizeScopesInput('  read  write  ')).toBe('read write');
  });

  test('tab + newline whitespace also handled', () => {
    expect(normalizeScopesInput('read\twrite\nadmin')).toBe('admin read write');
  });
});

describe('normalizeScopesInput — rejection cases', () => {
  test('number → Error (not string/array)', () => {
    expect(() => normalizeScopesInput(42)).toThrow(/must be a string or array/);
  });

  test('plain object → Error', () => {
    expect(() => normalizeScopesInput({ scope: 'read' })).toThrow(/must be a string or array/);
  });

  test('boolean → Error', () => {
    expect(() => normalizeScopesInput(true)).toThrow(/must be a string or array/);
  });

  test('empty array → Error (no scopes after normalization)', () => {
    expect(() => normalizeScopesInput([])).toThrow(/empty after normalization/);
  });

  test('empty string → Error (no scopes after normalization)', () => {
    expect(() => normalizeScopesInput('')).toThrow(/^scopes is empty/);
  });

  test('whitespace-only string → Error (empty after split)', () => {
    expect(() => normalizeScopesInput('   ')).toThrow(/empty after normalization/);
  });

  test('array with non-string element (null) → Error', () => {
    expect(() => normalizeScopesInput(['read', null])).toThrow(/must contain only strings.*null/);
  });

  test('array with non-string element (number) → Error', () => {
    expect(() => normalizeScopesInput(['read', 42])).toThrow(/must contain only strings.*number/);
  });

  test('array with empty-string element → Error', () => {
    expect(() => normalizeScopesInput(['read', ''])).toThrow(/empty strings/);
  });

  test('array with whitespace-in-element ["read write"] → Error (the codex-flagged bug shape)', () => {
    expect(() => normalizeScopesInput(['read write'])).toThrow(/whitespace.*single scope name/);
  });

  test('array with internal-tab element → Error', () => {
    expect(() => normalizeScopesInput(['read\twrite'])).toThrow(/whitespace/);
  });

  test('unknown scope name → InvalidScopeError (allowlist enforcement)', () => {
    expect(() => normalizeScopesInput(['root'])).toThrow(InvalidScopeError);
    expect(() => normalizeScopesInput('root')).toThrow(/Unknown scope "root"/);
  });

  test('string with unknown scope name → InvalidScopeError', () => {
    expect(() => normalizeScopesInput('flying-unicorn')).toThrow(/Unknown scope/);
  });

  test('mix of known + unknown → InvalidScopeError on the unknown', () => {
    expect(() => normalizeScopesInput('read flying-unicorn')).toThrow(/Unknown scope "flying-unicorn"/);
  });
});

describe('normalizeScopesInput — determinism', () => {
  test('same input always produces same output (sorted)', () => {
    expect(normalizeScopesInput(['write', 'admin', 'read']))
      .toBe(normalizeScopesInput('read admin write'));
  });

  test('hierarchy-aware scopes (sources_admin, users_admin, agent) accepted', () => {
    expect(normalizeScopesInput(['sources_admin', 'users_admin'])).toBe('sources_admin users_admin');
    expect(normalizeScopesInput('agent')).toBe('agent');
  });
});
