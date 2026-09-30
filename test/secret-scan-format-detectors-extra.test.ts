/**
 * Format-based detector edges not pinned by test/secret-scan.test.ts: the
 * remaining connection-string schemes, the AKIA arm's new hard right edge,
 * and the bearer catch-all's length floor + left boundary. Every value is
 * synthetic and runtime-joined from >= 2 fragments; constant names keep
 * scanner keywords away from the `=`.
 */
import { describe, expect, test } from 'bun:test';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';

const USERINFO = ['dbuser', ':', 'p4ssw0rd', '@'].join('');
const AKIA_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const OPAQUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');

describe('db_url_credentials — every listed scheme', () => {
  for (const scheme of ['postgresql', 'mysql', 'mongodb', 'rediss', 'amqp', 'mssql']) {
    test(`${scheme}:// with inline credentials fires once and keeps the host`, () => {
      const url = `${scheme}://${USERINFO}host.internal/db`;
      expect(scanText(`url ${url}`).map((f) => f.pattern)).toEqual(['db_url_credentials']);
      const { text } = redactFindings(url);
      expect(text).toBe('<REDACTED:db_url_credentials>host.internal/db');
      expect(text.includes('p4ssw0rd')).toBe(false);
    });
  }

  test('a database URL with an EMPTY password (user, trailing colon) does not fire', () => {
    expect(scanText('postgres://dbuser:@host.internal/db')).toEqual([]);
  });

  // Real copy-pasted passwords carry base64 `/`, braces, angle brackets,
  // pipes, carets, backticks and backslashes UNESCAPED. An earlier cut of the
  // password class excluded those on RFC 3986 grounds and every such password
  // sailed through unredacted (0 findings on all of these). The only
  // exclusions the class keeps are whitespace, `@`, `"` and `'` — the string
  // delimiters that end a credential-less URL inside minified JSON before an
  // unrelated `@` (pinned in secret-scan-perf (i-b)).
  const UNESCAPED_PW_CASES: Array<[string, string, string, string]> = [
    ['base64 slash', 'postgres://', 'admin', 'aB3dEf/GhIjKlmno12'],
    ['braces', 'postgres://', 'svc', 'p{assw0rd}Zx9'],
    ['angle brackets', 'redis://', 'user', 'tok<en>Val0ue99'],
    ['pipe caret backtick backslash', 'mysql://', 'svc', 'a|b^c`d\\e0F9'],
  ];
  for (const [label, scheme, user, pw] of UNESCAPED_PW_CASES) {
    test(`an unescaped ${label} password is still a credential: value ends at @, host survives`, () => {
      const creds = [scheme, user, ':', pw, '@'].join('');
      const url = creds + 'db.internal:5432/app';
      expect(scanText(`u ${url}`).map((f) => f.pattern)).toEqual(['db_url_credentials']);
      const { text } = redactFindings(`u ${url}`);
      expect(text).toBe('u <REDACTED:db_url_credentials>db.internal:5432/app');
      expect(text.includes(pw)).toBe(false);
    });
  }
});

describe('aws_access_key — AKIA keeps firing, now with a hard right edge', () => {
  test('bare AKIA id fires', () => {
    expect(scanText(`aws ${AKIA_ID}`).map((f) => f.pattern)).toEqual(['aws_access_key']);
  });

  test('AKIA followed by more alphanumerics is an identifier, not a key id', () => {
    expect(scanText(`${AKIA_ID}XYZ`)).toEqual([]);
    expect(scanText(`${AKIA_ID}1`)).toEqual([]);
  });
});

describe('bearer catch-all — floor and left boundary', () => {
  test('a token under 20 chars does not reach the bearer floor', () => {
    expect(scanText('Authorization: Bearer abcdef1234')).toEqual([]);
  });

  test('the keyword needs a non-word left boundary; punctuation counts as one', () => {
    expect(scanText(`xBearer ${OPAQUE}`)).toEqual([]);
    expect(scanText(`(Bearer ${OPAQUE})`).map((f) => f.pattern)).toEqual(['bearer']);
  });

  test('the redaction keeps the header keyword and drops only the token', () => {
    const { text } = redactFindings(`(Bearer ${OPAQUE})`);
    expect(text).toBe('(Bearer <REDACTED:bearer>)');
  });

  // RFC 7235 auth-scheme names are case-insensitive; an all-caps header used
  // to miss BOTH the regex (`[Bb]earer`) and the `earer` precheck, so the
  // line was never even scanned by the catch-all.
  test('an all-caps BEARER scheme fires as bearer and keeps the keyword', () => {
    const line = `Authorization: BEARER ${OPAQUE}`;
    expect(scanText(line).map((f) => f.pattern)).toEqual(['bearer']);
    expect(redactFindings(line).text).toBe('Authorization: BEARER <REDACTED:bearer>');
  });

  test('a token claimed behind an all-caps BEARER header is echo-redacted where it recurs bare', () => {
    // The echo pass keys on the claimed VALUE, not the keyword spelling, so a
    // token anchored by any accepted spelling is scrubbed at its bare echoes.
    const { text, redactions } = redactFindings(`Authorization: BEARER ${OPAQUE}\nretrying with ${OPAQUE}`);
    expect(redactions.length).toBe(1);
    expect(text).toBe('Authorization: BEARER <REDACTED:bearer>\nretrying with <REDACTED:bearer>');
  });

  test('BEARER <vendor key> still keeps the vendor attribution', () => {
    const anthropicShape = ['sk-ant-', 'api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3'].join('');
    expect(scanText(`BEARER ${anthropicShape}`).map((f) => f.pattern)).toEqual(['anthropic']);
  });
});
