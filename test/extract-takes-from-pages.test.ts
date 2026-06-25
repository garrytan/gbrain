/**
 * Regression tests for #1857 — `extractTakesFromPages` model resolution.
 *
 * Pre-fix the per-page classifier call hardcoded
 * `model: opts.model ?? 'anthropic:claude-haiku-4-5'` even though the JSDoc
 * said "defaults to facts.extraction_model". Neither caller (cmdExtract,
 * the Minion handler) set opts.model, so OpenAI-only brains attempted
 * Anthropic with no key and the per-page try/catch silently continued —
 * `takes extract --from-pages` returned `0 claim(s)` with no error.
 *
 * These tests pin the model that reaches `chat()` through the canonical
 * `facts.extraction_model` resolution chain.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
  type ChatOpts,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;
let capturedChatOpts: ChatOpts[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Chat-transport stub. Captures every call's opts (so tests can assert the
  // resolved model) and returns an empty claims array so the page loop
  // completes without inserting takes.
  __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
    capturedChatOpts.push(opts);
    return {
      text: '[]',
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'stub:stub',
      providerId: 'stub',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  capturedChatOpts = [];
});

async function seedConceptPage(slug: string): Promise<void> {
  // Body length must exceed the 200-char floor in extractTakesFromPages's
  // SQL: `length(COALESCE(compiled_truth, '')) > 200`.
  const body = 'This is a concept page with enough content to clear the 200-character minimum for the page eligibility filter in extractTakesFromPages so the loop actually attempts a chat call against the configured model. Padding padding padding to be safe.';
  await engine.putPage(slug, {
    type: 'concept',
    title: 'Test Concept',
    compiled_truth: body,
  });
}

describe('#1857 — extractTakesFromPages model resolution', () => {
  test('uses facts.extraction_model from engine config (OpenAI-only brain case)', async () => {
    await engine.setConfig('facts.extraction_model', 'openai:gpt-4.1-mini');
    await seedConceptPage('concepts/cfg-key');

    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      dryRun: true,
      maxPages: 5,
    });

    expect(result.consent_gate_blocked).toBe(false);
    expect(result.llm_unavailable).toBe(false);
    expect(result.pages_scanned).toBe(1);
    expect(capturedChatOpts).toHaveLength(1);
    expect(capturedChatOpts[0].model).toBe('openai:gpt-4.1-mini');
  });

  test('falls through to models.default when facts.extraction_model is unset', async () => {
    await engine.setConfig('models.default', 'openai:gpt-4.1-mini');
    await seedConceptPage('concepts/default-fallback');

    await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      dryRun: true,
      maxPages: 5,
    });

    expect(capturedChatOpts).toHaveLength(1);
    expect(capturedChatOpts[0].model).toBe('openai:gpt-4.1-mini');
  });

  test('opts.model still wins over engine config (explicit override path)', async () => {
    await engine.setConfig('facts.extraction_model', 'openai:gpt-4.1-mini');
    await seedConceptPage('concepts/explicit-override');

    await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      dryRun: true,
      maxPages: 5,
      model: 'anthropic:claude-opus-4-7',
    });

    expect(capturedChatOpts).toHaveLength(1);
    expect(capturedChatOpts[0].model).toBe('anthropic:claude-opus-4-7');
  });

  test('does NOT route to the pre-fix hardcoded Haiku id when no config is set', async () => {
    // No facts.extraction_model, no models.default. The resolver still falls
    // through to its Sonnet default — the key regression assertion is that
    // we never silently land on the old hardcoded `anthropic:claude-haiku-4-5`.
    await seedConceptPage('concepts/no-config');

    await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      dryRun: true,
      maxPages: 5,
    });

    expect(capturedChatOpts).toHaveLength(1);
    expect(capturedChatOpts[0].model).not.toBe('anthropic:claude-haiku-4-5');
  });
});
