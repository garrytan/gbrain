/**
 * #3962 — `takes extract --from-pages --json` must emit the structured
 * extraction result instead of the human summary line.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runTakes } from '../src/commands/takes.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let lastQuery: { sql: string; params: unknown[] } | null = null;
const engine = {
  getConfig: async (key: string) => key === 'takes.bootstrap_enabled' ? 'true' : null,
  executeRaw: async (sql: string, params: unknown[] = []) => {
    lastQuery = { sql, params };
    return [];
  },
} as unknown as BrainEngine;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

beforeAll(() => {
  configureGateway({
    chat_model: 'openai:gpt-test',
    env: { OPENAI_API_KEY: 'sk-test-takes-json' },
  });
});

afterAll(() => {
  resetGateway();
});

describe('gbrain takes extract --from-pages --json (#3962)', () => {
  test('emits the extraction result as parseable JSON', async () => {
    const stdout = await captureStdout(() =>
      runTakes(engine, ['extract', '--from-pages', '--dry-run', '--json']));

    expect(JSON.parse(stdout)).toEqual({
      pages_scanned: 0,
      claims_extracted: 0,
      next_before: null,
      consent_gate_blocked: false,
      llm_unavailable: false,
      // #4473: md-first skip accounting.
      pages_skipped: 0,
      skipped: [],
      mirror_warnings: 0,
    });
  });

  test('passes an opaque next_before cursor after the source parameter', async () => {
    lastQuery = null;
    await captureStdout(() =>
      runTakes(engine, [
        'extract', '--from-pages', '--dry-run', '--json',
        '--source-id', 'default',
        '--before', '2030-01-02 03:04:05.123456+00,42',
      ]));

    expect(lastQuery?.sql).toContain('(updated_at, id) < ($2::timestamptz, $3)');
    expect(lastQuery?.params).toEqual(['default', '2030-01-02 03:04:05.123456+00', 42]);
  });
});
