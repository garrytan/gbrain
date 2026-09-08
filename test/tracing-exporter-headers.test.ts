/**
 * OTLP exporter credentials.
 *
 * An auth-gated Phoenix answers every unauthenticated `POST /v1/traces` with
 * 401, and the exporter swallows it — tracing reports ON while the collector
 * receives nothing. These cases pin the env → header mapping that closes that
 * gap, and the two rules that keep it from misfiring: a blank key must not
 * produce an empty bearer token (which reads as a credential and still 401s),
 * and holding a key must not by itself imply consent to export full prompts.
 *
 * Pure-function tests on purpose: `buildExporterHeaders` takes env as an
 * argument, so nothing here mutates `process.env` or trips the lazy-init latch.
 */
import { describe, test, expect } from 'bun:test';
import { buildExporterHeaders } from '../src/core/tracing.ts';

describe('buildExporterHeaders', () => {
  test('a key becomes an Authorization bearer header', () => {
    expect(buildExporterHeaders({ PHOENIX_API_KEY: 'phx-abc123' })).toEqual({
      Authorization: 'Bearer phx-abc123',
    });
  });

  test('no key means no headers at all (local unauthenticated Phoenix)', () => {
    expect(buildExporterHeaders({})).toBeUndefined();
  });

  test('a blank or whitespace key is treated as absent, not as an empty token', () => {
    expect(buildExporterHeaders({ PHOENIX_API_KEY: '' })).toBeUndefined();
    expect(buildExporterHeaders({ PHOENIX_API_KEY: '   ' })).toBeUndefined();
  });

  test('surrounding whitespace is trimmed — a copy-pasted key with a trailing newline still authenticates', () => {
    expect(buildExporterHeaders({ PHOENIX_API_KEY: '  phx-abc123\n' })).toEqual({
      Authorization: 'Bearer phx-abc123',
    });
  });

  test('the key is not an enable signal — it never appears in the tracing-enabled decision', () => {
    // Spans carry full prompts/queries/documents, so export stays gated on an
    // explicit GBRAIN_TRACING / endpoint. Reading this from the source keeps the
    // guarantee pinned even if readEnabled() is rewritten (it is not exported).
    const src = require('node:fs').readFileSync(
      new URL('../src/core/tracing.ts', import.meta.url),
      'utf8',
    ) as string;
    const readEnabled = src.slice(
      src.indexOf('function readEnabled('),
      src.indexOf('function collectorBaseUrl('),
    );
    expect(readEnabled.length).toBeGreaterThan(0);
    expect(readEnabled).not.toContain('PHOENIX_API_KEY');
  });
});
