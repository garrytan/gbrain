import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import * as concurrency from '../src/core/sync-concurrency.ts';
import { extractConversationFactsLockId, runExtractConversationFacts, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';

let engine: PGLiteEngine;
let calls = 0;
let active = 0;
let maxActive = 0;
let chatText = '{"facts":[]}';
let embedVectors = false;
let onChat: (() => Promise<void>) | null = null;
const GATEWAY = { chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } };
const body = "{'source': 'microphone', 'attribution': 'me'}: hello\n{'name': 'alice-example', 'attribution': 'them', 'source': 'speaker'}: hi";

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway(GATEWAY);
  __setChatTransportForTests(async () => {
    calls++;
    if (onChat) await onChat();
    active++;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(100);
    active--;
    return { text: chatText, blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'stub', providerId: 'stub' };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    if (!embedVectors) throw new Error('unexpected embedding call');
    return { embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)) };
  }) as never);
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
  chatText = '{"facts":[]}';
  embedVectors = false;
  onChat = null;
  await engine.executeRaw('TRUNCATE facts, pages, op_checkpoints, extract_rollup_7d CASCADE');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
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
  // #5823: execute CLI diagnostics and parsing, not source-text assertions.
  test('explicit unpriced cap names pricing recovery rather than recommending a larger cap', async () => {
    await engine.setConfig('facts.extraction_model', 'anthropic:synthetic-unpriced-model');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    try {
      await expect(runExtractConversationFacts(engine, ['--source-id', 'speaker-a', '--max-cost-usd', '0.1', '--sleep', '0'])).rejects.toThrow('exit:1');
      const summary = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(summary).toContain('no_pricing: anthropic:synthetic-unpriced-model');
      expect(summary).toContain('pricing.overrides');
      expect(summary).not.toContain('Re-run with a higher --max-cost-usd');
      expect(calls).toBe(0);
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test.each(['0', '-1', 'invalid', '1junk', 'Infinity', undefined])('invalid explicit cap %s is rejected before extraction or background submission', async value => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    const args = ['--source-id', 'speaker-a', '--max-cost-usd', ...(value === undefined ? [] : [value])];
    try {
      await expect(runExtractConversationFacts(engine, args)).rejects.toThrow('exit:1');
      await expect(runExtractConversationFacts(engine, ['--background', ...args])).rejects.toThrow('--max-cost-usd requires a positive finite number');
      expect(error.mock.calls[0]?.[0]).toContain('--max-cost-usd requires a positive finite number');
      expect(calls).toBe(0);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

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

  // The dimension preflight and the Minion job path only run for Postgres
  // engines; this view reports that kind over the same PGLite database.
  function asPostgres(e: PGLiteEngine): BrainEngine {
    return new Proxy(e, { get: (t, k) => (k === 'kind' ? 'postgres' : Reflect.get(t, k, t)) }) as unknown as BrainEngine;
  }

  test('a page locked by another worker is skipped and counted; the CLI exits 3; release lets it run', async () => {
    const slug = 'conversations/object-1';
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, 99999, 'other-host', NOW(), NOW() + INTERVAL '10 minutes')`,
      [extractConversationFactsLockId('speaker-a', slug)],
    );
    const held = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-a', types: ['conversation'], sleepMs: 0 });
    expect(held).toMatchObject({ pages_lock_skipped: 1, pages_processed: 2 });
    expect(calls).toBe(2);
    // Page locks are per source: the same slug in another source is free.
    const otherSource = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-b', types: ['conversation'], sleepMs: 0 });
    expect(otherSource).toMatchObject({ pages_lock_skipped: 0, pages_processed: 3 });
    calls = 2;

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    try {
      await expect(runExtractConversationFacts(engine, ['--source-id', 'speaker-a', '--types', 'conversation', '--sleep', '0'])).rejects.toThrow('exit:3');
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('Skipped 1 page(s) held by another worker');
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
    expect(calls).toBe(2);

    await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
    // While a page is being extracted its lock expires within minutes, so a
    // crashed worker's page is reclaimable quickly (D12).
    let ttlSeconds: number | null = null;
    onChat = async () => {
      const [row] = await engine.executeRaw<{ s: number }>(
        `SELECT EXTRACT(EPOCH FROM (ttl_expires_at - NOW()))::float AS s FROM gbrain_cycle_locks WHERE id = $1`,
        [extractConversationFactsLockId('speaker-a', slug)],
      );
      ttlSeconds = row?.s ?? null;
    };
    const released = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-a', types: ['conversation'], sleepMs: 0 });
    expect(released).toMatchObject({ pages_lock_skipped: 0, pages_processed: 1 });
    expect(calls).toBe(3);
    expect(ttlSeconds).not.toBeNull();
    expect(ttlSeconds!).toBeGreaterThan(30);
    expect(ttlSeconds!).toBeLessThanOrEqual(10 * 60);
  });

  test('replay deletes a prior partial run\'s facts before extracting, keeping the new ones (D11)', async () => {
    chatText = JSON.stringify({ facts: [{ fact: 'alice-example said hi', kind: 'event', entity: 'people/alice-example', confidence: 1, notability: 'high' }] });
    embedVectors = true;
    const slug = 'conversations/object-1';
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, kind, source, source_session, source_markdown_slug, visibility, notability, confidence)
       VALUES ('speaker-a', 'stale partial-run fact', 'event', 'cli:extract-conversation-facts', $1, $2, 'private', 'high', 1)`,
      [`cli:extract-conversation-facts:${slug}`, slug],
    );
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'speaker-a', slug, sleepMs: 0 });
    expect(result.orphan_facts_cleaned).toBe(1);
    expect(result.facts_inserted).toBeGreaterThan(0);
    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = 'speaker-a' AND source_markdown_slug = $1 AND source = 'cli:extract-conversation-facts'`,
      [slug],
    );
    expect(rows.map(r => r.fact)).not.toContain('stale partial-run fact');
    expect(rows).toHaveLength(result.facts_inserted);
  });

  test('embedding-width drift fails the run before any page is attempted (D15 preflight)', async () => {
    configureGateway({ ...GATEWAY, embedding_dimensions: 1024 });
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runExtractConversationFactsCore(asPostgres(engine), { sourceId: 'speaker-a', types: ['conversation'], sleepMs: 0 })).rejects.toThrow(/halfvec\(1536\).*1024/);
      const stderr = err.mock.calls.map(c => String(c[0])).join('');
      expect(stderr).not.toContain('conversations/');
      expect(calls).toBe(0);
    } finally {
      err.mockRestore();
      configureGateway(GATEWAY);
    }
  });

  test('--workers reaches the worker resolver and the --background job envelope', async () => {
    const resolve = spyOn(concurrency, 'resolveWorkersWithClamp');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--source-id', 'speaker-a', '--types', 'conversation', '--sleep', '0', '--workers', '5']);
      expect(resolve.mock.calls[0]?.[1]).toBe(5);
    } finally {
      log.mockRestore();
      resolve.mockRestore();
    }
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runExtractConversationFacts(asPostgres(engine), ['--background', '--source-id', 'speaker-a', '--workers', '20']);
    } finally {
      out.mockRestore();
    }
    const [job] = await engine.executeRaw<{ data: any }>(`SELECT data FROM minion_jobs WHERE name = 'extract-conversation-facts' ORDER BY id DESC LIMIT 1`);
    const data = typeof job!.data === 'string' ? JSON.parse(job!.data) : job!.data;
    expect(data.workers).toBe(20);
  });
});
