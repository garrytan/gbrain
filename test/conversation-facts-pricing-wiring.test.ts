/**
 * #4633 — every capped Conversation Facts entry point must load the same
 * DB-plane pricing.overrides map before constructing its BudgetTracker.
 *
 * Hermetic: one PGLite engine plus gateway test transports. No network, API
 * keys, or production database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import { runIngestFacts } from '../src/core/transcripts/ingest-facts.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const MODEL = 'litellm:custom-chat';
const SLUG = 'conversations/pricing-override-example';
const BODY = [
  '**Alice Example** (2026-08-27 9:00 AM): The example rollout is complete.',
  '**Bob Demo** (2026-08-27 9:01 AM): Record the result.',
].join('\n');

let engine: PGLiteEngine;
let chatCalls = 0;

async function seedPage(): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'conversation',
    title: 'Pricing override example',
    compiled_truth: BODY,
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'default' });
}

async function terminalCount(): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM facts
      WHERE source_id = 'default'
        AND source_markdown_slug = $1
        AND source = 'cli:extract-conversation-facts:terminal:v2'`,
    [SLUG],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  resetGateway();
  configureGateway({
    chat_model: MODEL,
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    base_urls: { litellm: 'http://localhost:4000' },
    env: { LITELLM_BASE_URL: 'http://localhost:4000', OPENAI_API_KEY: 'test' },
  });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return {
      text: JSON.stringify({
        facts: [{
          fact: 'the example rollout is complete',
          kind: 'event',
          entity: null,
          confidence: 1,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: MODEL,
      providerId: 'litellm',
    };
  });
  __setEmbedTransportForTests(
    (async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
    })) as never,
  );
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  chatCalls = 0;
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, [SLUG]);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
  await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('pricing.overrides', JSON.stringify({
    [MODEL]: { input: 1, output: 2 },
  }));
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '0.1');
  await engine.setConfig('cycle.conversation_facts_backfill.max_total_cost_usd', '0.1');
  await seedPage();
});

describe('Conversation Facts pricing override wiring', () => {
  test('the documented config key is accepted by the strict config registry', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('pricing.overrides');
  });

  test('direct core extraction uses the configured operator price', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: SLUG,
      maxCostUsd: 0.1,
      sleepMs: 0,
    });

    expect(result.budget_exhausted).not.toBe(true);
    expect(chatCalls).toBeGreaterThan(0);
    expect(await terminalCount()).toBe(1);
  });

  test('cycle backfill passes operator pricing to its external tracker', async () => {
    const result = await runPhaseConversationFactsBackfill(engine, {});
    const details = result.details as Record<string, unknown>;

    expect(details.sources_budget_exhausted).toBe(0);
    expect(chatCalls).toBeGreaterThan(0);
    expect(await terminalCount()).toBe(1);
  });

  test('transcripts --facts passes operator pricing to its external tracker', async () => {
    await runIngestFacts(engine, {
      sourceId: 'default',
      slugs: [SLUG],
      maxCostUsd: 0.1,
      quiet: true,
    });

    expect(chatCalls).toBeGreaterThan(0);
    expect(await terminalCount()).toBe(1);
  });
});
