/**
 * Takes-extraction model resolution regression (#2997).
 *
 * extractTakesFromPages hardcoded `anthropic:claude-haiku-4-5` as the
 * classifier model. On OAuth/local-only installs (no ANTHROPIC_API_KEY;
 * chat routed through a gateway model) every extraction died with
 * llm_unavailable even though a working chat_model was configured.
 *
 * Pins the fix's resolution order AND its config plane:
 *   opts.model → getChatModel() (file-plane gateway config, the enrich.ts
 *   idiom) — NOT the DB config plane (engine.getConfig('chat_model')).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;
const seenModels: string[] = [];
let pageN = 0;

/** Each test seeds a fresh uncovered page so the extraction loop fires. */
async function seedPage(): Promise<void> {
  const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
  await engine.putPage(`concepts/model-resolution-${pageN++}`, {
    type: 'concept', title: `M${pageN}`, compiled_truth: body, frontmatter: {},
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  __setChatTransportForTests(async (opts) => {
    seenModels.push(opts.model ?? '(unset)');
    return {
      text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]',
      blocks: [{ type: 'text' as const, text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? '(unset)',
      providerId: 'test',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  seenModels.length = 0;
});

describe('extractTakesFromPages — model resolution (#2997)', () => {
  test('defaults to the configured chat_model from the file-plane gateway config', async () => {
    configureGateway({
      chat_model: 'openai:gpt-config-plane-test',
      env: { OPENAI_API_KEY: 'sk-test-model-resolution' },
    });
    // A conflicting DB-plane value must be IGNORED — model config is the
    // config-file plane (getChatModel), not the brain DB config table.
    await engine.setConfig('chat_model', 'wrong:db-plane-model');
    await seedPage();

    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['openai:gpt-config-plane-test']);
  });

  test('explicit opts.model wins over the configured chat_model', async () => {
    configureGateway({
      chat_model: 'openai:gpt-config-plane-test',
      env: { OPENAI_API_KEY: 'sk-test-model-resolution' },
    });
    await seedPage();

    const r = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      maxPages: 50,
      model: 'anthropic:claude-haiku-4-5',
    });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['anthropic:claude-haiku-4-5']);
  });
});
