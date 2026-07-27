/**
 * Tests for `src/core/minions/handlers/shell-inherit.ts` — free-form helpers
 * for `inherit:` secret resolution (v0.36.5.0).
 *
 * Two pure functions and one regex. Properties under test:
 *   - `INHERIT_NAME_RE` matches snake_case shapes, rejects everything else.
 *   - `deriveEnvKey` returns the right ENV-key name per convention.
 *   - `resolveInheritValue` uses `Object.hasOwn` (prototype-pollution defense),
 *     returns undefined for missing / non-string / empty-string values, and
 *     handles `null` config.
 */

import { describe, test, expect } from 'bun:test';
import {
  INHERIT_NAME_RE,
  deriveEnvKey,
  resolveInheritValue,
} from '../src/core/minions/handlers/shell-inherit.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('INHERIT_NAME_RE', () => {
  test.each([
    'database_url',
    'anthropic_api_key',
    'openai_api_key',
    'voyage_api_key',
    'groq_api_key',
    'zeroentropy_api_key',
    'remote_mcp_oauth_client_secret',
    'field2',
    'a',
    'a_b_c_d_e',
  ])('accepts snake_case shape: %s', (name) => {
    expect(INHERIT_NAME_RE.test(name)).toBe(true);
  });

  test.each([
    '__proto__',           // leading underscore (prototype pollution)
    '_underscore_first',   // leading underscore
    'CamelCase',           // uppercase letters
    'UPPER_CASE',          // all uppercase
    '0_leading_digit',     // leading digit
    'has-dash',            // hyphen
    'has.dot',             // dot
    '../traversal',        // path-traversal shape
    'has space',           // whitespace
    '',                    // empty
    'has\nnewline',        // newline
  ])('rejects non-snake_case shape: %s', (name) => {
    expect(INHERIT_NAME_RE.test(name)).toBe(false);
  });
});

describe('deriveEnvKey', () => {
  test('database_url → GBRAIN_DATABASE_URL (override, less ambiguous)', () => {
    expect(deriveEnvKey('database_url')).toBe('GBRAIN_DATABASE_URL');
  });
  test('anthropic_api_key → ANTHROPIC_API_KEY (provider-standard uppercase)', () => {
    expect(deriveEnvKey('anthropic_api_key')).toBe('ANTHROPIC_API_KEY');
  });
  test('openai_api_key → OPENAI_API_KEY', () => {
    expect(deriveEnvKey('openai_api_key')).toBe('OPENAI_API_KEY');
  });
  test('voyage_api_key → VOYAGE_API_KEY', () => {
    expect(deriveEnvKey('voyage_api_key')).toBe('VOYAGE_API_KEY');
  });
  test('groq_api_key → GROQ_API_KEY', () => {
    expect(deriveEnvKey('groq_api_key')).toBe('GROQ_API_KEY');
  });
  test('arbitrary_field → ARBITRARY_FIELD (default uppercase)', () => {
    expect(deriveEnvKey('arbitrary_field')).toBe('ARBITRARY_FIELD');
  });
});

describe('resolveInheritValue', () => {
  test('returns string when field exists and is a non-empty string', () => {
    const cfg: GBrainConfig = { engine: 'postgres', database_url: 'postgresql://x' };
    expect(resolveInheritValue(cfg, 'database_url')).toBe('postgresql://x');
  });
  test('returns undefined when field is unset', () => {
    expect(resolveInheritValue({ engine: 'postgres' }, 'database_url')).toBeUndefined();
  });
  test('returns undefined when field is empty string', () => {
    const cfg: GBrainConfig = { engine: 'postgres', database_url: '' };
    expect(resolveInheritValue(cfg, 'database_url')).toBeUndefined();
  });
  test('returns undefined for null config', () => {
    expect(resolveInheritValue(null, 'database_url')).toBeUndefined();
  });
  test('returns undefined when field is non-string (e.g. object)', () => {
    const cfg = { engine: 'postgres', remote_mcp: { issuer_url: 'x' } } as unknown as GBrainConfig;
    expect(resolveInheritValue(cfg, 'remote_mcp')).toBeUndefined();
  });
  test('prototype-pollution defense: __proto__ returns undefined even though Object.prototype has the property', () => {
    expect(resolveInheritValue({ engine: 'postgres' }, '__proto__')).toBeUndefined();
  });
  test('prototype-pollution defense: constructor returns undefined', () => {
    expect(resolveInheritValue({ engine: 'postgres' }, 'constructor')).toBeUndefined();
  });
  test('prototype-pollution defense: toString returns undefined', () => {
    expect(resolveInheritValue({ engine: 'postgres' }, 'toString')).toBeUndefined();
  });
});

describe('integration: deriveEnvKey + resolveInheritValue work together', () => {
  const cfg: GBrainConfig = {
    engine: 'postgres',
    database_url: 'postgresql://x',
    anthropic_api_key: 'sk-ant-x',
    openai_api_key: 'sk-x',
  };
  test.each([
    ['database_url', 'GBRAIN_DATABASE_URL', 'postgresql://x'],
    ['anthropic_api_key', 'ANTHROPIC_API_KEY', 'sk-ant-x'],
    ['openai_api_key', 'OPENAI_API_KEY', 'sk-x'],
  ])('name %s resolves to envKey %s with value %s', (name, expectedEnvKey, expectedValue) => {
    expect(deriveEnvKey(name)).toBe(expectedEnvKey);
    expect(resolveInheritValue(cfg, name)).toBe(expectedValue);
  });
});
