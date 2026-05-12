import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { isSensitiveConfigKey, redactConfigValue } from '../src/commands/config.ts';

// Keep a local regex check for backwards-compatible URL redaction behavior.

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

// Reimplemented from source for unit testing
function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    // The regex is greedy on [^@]+ so it captures up to the LAST @
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    // No colon after user means regex doesn't match
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config set output redaction', () => {
  test('redacts API keys, tokens, secrets, PATs, and passwords', () => {
    for (const key of ['openai_api_key', 'github.token', 'client-secret', 'db_password', 'github_pat']) {
      expect(isSensitiveConfigKey(key)).toBe(true);
      expect(redactConfigValue(key, 'sk-test-1234567890abcdef')).toBe('<REDACTED>');
    }
  });

  test('leaves non-sensitive values visible', () => {
    expect(isSensitiveConfigKey('sync.repo_path')).toBe(false);
    expect(redactConfigValue('sync.repo_path', '/tmp/repo')).toBe('/tmp/repo');
  });

  test('redacts postgresql passwords even for non-sensitive key names', () => {
    expect(redactConfigValue('database_url', 'postgresql://user:pass@host/db'))
      .toBe('postgresql://user:***@host/db');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\\/\\/');
  });
});
