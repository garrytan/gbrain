import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import * as concurrency from '../src/core/sync-concurrency.ts';
import { runExtractConversationFacts, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';

let engine: PGLiteEngine;
let calls = 0;
let active = 0;
let maxActive = 0;
const body = "{'source': 'microphone', 'attribution': 'me'}: hello\n{'name': 'alice-example', 'attribution': 'them', 'source': 'speaker'}: hi";

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(100);
    active--;
    return { text: '{"facts":[]}', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'stub', providerId: 'stub' };
  });
  __setEmbedTransportForTests((async () => { throw new Error('unexpected embedding call'); }) as never);
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  calls = 0;
  active = 0;
  maxActive = 0;
  await engine.executeRaw('TRUNCATE facts, pages, op_checkpoints, extract_rollup_7d CASCADE');
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await engine.setConfig('cycle.conversation_facts_backfill.workers', '3');
  for (const sourceId of ['speaker-a', 'speaker-b']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
    for (const [slug, compiled_truth, type] of [
      ['conversations/object-1', body, 'conversation'],
      ['conversations/object-2', body, 'conversation'],
      ['conversations/object-3', body, 'conversation'],
      ['conversations/single', body.split('\n')[0], 'conversation'],
      ['conversations/unparsed', 'Opaque prose without speaker turns.', 'conversation'],
      ['people/profile-example', 'An ordinary profile.', 'person'],
    ] as const) {
      await engine.putPage(slug, { title: slug, type, compiled_truth, timeline: '', frontmatter: { date: '2026-06-02' } }, { sourceId });
    }
  }
});

describe('#5364 diagnostics across workers, sources, CLI, and cycle', () => {
  test('dry-run help promises segmentation without model calls', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--help']);
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('--dry-run              Show segmentation + counts; no model calls, DB writes, or checkpoint advance.');
      expect(calls).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test('three actual pool workers share exact counters and keep source outcomes isolated', async () => {
    const workerCount = spyOn(concurrency, 'resolveWorkersWithClamp').mockReturnValue({ workers: 3, reason: 'override', wasClamped: false, requested: 3 });
    try {
      const result = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-a', types: ['conversation'], workers: 3, sleepMs: 0 });
      expect(result).toMatchObject({ pages_considered: 5, pages_processed: 3, pages_skipped: 2, pages_skipped_unparsed: 1, pages_skipped_insufficient_turns: 1, pages_skipped_type_mismatch: 0, pages_skipped_since: 0, pages_failed: 0, pages_marked_non_extractable: 1, segments_processed: 3 });
      expect(calls).toBe(3);
      expect(maxActive).toBe(3);
      expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id = 'speaker-b'")).toEqual([]);
      const replay = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-a', types: ['conversation'], workers: 3, sleepMs: 0 });
      expect(replay).toMatchObject({ pages_considered: 5, pages_processed: 0, pages_skipped: 1, pages_skipped_unparsed: 1, pages_skipped_insufficient_turns: 0, pages_skipped_completed: 3, pages_skipped_non_extractable: 1 });
      expect(calls).toBe(3);
    } finally {
      workerCount.mockRestore();
    }
  });

  test('CLI combines dry-run skip subsets without claiming checkpoint skips', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--dry-run', '--sleep', '0', '--types', 'conversation']);
      const summary = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(summary).toContain('across 6 segments');
      expect(summary).toContain('segmentation only; no facts extracted');
      expect(summary).toContain('from 6/10 pages');
      expect(summary).toContain('Skipped 4 page(s)');
      expect(summary).toContain('2 with no parseable speaker turns');
      expect(summary).toContain('2 with insufficient turns');
      expect(summary).not.toContain('since last checkpoint');
      expect(calls).toBe(0);
      log.mockClear();
      await runExtractConversationFacts(engine, ['--dry-run', '--slug', 'people/profile-example']);
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('2 with a type mismatch');
      log.mockClear();
      await runExtractConversationFacts(engine, ['--dry-run', '--types', 'conversation', '--since', '2099-01-01']);
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('6 with no eligible segments after --since');
      expect(calls).toBe(0);
      expect(await engine.executeRaw('SELECT id FROM facts')).toEqual([]);
      expect(await engine.executeRaw('SELECT * FROM op_checkpoints')).toEqual([]);
      expect(await engine.executeRaw('SELECT * FROM extract_rollup_7d')).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('cycle totals equal exact per-source subsets in dry-run and durable replay', async () => {
    const dry = await runPhaseConversationFactsBackfill(engine, { dryRun: true });
    expect(dry.status).toBe('ok');
    expect(dry.details).toMatchObject({ pages_processed: 6, pages_skipped: 4, pages_skipped_unparsed: 2, pages_skipped_type_mismatch: 0, pages_skipped_insufficient_turns: 2, pages_skipped_since: 0 });
    const sources = dry.details?.per_source as Record<string, unknown>;
    for (const id of ['speaker-a', 'speaker-b']) expect(sources[id]).toMatchObject({ pages_considered: 5, pages_processed: 3, pages_skipped: 2, pages_skipped_unparsed: 1, pages_skipped_insufficient_turns: 1, pages_skipped_since: 0, pages_skipped_type_mismatch: 0 });
    expect(calls).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM facts')).toEqual([]);
    expect(await engine.executeRaw('SELECT * FROM op_checkpoints')).toEqual([]);
    const first = await runPhaseConversationFactsBackfill(engine, {});
    expect(first.details).toMatchObject({ pages_processed: 6, pages_skipped: 4, pages_skipped_unparsed: 2, pages_skipped_insufficient_turns: 2, pages_marked_non_extractable: 2 });
    expect(calls).toBe(6);
    const second = await runPhaseConversationFactsBackfill(engine, {});
    expect(second.details).toMatchObject({ pages_processed: 0, pages_skipped: 2, pages_skipped_unparsed: 2, pages_skipped_insufficient_turns: 0, pages_skipped_completed: 6, pages_skipped_non_extractable: 2, pages_marked_non_extractable: 0 });
    expect(calls).toBe(6);
  });
});
