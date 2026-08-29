/**
 * #3627 — conversation_facts_backfill per-source caps must be ENFORCED.
 *
 * Pre-fix, cfg.maxCostUsd / cfg.maxWalltimeMin were parsed and never read
 * again: the phase created ONE brain-wide tracker, the sole walltime check
 * sat at the source-loop top (fires at most once with a single source), and
 * the core ignores opts.maxCostUsd when a budgetTracker is passed. One
 * runaway source could eat the whole brain-wide budget/walltime while every
 * later source starved.
 *
 * Post-fix, each source runs under its own BudgetTracker capped at
 * min(max_cost_usd, brain-wide remainder) with maxRuntimeMs, plus an
 * AbortController deadline threaded as the core's signal. Per-source
 * exhaustion records and CONTINUES; only the brain-wide caps break.
 *
 * Hermetic: PGLite + __setChatTransportForTests (slow / token-heavy stubs).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  configureGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';

let engine: PGLiteEngine;

/** Per-test transport knobs. */
let chatDelayMs = 0;
let chatOutputTokens = 50;
let chatCalls = 0;
let chatCallsBySource: string[] = [];

const CONVO_BODY = [
  '**Alice Example** (2024-03-15 9:00 AM): I just signed the offer letter for Acme Corp.',
  '**Bob Demo** (2024-03-15 9:01 AM): Congrats! What is the title?',
  '**Alice Example** (2024-03-15 9:02 AM): Staff engineer on the platform team.',
].join('\n');

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
  await engine.putPage(`conversations/${id}-chat`, {
    type: 'conversation',
    title: `Chat in ${id}`,
    compiled_truth: CONVO_BODY,
    timeline: '',
    frontmatter: {},
  }, { sourceId: id });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  resetGateway();
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' },
  });

  __setChatTransportForTests(async (opts): Promise<ChatResult> => {
    chatCalls++;
    chatCallsBySource.push(String(opts.messages[0]?.content ?? '').slice(0, 40));
    if (chatDelayMs > 0) await new Promise((r) => setTimeout(r, chatDelayMs));
    if (opts.abortSignal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    return {
      text: JSON.stringify({
        facts: [{
          fact: 'alice example joined acme corp',
          kind: 'event',
          entity: null,
          confidence: 1.0,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 100,
        output_tokens: chatOutputTokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    };
  });
  __setEmbedTransportForTests(
    (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
  );

  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  // Shard hygiene: restore the legacy 1536-d pin for later files.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
  await engine.disconnect();
});

beforeEach(async () => {
  chatDelayMs = 0;
  chatOutputTokens = 50;
  chatCalls = 0;
  chatCallsBySource = [];
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
  await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
  // Sources persist across tests (listSources sees them all); drop their
  // conversation pages so earlier tests' sources iterate as cheap no-ops.
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'conversations/%'`);
  // Reset caps to generous defaults; tests tighten what they exercise.
  await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '1');
  await engine.setConfig('cycle.conversation_facts_backfill.max_total_cost_usd', '5');
  await engine.setConfig('cycle.conversation_facts_backfill.max_walltime_min', '20');
  await engine.setConfig('cycle.conversation_facts_backfill.max_total_walltime_min', '30');
});

describe('runPhaseConversationFactsBackfill per-source caps (#3627)', () => {
  test('happy path: two sources both extract under generous caps', async () => {
    await seedSource('src-a');
    await seedSource('src-b');
    const r = await runPhaseConversationFactsBackfill(engine, {});
    expect(r.status).toBe('ok');
    const d = r.details as Record<string, unknown>;
    expect(d.sources_budget_exhausted).toBe(0);
    expect(d.sources_walltime_exhausted).toBe(0);
    const perSource = d.per_source as Record<string, { facts_inserted: number }>;
    expect(perSource['src-a']?.facts_inserted).toBeGreaterThan(0);
    expect(perSource['src-b']?.facts_inserted).toBeGreaterThan(0);
  }, 120000);

  test('per-source cost cap: an expensive source is capped but the NEXT source still runs', async () => {
    await seedSource('src-cost-a');
    await seedSource('src-cost-b');
    // Token-heavy responses: sonnet output pricing makes >1 call exceed a
    // micro cap, so source A exhausts its own budget mid-run.
    chatOutputTokens = 200_000;
    await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '0.5');
    // Brain-wide cap is far larger — a per-source overrun must NOT starve B.
    await engine.setConfig('cycle.conversation_facts_backfill.max_total_cost_usd', '50');

    const r = await runPhaseConversationFactsBackfill(engine, {});
    const d = r.details as Record<string, unknown>;
    const perSource = d.per_source as Record<string, { budget_exhausted?: boolean }>;
    // Both sources were ATTEMPTED (pre-fix the brain-wide tracker exhausted
    // once and the loop broke, starving every later source). listSources also
    // returns sources seeded by earlier tests — containment, not equality.
    expect(Object.keys(perSource)).toContain('src-cost-a');
    expect(Object.keys(perSource)).toContain('src-cost-b');
    expect(d.sources_budget_exhausted as number).toBeGreaterThan(0);
    // Spend is summed across per-source trackers.
    expect(d.spent_usd as number).toBeGreaterThan(0);
  }, 120000);

  test('per-source walltime: a slow source aborts but the NEXT source still runs', async () => {
    await seedSource('src-slow-a');
    await seedSource('src-slow-b');
    // ~0.0005 min = 30ms per-source deadline; each chat call takes 500ms.
    chatDelayMs = 500;
    await engine.setConfig('cycle.conversation_facts_backfill.max_walltime_min', '0.0005');
    await engine.setConfig('cycle.conversation_facts_backfill.max_total_walltime_min', '30');

    const r = await runPhaseConversationFactsBackfill(engine, {});
    const d = r.details as Record<string, unknown>;
    const perSource = d.per_source as Record<string, { walltime_exhausted?: boolean; budget_exhausted?: boolean; error?: string }>;
    // Pre-fix maxWalltimeMin was never enforced: no per-source record ever
    // carried an exhaustion marker and the run just took as long as it took.
    const exhausted = (d.sources_walltime_exhausted as number) + (d.sources_budget_exhausted as number);
    expect(exhausted).toBeGreaterThan(0);
    // Both sources were attempted — a slow source can't starve its siblings.
    expect(Object.keys(perSource)).toContain('src-slow-a');
    expect(Object.keys(perSource)).toContain('src-slow-b');
  }, 120000);

  test('brain-wide walltime still skips remaining sources', async () => {
    await seedSource('src-brain-a');
    await seedSource('src-brain-b');
    chatDelayMs = 300;
    // Brain-wide cap tighter than one source's work: later sources skip.
    await engine.setConfig('cycle.conversation_facts_backfill.max_walltime_min', '20');
    await engine.setConfig('cycle.conversation_facts_backfill.max_total_walltime_min', '0.000001');

    const r = await runPhaseConversationFactsBackfill(engine, {});
    const d = r.details as Record<string, unknown>;
    expect(d.skipped_by_brain_wide_walltime as number).toBeGreaterThan(0);
  }, 120000);

  test('disabled gate is untouched: skipped without once', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'false');
    try {
      const r = await runPhaseConversationFactsBackfill(engine, {});
      expect(r.status).toBe('skipped');
    } finally {
      await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    }
  }, 120000);
});
