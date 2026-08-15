/**
 * BrainBench write-back — the metric must grade the PRODUCTION
 * conversation→facts pipeline (decision 15): rendered conversation page →
 * parseConversation → segmentation → injected gold extractor → insertFacts →
 * provenance read-back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { createBenchmarkBrain, resetTables } from '../src/eval/longmemeval/harness.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadCorpus } from '../src/eval/brainbench/fixtures.ts';
import { seedBrain } from '../src/eval/brainbench/seed.ts';
import {
  conversationSlug,
  makeGoldExtractor,
  renderConversationPage,
  runWriteBack,
} from '../src/eval/brainbench/metrics/write-back.ts';
import { parseConversationMessages, PER_SEGMENT_SOURCE_PREFIX } from '../src/commands/extract-conversation-facts.ts';
import type { LoadedFixture } from '../src/eval/brainbench/types.ts';

let engine: PGLiteEngine;
let wb: LoadedFixture;

beforeAll(async () => {
  engine = await createBenchmarkBrain();
  const corpus = await loadCorpus('evals/brainbench/fixtures', 'evals/brainbench/gold');
  wb = corpus.fixtures.find((f) => f.fixture.fixture_id === 'wb-001-pricing-concern')!;
});

afterAll(async () => {
  await engine.disconnect();
});

describe('renderConversationPage', () => {
  test('renders the imessage-slack line shape the production parser ships', () => {
    const body = renderConversationPage(wb.fixture);
    expect(body).toContain('type: conversation');
    expect(body).toMatch(/\*\*You\*\* \(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)\): /);
    const messages = parseConversationMessages(body);
    expect(messages.length).toBe(wb.fixture.turns.length);
    expect(messages[0].speaker).toBe('You');
  });
});

describe('makeGoldExtractor', () => {
  test('emits exactly the gold facts whose source turn appears in the segment text', async () => {
    const extractor = makeGoldExtractor(wb.fixture, wb.gold);
    const turn3 = wb.fixture.turns.find((t) => t.turn_id === 3)!;
    const out = await extractor({ turnText: `header\n${turn3.text}\nmore`, source: 'cli:x' });
    expect(out.length).toBe(1);
    expect(out[0].entity_slug).toBe('people/alice-example');
    const none = await extractor({ turnText: 'unrelated segment text', source: 'cli:x' });
    expect(none.length).toBe(0);
  }, 30_000);
});

describe('runWriteBack (deterministic, production pipeline)', () => {
  test('gold facts survive with full fidelity and correct provenance', async () => {
    await resetTables(engine);
    await seedBrain(engine, wb.fixture);
    const score = await runWriteBack(engine, wb.fixture, wb.gold, { llm: false });
    expect(score.gold_total).toBe(3);
    expect(score.gold_failed).toBe(0);
    expect(score.metrics.write_back_fidelity).toBe(1);
    expect(score.metrics.provenance_accuracy).toBe(1);
    // and the provenance is the production pipeline's, verifiable in the table
    const slug = conversationSlug(wb.fixture.fixture_id);
    const rows = await engine.executeRaw<{ source: string; source_session: string }>(
      `SELECT source, source_session FROM facts
        WHERE source_markdown_slug = $1 AND source = $2`,
      [slug, PER_SEGMENT_SOURCE_PREFIX],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].source_session).toBe(`${PER_SEGMENT_SOURCE_PREFIX}:${slug}`);
  }, 30_000);

  test('a gold fact the pipeline drops is counted as failed, named in failed_items', async () => {
    await resetTables(engine);
    await seedBrain(engine, wb.fixture);
    // Doctor the gold so one fact's keywords can never match what the
    // extractor emits (the extractor emits gold.fact verbatim — mismatched
    // keywords simulate a lost/garbled fact).
    const doctored = structuredClone(wb.gold);
    doctored.turns['3'].gold_facts![0].match_keywords = ['keyword-that-never-appears'];
    const score = await runWriteBack(engine, wb.fixture, doctored, { llm: false });
    expect(score.gold_failed).toBe(1);
    expect(score.metrics.write_back_fidelity).toBeCloseTo(2 / 3);
    expect(score.failed_items[0]).toContain('gold fact lost');
  }, 30_000);

  test('--llm branch: real-extractor lane emits extraction metrics (stubbed transport)', async () => {
    await resetTables(engine);
    await seedBrain(engine, wb.fixture);
    // Stubbed chat transport plays the real extractor's role: one fact whose
    // text carries one gold probe's keywords, so extraction metrics land
    // strictly between 0 and 1 (partial recall, full precision).
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [{
          fact: 'Alice Example flagged the pricing model undercutting gross margin',
          kind: 'belief',
          entity: 'people/alice-example',
          confidence: 1.0,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'stub:stub',
      providerId: 'stub',
    }));
    __setEmbedTransportForTests(
      (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
    );
    try {
      const score = await runWriteBack(engine, wb.fixture, wb.gold, { llm: true, budgetUsd: 1 });
      expect(score.metrics.extraction_recall).toBeDefined();
      expect(score.metrics.extraction_precision).toBeDefined();
      // One of three gold facts survives via the stub → recall 1/3, precision 1.
      expect(score.metrics.extraction_recall).toBeCloseTo(1 / 3);
      expect(score.metrics.extraction_precision).toBe(1);
      expect(score.stored_rows).toBeGreaterThan(0);
    } finally {
      __setChatTransportForTests(null);
      __setEmbedTransportForTests(null);
    }
  }, 30_000);

  test('--llm extraction metrics reach the harness CELLS (review finding: they were dropped in aggregation)', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [{
          fact: 'Alice Example flagged the pricing model undercutting gross margin',
          kind: 'belief',
          entity: 'people/alice-example',
          confidence: 1.0,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'stub:stub',
      providerId: 'stub',
    }));
    __setEmbedTransportForTests(
      (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
    );
    try {
      const { loadCorpus } = await import('../src/eval/brainbench/fixtures.ts');
      const { runBrainBench } = await import('../src/eval/brainbench/harness.ts');
      const corpus = await loadCorpus('evals/brainbench/fixtures', 'evals/brainbench/gold');
      const sub = { ...corpus, fixtures: corpus.fixtures.filter((f) => f.fixture.fixture_id === 'wb-001-pricing-concern') };
      const out = await runBrainBench(sub, {
        harnesses: ['openclaw'], suites: ['write-back'], includeHoldout: true, llm: true, budgetUsd: 1,
      });
      const cell = out.cells.find((c) => c.suite === 'write-back');
      expect(cell).toBeDefined();
      expect(cell!.metrics.extraction_recall).toBeCloseTo(1 / 3);
      expect(cell!.metrics.extraction_precision).toBe(1);
    } finally {
      __setChatTransportForTests(null);
      __setEmbedTransportForTests(null);
    }
  }, 30_000);

  test('multi-segment conversations extract per segment (the 45-min gap splits)', async () => {
    await resetTables(engine);
    // gen-wb fixtures carry a deliberate >30min gap; use one.
    const corpus = await loadCorpus('evals/brainbench/fixtures', 'evals/brainbench/gold');
    const genWb = corpus.fixtures.find((f) => f.fixture.fixture_id === 'gen-wb-001')!;
    await seedBrain(engine, genWb.fixture);
    const score = await runWriteBack(engine, genWb.fixture, genWb.gold, { llm: false });
    expect(score.gold_failed).toBe(0);
    expect(score.metrics.write_back_fidelity).toBe(1);
  }, 30_000);
});
