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

const engine = {
  getConfig: async (key: string) => key === 'takes.bootstrap_enabled' ? 'true' : null,
  executeRaw: async () => [],
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
      consent_gate_blocked: false,
      llm_unavailable: false,
      // #4473: md-first skip accounting.
      pages_skipped: 0,
      skipped: [],
      mirror_warnings: 0,
    });
  });
});
