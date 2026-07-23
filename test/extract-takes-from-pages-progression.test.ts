/**
 * Bootstrap progression regression test.
 *
 * extractTakesFromPages selected pages by updated_at DESC + LIMIT with no
 * exclusion of pages that already hold takes — so on a corpus larger than
 * one run's cap (the CLI clamps --max-pages to 1000), every re-run rescanned
 * the same most-recent slice: the older tail could never be bootstrapped,
 * and each rescan re-spent LLM budget producing upsert-identical rows.
 * Seen live on a 2,311-eligible-page brain where the second run would have
 * covered 0 new pages.
 *
 * Pins: covered pages are skipped by default (runs progress), and
 * includeCovered restores the full rescan (refresh semantics).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  configureGateway({
    chat_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-takes-progression' },
  });
  __setChatTransportForTests(async () => ({
    text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]',
    blocks: [{ type: 'text' as const, text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]' }],
    stopReason: 'end' as const,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  }));

  const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
  await engine.putPage('concepts/progression-a', {
    type: 'concept', title: 'A', compiled_truth: body, frontmatter: {},
  });
  await engine.putPage('concepts/progression-b', {
    type: 'concept', title: 'B', compiled_truth: body, frontmatter: {},
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('extractTakesFromPages — bootstrap progression', () => {
  test('first run covers the eligible pages', async () => {
    const r1 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r1.pages_scanned).toBe(2);
    expect(r1.claims_extracted).toBe(2);
  });

  test('second run skips covered pages — repeat runs progress instead of rescanning', async () => {
    const r2 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r2.pages_scanned).toBe(0);
    expect(r2.claims_extracted).toBe(0);
  });

  test('a page added after the first run is picked up (progression, not a frozen set)', async () => {
    const body = 'Another opinion-bearing body long enough to clear the eligibility floor. '.repeat(5);
    await engine.putPage('concepts/progression-c', {
      type: 'concept', title: 'C', compiled_truth: body, frontmatter: {},
    });
    const r3 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r3.pages_scanned).toBe(1);
  });

  test('includeCovered rescans everything (refresh semantics)', async () => {
    const r4 = await extractTakesFromPages(engine, {
      bootstrapEnabled: true, maxPages: 50, includeCovered: true,
    });
    expect(r4.pages_scanned).toBe(3);
  });
});
