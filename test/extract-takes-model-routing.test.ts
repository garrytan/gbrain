import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';

describe('extractTakesFromPages model routing', () => {
  beforeEach(() => {
    resetGateway();
    __setChatTransportForTests(null);
    configureGateway({
      chat_model: 'openrouter:gpt-5.4',
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
    });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  test('uses facts.extraction_model instead of hardcoded Anthropic Haiku', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      await engine.setConfig('facts.extraction_model', 'openrouter:gpt-5.4-mini');
      await engine.db.query(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter, content_hash, updated_at)
         VALUES ('default', 'concepts/model-routing', 'concept', 'Model Routing', $1, '{}'::jsonb, 'hash-model-routing', now())`,
        ['This page contains a gradeable claim: configured model routing should be honored during takes extraction. '.repeat(6)],
      );

      const seenModels: string[] = [];
      __setChatTransportForTests(async (opts) => {
        seenModels.push(opts.model ?? '<unset>');
        return {
          text: JSON.stringify([{ claim: 'Configured model routing is honored during takes extraction', kind: 'fact', weight: 0.9 }]),
          blocks: [{ type: 'text', text: '[]' }],
          stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: opts.model ?? 'openrouter:gpt-5.4-mini',
          providerId: 'openrouter',
        };
      });

      const result = await extractTakesFromPages(engine, {
        bootstrapEnabled: true,
        dryRun: true,
        maxPages: 1,
      });

      expect(result.llm_unavailable).toBe(false);
      expect(result.pages_scanned).toBe(1);
      expect(result.claims_extracted).toBe(1);
      expect(seenModels).toEqual(['openrouter:gpt-5.4-mini']);
    } finally {
      await engine.disconnect();
    }
  });
});
