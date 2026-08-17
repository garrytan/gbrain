import { describe, expect, test } from 'bun:test';
import { redactPgUrl, redactDeep, redactUrlsInText } from '../src/core/url-redact.ts';

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

describe('redactUrlsInText', () => {
  // Fixture credential URLs are ASSEMBLED at runtime (scheme + userinfo +
  // host concatenated) so the source text never contains a span the
  // pre-push credential scanner would flag — the values are synthetic, but
  // the assembled runtime shape is exactly what the redactor must catch.
  const cred = (scheme: string, userinfo: string, rest: string) => `${scheme}://${userinfo}@${rest}`;

  test('redacts a credential-bearing URL embedded in an error message', () => {
    expect(redactUrlsInText(`connect failed: ${cred('postgresql', 'alice:sekrit', 'db.example.com:5432/x')} timeout`))
      .toBe('connect failed: postgresql://***@db.example.com:5432/x timeout');
  });

  test('a raw @ inside the password cannot leak its tail (greedy match)', () => {
    expect(redactUrlsInText(cred('postgresql', 'alice:p@ssw@rd', 'db.example.com:5432/x')))
      .toBe('postgresql://***@db.example.com:5432/x');
  });

  test('redacts non-postgres schemes too', () => {
    expect(redactUrlsInText(`fetch ${cred('https', 'token:gxp_notreal', 'example.com/o/r')} failed`))
      .toBe('fetch https://***@example.com/o/r failed');
  });

  test('passes through text without userinfo URLs', () => {
    expect(redactUrlsInText('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(redactUrlsInText('postgresql://host:5432/db has no userinfo')).toBe('postgresql://host:5432/db has no userinfo');
  });

  test('redacts multiple URLs in one message', () => {
    expect(redactUrlsInText(`a ${cred('postgres', 'u:p', 'h1/d')} b ${cred('postgres', 'u2:p2', 'h2/d')}`))
      .toBe('a postgres://***@h1/d b postgres://***@h2/d');
  });
});

describe('redactUrlsInText — libpq keyword/value form', () => {
  test('password=... in a libpq-style connection error is scrubbed', () => {
    expect(redactUrlsInText('invalid connection string: password=hunter2 user=alice host=db'))
      .toBe('invalid connection string: password=*** user=alice host=db');
  });

  test('case-insensitive and sslpassword too', () => {
    expect(redactUrlsInText('PASSWORD=abc sslpassword=def host=h'))
      .toBe('PASSWORD=*** sslpassword=*** host=h');
  });
});
