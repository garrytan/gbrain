/**
 * Langfuse OTLP dual-export wiring.
 *
 * Pins the exact bug that shipped silently on staging: `OTEL_EXPORTER_OTLP_ENDPOINT`
 * pointed at Phoenix while a self-hosted Langfuse instance sat unconfigured next to
 * it — no error, no traces, because the enable predicate and the header scheme are
 * separate from Phoenix's and easy to half-configure. These cases pin the env → url /
 * header mapping so that class of failure fails a test instead of shipping quiet.
 *
 * Pure-function tests on purpose: both helpers take env as an argument, so nothing
 * here mutates `process.env` or trips the lazy-init latch.
 */
import { describe, test, expect } from 'bun:test';
import { langfuseReady, langfuseExporterConfig } from '../src/core/tracing.ts';

describe('langfuseReady', () => {
  test('both keys present → ready', () => {
    expect(langfuseReady({ LANGFUSE_PUBLIC_KEY: 'pk-1', LANGFUSE_SECRET_KEY: 'sk-1' })).toBe(true);
  });

  test('only one key present → not ready (silent no-op, not a half-export)', () => {
    expect(langfuseReady({ LANGFUSE_PUBLIC_KEY: 'pk-1' })).toBe(false);
    expect(langfuseReady({ LANGFUSE_SECRET_KEY: 'sk-1' })).toBe(false);
  });

  test('neither key present → not ready', () => {
    expect(langfuseReady({})).toBe(false);
  });

  test('blank or whitespace-only keys are treated as absent', () => {
    expect(langfuseReady({ LANGFUSE_PUBLIC_KEY: '  ', LANGFUSE_SECRET_KEY: '' })).toBe(false);
  });
});

describe('langfuseExporterConfig', () => {
  test('defaults to Langfuse Cloud when LANGFUSE_BASE_URL is unset', () => {
    const { url } = langfuseExporterConfig({
      LANGFUSE_PUBLIC_KEY: 'pk-1',
      LANGFUSE_SECRET_KEY: 'sk-1',
    });
    expect(url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
  });

  test('a self-hosted LANGFUSE_BASE_URL is used, trailing slashes stripped', () => {
    const { url } = langfuseExporterConfig({
      LANGFUSE_BASE_URL: 'http://langfuse-web.railway.internal:3000/',
      LANGFUSE_PUBLIC_KEY: 'pk-1',
      LANGFUSE_SECRET_KEY: 'sk-1',
    });
    expect(url).toBe('http://langfuse-web.railway.internal:3000/api/public/otel/v1/traces');
  });

  test('auth header is Basic base64(publicKey:secretKey) — not a Phoenix-style Bearer token', () => {
    const { headers } = langfuseExporterConfig({
      LANGFUSE_PUBLIC_KEY: 'pk-1',
      LANGFUSE_SECRET_KEY: 'sk-1',
    });
    const expected = `Basic ${Buffer.from('pk-1:sk-1').toString('base64')}`;
    expect(headers).toEqual({ Authorization: expected });
  });
});
