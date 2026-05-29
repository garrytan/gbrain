/**
 * Tests for src/core/source-config-redact.ts (v0.40 D15.4).
 */
import { describe, test, expect } from 'bun:test';
import { redactSourceConfig, hasWebhookSecret } from '../src/core/source-config-redact.ts';

describe('redactSourceConfig', () => {
  test('redacts webhook_secret', () => {
    const input = { federated: true, webhook_secret: 'super-secret-key', github_repo: 'a/b' };
    const out = redactSourceConfig(input);
    expect(out.webhook_secret).toBe('<redacted>');
    expect(out.federated).toBe(true);
    expect(out.github_repo).toBe('a/b');
  });

  test('does not mutate input', () => {
    const input = { webhook_secret: 'secret' };
    redactSourceConfig(input);
    expect(input.webhook_secret).toBe('secret');
  });

  test('returns empty object for non-object input', () => {
    expect(redactSourceConfig(null)).toEqual({});
    expect(redactSourceConfig(undefined)).toEqual({});
    expect(redactSourceConfig('a string')).toEqual({});
    expect(redactSourceConfig(['arr'])).toEqual({});
  });

  test('preserves nested objects (not deep-redacted)', () => {
    const input = {
      webhook_secret: 'x',
      nested: { allowed: 'value' },
    };
    const out = redactSourceConfig(input);
    expect(out.webhook_secret).toBe('<redacted>');
    expect(out.nested).toEqual({ allowed: 'value' });
  });
});

describe('hasWebhookSecret', () => {
  test('true when set + non-empty', () => {
    expect(hasWebhookSecret({ webhook_secret: 'x' })).toBe(true);
  });
  test('false when empty', () => {
    expect(hasWebhookSecret({ webhook_secret: '' })).toBe(false);
  });
  test('false when absent', () => {
    expect(hasWebhookSecret({})).toBe(false);
  });
  test('false on non-string values', () => {
    expect(hasWebhookSecret({ webhook_secret: 42 })).toBe(false);
    expect(hasWebhookSecret(null)).toBe(false);
  });
});
