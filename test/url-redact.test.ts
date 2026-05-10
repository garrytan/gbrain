import { describe, expect, test } from 'bun:test';
import { redactPgUrl, redactDeep } from '../src/core/url-redact.ts';

describe('redactPgUrl', () => {
  test('strips userinfo from postgresql:// URL', () => {
    expect(redactPgUrl('postgresql://user:pass@host:5432/db')).toBe(
      'postgresql://***@host:5432/db'
    );
  });

  test('strips userinfo from postgres:// URL', () => {
    expect(redactPgUrl('postgres://user:pass@host:5432/db')).toBe(
      'postgres://***@host:5432/db'
    );
  });

  test('preserves URL without userinfo', () => {
    expect(redactPgUrl('postgresql://host:5432/db')).toBe(
      'postgresql://host:5432/db'
    );
  });

  test('preserves query string', () => {
    expect(redactPgUrl('postgresql://u:p@host:5432/db?prepare=false')).toBe(
      'postgresql://***@host:5432/db?prepare=false'
    );
  });

  test('handles user-only (no password)', () => {
    expect(redactPgUrl('postgresql://user@host:5432/db')).toBe(
      'postgresql://***@host:5432/db'
    );
  });

  test('handles Supabase pooler shape', () => {
    expect(
      redactPgUrl('postgresql://postgres.abc:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres')
    ).toBe('postgresql://***@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
  });

  test('returns sentinel for non-string input', () => {
    expect(redactPgUrl(undefined)).toBe('<redacted-url>');
    expect(redactPgUrl(null)).toBe('<redacted-url>');
    expect(redactPgUrl(123)).toBe('<redacted-url>');
  });

  test('returns sentinel for malformed URL', () => {
    expect(redactPgUrl('not a url')).toBe('<redacted-url>');
  });
});

describe('redactDeep', () => {
  test('redacts URL inside an object', () => {
    const input = { url: 'postgresql://user:pass@host:5432/db', port: 5432 };
    const out = redactDeep(input);
    expect(out.url).toBe('postgresql://***@host:5432/db');
    expect(out.port).toBe(5432);
  });

  test('redacts URLs inside arrays', () => {
    const input = ['postgresql://u:p@host/db', 'safe string'];
    expect(redactDeep(input)).toEqual([
      'postgresql://***@host/db',
      'safe string',
    ]);
  });

  test('preserves non-URL strings', () => {
    expect(redactDeep('hello world')).toBe('hello world');
  });

  test('handles nested objects', () => {
    const input = { config: { primary: 'postgresql://u:p@h/d', secondary: { url: 'postgres://u:p@h2/d' } } };
    const out = redactDeep(input);
    expect(out.config.primary).toBe('postgresql://***@h/d');
    expect(out.config.secondary.url).toBe('postgres://***@h2/d');
  });
});
