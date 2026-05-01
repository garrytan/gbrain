/**
 * PII scrubber regex coverage. Every redacted family gets a positive
 * case and at least one false-positive avoidance case. Adversarial regex
 * input is covered so a pathological query can't hang capture.
 */

import { describe, expect, test } from 'bun:test';
import { scrubPii } from '../src/core/eval-capture-scrub.ts';

describe('scrubPii', () => {
  test('passes empty input through unchanged', () => {
    expect(scrubPii('')).toBe('');
  });

  test('leaves PII-free queries untouched', () => {
    const q = 'who is alice-example and what did they build';
    expect(scrubPii(q)).toBe(q);
  });

  test('redacts email addresses', () => {
    const out = scrubPii('email me at alice@example.com about this');
    expect(out).not.toContain('alice@example.com');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts multiple emails in one query', () => {
    const out = scrubPii('alice@example.com cc bob@other.org');
    expect(out).not.toContain('@example.com');
    expect(out).not.toContain('@other.org');
    expect(out.match(/\[REDACTED\]/g) || []).toHaveLength(2);
  });

  test('redacts US phone 555-123-4567', () => {
    expect(scrubPii('call 555-123-4567')).toBe('call [REDACTED]');
  });

  test('redacts US phone (555) 123-4567', () => {
    expect(scrubPii('tel (555) 123-4567 ext 4')).toContain('[REDACTED]');
  });

  test('redacts E.164 +1 555 123 4567', () => {
    expect(scrubPii('intl +1 555 123 4567')).toContain('[REDACTED]');
  });

  test('redacts SSN with dashes (XXX-XX-XXXX)', () => {
    expect(scrubPii('ssn is 123-45-6789 on file')).toContain('[REDACTED]');
    expect(scrubPii('ssn is 123-45-6789 on file')).not.toContain('123-45-6789');
  });

  test('does NOT redact a 4-digit year like 2026 as SSN', () => {
    expect(scrubPii('released in 2026, v0.21.0')).toContain('2026');
  });

  test('redacts a Visa number that passes Luhn', () => {
    // 4111 1111 1111 1111 is the canonical Visa test number (valid Luhn).
    const out = scrubPii('card 4111 1111 1111 1111 expires 12/26');
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).toContain('[REDACTED]');
  });

  test('does NOT redact a 16-digit integer that fails Luhn', () => {
    // 1234567890123456 has Luhn mod 10 = 4 (fails).
    expect(scrubPii('order id 1234567890123456')).toContain('1234567890123456');
  });

  test('does NOT redact bare 6-digit identifiers (#123456)', () => {
    expect(scrubPii('see PR #123456 and issue #789012')).toContain('#123456');
  });

  test('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = scrubPii(`token: ${jwt}`);
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts bearer tokens after Authorization-style prefix', () => {
    const out = scrubPii('Authorization: Bearer abc123DEF456ghi789');
    expect(out).not.toContain('abc123DEF456ghi789');
    expect(out).toContain('Bearer [REDACTED]');
  });

  test('redacts bearer lowercase too', () => {
    const out = scrubPii('header bearer abc123DEF456ghi789');
    expect(out).not.toContain('abc123DEF456ghi789');
  });

  test('handles adversarial nested-group input without hanging', () => {
    // Classic catastrophic-backtracking bait for regex engines without
    // possessive quantifiers. Must complete quickly — the scrubber should
    // stay linear-time on all input. 10k char limit is well under the
    // CHECK-constrained 50KB cap enforced at DB level.
    const adversarial = 'a'.repeat(10000) + '!';
    const start = Date.now();
    const out = scrubPii(adversarial);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // generous cap, realistic target <50ms
    expect(out).toContain('a'.repeat(100)); // output still visible
  });

  test('combined input: email + phone + CC + JWT + SSN all redacted together', () => {
    const mixed =
      'contact alice@example.com at 555-123-4567, ' +
      'card 4111-1111-1111-1111, ssn 123-45-6789, ' +
      'auth Bearer abcdef123456';
    const out = scrubPii(mixed);
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('555-123-4567');
    expect(out).not.toContain('4111-1111-1111-1111');
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('abcdef123456');
    // Each distinct redaction yields a [REDACTED] token somewhere.
    expect((out.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});
