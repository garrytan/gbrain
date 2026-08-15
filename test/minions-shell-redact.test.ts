/**
 * Tests for `src/core/minions/handlers/shell-redact.ts` — output-side
 * redaction of inherit-resolved values from shell-job stdout/stderr.
 *
 * Pure function under test. Properties:
 *   - Replaces every occurrence of each map value with `<REDACTED:name>`.
 *   - Empty input or empty map → identity.
 *   - Empty values in map are skipped (defensive).
 *   - String-mode replaceAll: regex metacharacters in values are literal.
 *   - Multiple secrets are independently scrubbed.
 *   - Substring overlap: a longer secret containing a shorter one redacts
 *     the longer one first only if iteration order places it first (Map
 *     iteration is insertion order). Test the realistic case.
 */

import { describe, test, expect } from 'bun:test';
import { redactSecretsInText } from '../src/core/minions/handlers/shell-redact.ts';

describe('redactSecretsInText', () => {
  test('empty text passes through unchanged', () => {
    expect(redactSecretsInText('', new Map([['database_url', 'postgresql://x:y@h/d']]))).toBe('');
  });

  test('empty map passes text through unchanged', () => {
    expect(redactSecretsInText('postgresql://x:y@h/d landed in logs', new Map())).toBe(
      'postgresql://x:y@h/d landed in logs',
    );
  });

  test('single secret value redacted with name token', () => {
    const out = redactSecretsInText(
      'DB URL is postgresql://x:y@h/d',
      new Map([['database_url', 'postgresql://x:y@h/d']]),
    );
    expect(out).toBe('DB URL is <REDACTED:database_url>');
  });

  test('multiple occurrences of the same secret all redacted', () => {
    const out = redactSecretsInText(
      'first: postgresql://x:y@h/d, again: postgresql://x:y@h/d, done.',
      new Map([['database_url', 'postgresql://x:y@h/d']]),
    );
    expect(out).toBe(
      'first: <REDACTED:database_url>, again: <REDACTED:database_url>, done.',
    );
  });

  test('multiple secrets each independently redacted', () => {
    const text =
      'connecting to postgresql://x:y@h/d with key sk-ant-test123 done';
    const out = redactSecretsInText(text, new Map([
      ['database_url', 'postgresql://x:y@h/d'],
      ['anthropic_api_key', 'sk-ant-test123'],
    ]));
    expect(out).toBe('connecting to <REDACTED:database_url> with key <REDACTED:anthropic_api_key> done');
  });

  test('empty-value entries in map are skipped (defensive)', () => {
    const text = 'postgresql://x:y@h/d landed in logs';
    const out = redactSecretsInText(text, new Map([
      ['weird_empty', ''],
      ['database_url', 'postgresql://x:y@h/d'],
    ]));
    expect(out).toBe('<REDACTED:database_url> landed in logs');
  });

  test('regex metacharacters in value are treated as literal', () => {
    // String-mode replaceAll. If the value contains regex chars like .*+?()
    // they don't expand. Critical for safety.
    const trickyValue = 'pgpass.*foo+bar?(baz)';
    const out = redactSecretsInText(
      `dump: ${trickyValue} end`,
      new Map([['foo', trickyValue]]),
    );
    expect(out).toBe('dump: <REDACTED:foo> end');
  });

  test('text without the secret value is unchanged', () => {
    const out = redactSecretsInText(
      'no secrets here, just normal log output',
      new Map([['database_url', 'postgresql://x:y@h/d']]),
    );
    expect(out).toBe('no secrets here, just normal log output');
  });

  test('value across newlines is redacted (replaceAll handles \\n)', () => {
    // If a JWT-like secret happens to contain a newline somehow, replaceAll
    // still works because it's string-mode.
    const v = 'line1\nline2';
    const out = redactSecretsInText(`pre ${v} post`, new Map([['multi', v]]));
    expect(out).toBe('pre <REDACTED:multi> post');
  });

  test('substring overlap: shorter value inside longer value', () => {
    // If `short` is a substring of `long` AND both are in the map, the
    // iteration-order winner replaces first. Map preserves insertion order,
    // so the test reflects that explicitly. Real-world expectation: callers
    // should not have overlapping secrets; if they do, longest-first is
    // typically what they want (which requires the caller to insert long
    // before short). This test pins the behavior, doesn't claim a policy.
    const longV = 'token_with_inner_token';
    const shortV = 'inner_token';
    const text = `outer: ${longV}, inner: ${shortV}`;
    const out = redactSecretsInText(text, new Map([
      ['long_token', longV],
      ['short_token', shortV],
    ]));
    // Long replaced first → its substring stays as REDACTED token, short
    // then replaces the standalone occurrence.
    expect(out).toBe('outer: <REDACTED:long_token>, inner: <REDACTED:short_token>');
  });
});
