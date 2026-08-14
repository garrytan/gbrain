/**
 * BrainBench continuity — writer fixture replays through harness A, its
 * decision persists via the production write-back pipeline, reader fixture
 * replays through harness B on the SAME brain, and the decision must be
 * recallable. Scores land on the reader's cell.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadCorpus } from '../src/eval/brainbench/fixtures.ts';
import { runBrainBench } from '../src/eval/brainbench/harness.ts';
import { factKeywordProbe, scoreContinuityPair } from '../src/eval/brainbench/metrics/continuity.ts';
import type { LoadedCorpus } from '../src/eval/brainbench/types.ts';

let pairCorpus: LoadedCorpus;

beforeAll(async () => {
  const corpus = await loadCorpus('evals/brainbench/fixtures', 'evals/brainbench/gold');
  const pair = corpus.fixtures.filter(
    (f) => f.fixture.continuity?.pair_id === 'cont-001',
  );
  expect(pair.length).toBe(2);
  pairCorpus = { ...corpus, fixtures: pair };
});

describe('writer openclaw → reader codex (and reverse) on a shared brain', () => {
  test('decision recalled in both directions; cells assigned to the READER harness', async () => {
    const out = await runBrainBench(pairCorpus, {
      harnesses: ['openclaw', 'codex'],
      suites: ['continuity', 'write-back'],
      includeHoldout: true,
      llm: false,
    });
    expect(out.seed_failures).toEqual([]);
    const contCells = out.cells.filter((c) => c.suite === 'continuity');
    expect(contCells.map((c) => c.harness).sort()).toEqual(['codex', 'openclaw']);
    for (const c of contCells) {
      expect(c.gold_total).toBe(1); // one decision probe per reader direction
      expect(c.gold_failed).toBe(0);
      expect(c.metrics.continuity_rate).toBe(1);
    }
    // Reader turn rows exist and carry the continuity suite tag.
    const readerRows = out.turn_rows.filter((r) => r.suite === 'continuity');
    expect(readerRows.length).toBeGreaterThan(0);
    expect(readerRows.every((r) => r.fixture_id === 'cont-001-widget-pass-reader')).toBe(true);
  }, 30_000);

  test('single-harness run falls back to the diagonal (writer == reader) instead of vanishing', async () => {
    const out = await runBrainBench(pairCorpus, {
      harnesses: ['openclaw'],
      suites: ['continuity'],
      includeHoldout: true,
      llm: false,
    });
    const cell = out.cells.find((c) => c.suite === 'continuity' && c.harness === 'openclaw');
    expect(cell).toBeDefined();
    expect(cell!.metrics.continuity_rate).toBe(1);
  }, 30_000);
});

describe('factKeywordProbe + the miss path', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await createBenchmarkBrain();
    await engine.insertFact( // gbrain-allow-direct-insert: keyword-probe semantics test in a throwaway benchmark brain
      { fact: 'Decided to pass on the widget-co round', source: 'bench:test', embedding: null },
      { source_id: 'default' },
    );
    const expired = await engine.insertFact( // gbrain-allow-direct-insert: expired-row exclusion probe in a throwaway benchmark brain
      { fact: 'Decided to lead the acme-example round', source: 'bench:test', embedding: null },
      { source_id: 'default' },
    );
    await engine.expireFact(expired.id);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('AND semantics: every keyword must match; partial sets fail', async () => {
    expect(await factKeywordProbe(engine, 'default', ['pass', 'widget-co'])).toBe(true);
    expect(await factKeywordProbe(engine, 'default', ['pass', 'no-such-keyword'])).toBe(false);
  }, 30_000);

  test('expired facts are excluded — a superseded decision is not "recalled"', async () => {
    expect(await factKeywordProbe(engine, 'default', ['lead', 'acme-example'])).toBe(false);
  }, 30_000);

  test('a decision neither injected nor stored counts into gold_failed with a named item', async () => {
    const score = await scoreContinuityPair(engine, 'default', 'pair-x', [], [
      { decision_id: 'd-missing', expected_slugs: ['decisions/nope'], match_keywords: ['never', 'stored'] },
      { decision_id: 'd-hit', expected_slugs: [], match_keywords: ['pass', 'widget-co'] },
    ]);
    expect(score.gold_total).toBe(2);
    expect(score.gold_failed).toBe(1);
    expect(score.hits['d-missing']).toBe(false);
    expect(score.hits['d-hit']).toBe(true);
    expect(score.failed_items[0]).toContain('pair-x/d-missing');
  }, 30_000);
});
