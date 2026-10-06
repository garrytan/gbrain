/**
 * v0.40.1.0 Track D / T3+T4 — Cross-modal --batch mode tests.
 *
 * Hermetic via the runEval DI seam (per D5). Tests the batch loop +
 * semaphore + exit precedence + receipt suppression, NOT the underlying
 * runEval orchestrator (which has its own coverage in existing tests).
 *
 * No env mutation, no mock.module — regular *.test.ts per CLAUDE.md
 * test-isolation rules.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runEvalCrossModal, runWithLimit, type BatchSummary } from '../src/commands/eval-cross-modal.ts';
import { DEFAULT_SLOTS, type RunEvalOpts, type RunEvalResult } from '../src/core/cross-modal-eval/runner.ts';
import { aggregate, type AggregateResult, type SlotResult } from '../src/core/cross-modal-eval/aggregate.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeBatchFixture(rows: object[]): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-batch-fixture-'));
  const path = join(tmp, 'batch.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

function makeStubRunEval(verdicts: Array<'pass' | 'fail' | 'inconclusive' | 'throw'>) {
  let i = 0;
  return async function stubRunEval(_opts: any): Promise<RunEvalResult> {
    const idx = i++;
    const v = verdicts[idx % verdicts.length];
    if (v === 'throw') {
      throw new Error(`stub error for question ${idx}`);
    }
    const aggregate: AggregateResult = {
      verdict: v,
      verdictMessage: `stub: ${v}`,
      overall: v === 'pass' ? 8 : v === 'fail' ? 4 : 0,
      perDimension: {},
      successCount: 3,
      modelCount: 3,
    } as any;
    return {
      finalAggregate: aggregate,
      cycles: [],
      finalReceiptPath: '/tmp/fake-receipt.json',
    };
  };
}

// ---------------------------------------------------------------------------
// 1. runWithLimit semaphore primitive (T4)
// ---------------------------------------------------------------------------

describe('runWithLimit semaphore (v0.41.15.0 — migrated to shared helper)', () => {
  // v0.41.15.0 T4 (codex #15): migrated to opts-object API from
  // src/core/worker-pool.ts. Result shape gains an additive `idx` field;
  // error field widened from `Error` to `unknown`. The `limit < 1`
  // throw is no longer raised — the helper clamps to 1 silently,
  // matching the permissive contract of runSlidingPool.
  test('never exceeds the in-flight limit', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithLimit({
      items,
      limit: 3,
      fn: async (_item) => {
        inFlight++;
        if (inFlight > maxObserved) maxObserved = inFlight;
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return 1;
      },
    });
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThanOrEqual(1);
  });

  test('per-item errors do not abort the whole batch', async () => {
    const items = [0, 1, 2, 3, 4];
    const results = await runWithLimit({
      items,
      limit: 2,
      fn: async (item) => {
        if (item === 2) throw new Error(`fail-${item}`);
        return item * 10;
      },
    });
    expect(results.length).toBe(5);
    expect(results[0]).toMatchObject({ ok: true, value: 0, idx: 0 });
    expect(results[1]).toMatchObject({ ok: true, value: 10, idx: 1 });
    expect(results[2].ok).toBe(false);
    expect(results[2].idx).toBe(2);
    expect(results[3]).toMatchObject({ ok: true, value: 30, idx: 3 });
    expect(results[4]).toMatchObject({ ok: true, value: 40, idx: 4 });
  });

  test('preserves input order in results array', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const results = await runWithLimit({
      items,
      limit: 4,
      fn: async (item) => {
        await new Promise(r => setTimeout(r, (10 - item) * 2));
        return item * item;
      },
    });
    for (let i = 0; i < items.length; i++) {
      expect(results[i]).toMatchObject({ ok: true, value: i * i, idx: i });
    }
  });

  test('limit=1 = serial', async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3];
    await runWithLimit({
      items,
      limit: 1,
      fn: async (item) => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, 5));
        order.push(item);
        return Date.now() - start;
      },
    });
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('limit > items.length still completes correctly', async () => {
    const results = await runWithLimit({
      items: [0, 1, 2],
      limit: 100,
      fn: async (x) => x + 1,
    });
    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({ ok: true, value: 1, idx: 0 });
    expect(results[1]).toMatchObject({ ok: true, value: 2, idx: 1 });
    expect(results[2]).toMatchObject({ ok: true, value: 3, idx: 2 });
  });

  test('limit < 1 silently clamps to 1 worker (v0.41.15.0 permissive contract)', async () => {
    // Prior behavior threw "limit must be >= 1". The shared helper
    // clamps via Math.max(1, ...) to match runSlidingPool's permissive
    // shape. Callers passing 0 get serial execution, not an exception.
    const results = await runWithLimit({
      items: [1, 2, 3],
      limit: 0,
      fn: async (x) => x,
    });
    expect(results.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(results[i]).toMatchObject({ ok: true, value: i + 1, idx: i });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end batch via stubbed runEval (T3 + D5 + D10)
// ---------------------------------------------------------------------------

describe('runEvalCrossModal --batch end-to-end (v0.40.1.0 Track D / T3, per D5+D10)', () => {
  test('all-pass batch → exit 0; summary receipt has expected shape', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'what is X?', hypothesis: 'X is foo.' },
      { question_id: 'q2', question: 'what is Y?', hypothesis: 'Y is bar.' },
      { question_id: 'q3', question: 'what is Z?', hypothesis: 'Z is baz.' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '3',
         '--cycles', '1', '--concurrent', '2', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'pass', 'pass']) },
      );
      expect(exit).toBe(0);
      expect(existsSync(summaryPath)).toBe(true);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      expect(summary.kind).toBe('cross_modal_batch_summary');
      expect(summary.schema_version).toBe(1);
      expect(summary.verdict).toBe('pass');
      expect(summary.pass_count).toBe(3);
      expect(summary.fail_count).toBe(0);
      expect(summary.error_count).toBe(0);
      expect(summary.inconclusive_count).toBe(0);
      expect(summary.per_question.length).toBe(3);
      expect(summary.per_question[0].question_id).toBe('q1');
      expect(summary.per_question[0].verdict).toBe('pass');
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('any FAIL → exit 1 (precedence: FAIL > INCONCLUSIVE > PASS)', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2', question: 'b', hypothesis: 'b-ans' },
      { question_id: 'q3', question: 'c', hypothesis: 'c-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '3',
         '--cycles', '1', '--concurrent', '3', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'fail', 'pass']) },
      );
      expect(exit).toBe(1);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      expect(summary.verdict).toBe('fail');
      expect(summary.fail_count).toBe(1);
      expect(summary.pass_count).toBe(2);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('any per-question ERROR → exit 2 (precedence: ERROR > FAIL > INCONCLUSIVE > PASS)', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2', question: 'b', hypothesis: 'b-ans' },
      { question_id: 'q3', question: 'c', hypothesis: 'c-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '3',
         '--cycles', '1', '--concurrent', '3', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'throw', 'fail']) },
      );
      // ERROR wins precedence over FAIL.
      expect(exit).toBe(2);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      expect(summary.verdict).toBe('error');
      expect(summary.error_count).toBe(1);
      expect(summary.fail_count).toBe(1);
      expect(summary.pass_count).toBe(1);
      const q2 = summary.per_question.find(p => p.question_id === 'q2')!;
      expect(q2.verdict).toBe('error');
      expect(q2.error).toContain('stub error');
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('any INCONCLUSIVE (no error, no fail) → exit 2', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2', question: 'b', hypothesis: 'b-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '2',
         '--cycles', '1', '--concurrent', '2', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'inconclusive']) },
      );
      expect(exit).toBe(2);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      expect(summary.verdict).toBe('inconclusive');
      expect(summary.inconclusive_count).toBe(1);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('--batch + --task mutex → exit 1 with clear error', async () => {
    const exit = await runEvalCrossModal(
      ['--batch', '/tmp/fake.jsonl', '--task', 'something', '--output', '/tmp/out.json'],
      { runEval: makeStubRunEval(['pass']) },
    );
    expect(exit).toBe(1);
  });

  test('--batch with non-existent file → exit 1', async () => {
    const exit = await runEvalCrossModal(
      ['--batch', '/tmp/this-does-not-exist-' + Date.now() + '.jsonl', '--max-usd', '1000'],
      { runEval: makeStubRunEval(['pass']) },
    );
    expect(exit).toBe(1);
  });

  test('--batch filters out by_type_summary rows (Codex #6)', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2', question: 'b', hypothesis: 'b-ans' },
      // The summary row should be filtered before batch processing.
      { schema_version: 1, kind: 'by_type_summary', recall_by_type: {}, aggregate: { hit: 0, total: 0, rate: null } },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '10',
         '--cycles', '1', '--concurrent', '2', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'pass']) },
      );
      expect(exit).toBe(0);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      // 2 rows, NOT 3 — the summary row was filtered.
      expect(summary.total).toBe(2);
      expect(summary.pass_count).toBe(2);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('--max-usd refusal without --yes', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
    ]);
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--limit', '1', '--cycles', '1', '--max-usd', '0.001'],
        { runEval: makeStubRunEval(['pass']) },
      );
      expect(exit).toBe(1);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test('--max-usd refusal bypassed by --yes', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath,
         '--limit', '1', '--cycles', '1', '--max-usd', '0.001', '--yes'],
        { runEval: makeStubRunEval(['pass']) },
      );
      expect(exit).toBe(0);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Argument parser strictness (parseIntStrict / parseFloatStrict throw paths)
// ---------------------------------------------------------------------------

describe('argument parser strictness (v0.40.1.0 Track D / coverage gap)', () => {
  test('--limit rejects non-integer with usage error → exit 1', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
    ]);
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--limit', 'not-a-number'],
        { runEval: makeStubRunEval(['pass']) },
      );
      // parseIntStrict throws synchronously inside parseArgs → caller catches in CLI
      // dispatch and returns 1. Either path is acceptable; what matters is no PASS.
      expect(exit).not.toBe(0);
    } catch (err) {
      // If parseArgs throws synchronously, that also counts as "rejected" — we
      // assert the message rather than a specific exit code.
      expect(String(err)).toMatch(/positive integer/);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  test('--max-usd rejects negative number', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
    ]);
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--max-usd', '-1'],
        { runEval: makeStubRunEval(['pass']) },
      );
      expect(exit).not.toBe(0);
    } catch (err) {
      expect(String(err)).toMatch(/non-negative number/);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Codex CDX-1 + CDX-2 — upstream error rows + --limit 0 + malformed rows
// must count in the denominator and fail-loud (no silent CI bypass).
// ---------------------------------------------------------------------------

describe('codex CDX-1 + CDX-2 — denominator-bypass defenses', () => {
  test('upstream-error rows (longmemeval emitted {error:...}) count as upstream_error, NOT silently dropped', async () => {
    // Mimics what eval-longmemeval emits when runOneQuestion throws:
    // {question_id, question, question_type, hypothesis: '', error: '...'}
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2', question: 'b', question_type: 'temporal-reasoning', hypothesis: '', error: 'upstream OOM' },
      { question_id: 'q3', question: 'c', hypothesis: 'c-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '10',
         '--cycles', '1', '--concurrent', '2', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'pass']) },  // only 2 calls (q1, q3) — q2 is upstream error
      );
      // Exit 2 because upstream_error_count > 0 (CDX-1).
      expect(exit).toBe(2);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      // Denominator is 3 (not 2!) — upstream error counted.
      expect(summary.total).toBe(3);
      expect(summary.upstream_error_count).toBe(1);
      expect(summary.error_count).toBe(0);
      expect(summary.pass_count).toBe(2);
      expect(summary.verdict).toBe('error');
      // q2 surfaces in per_question with verdict 'upstream_error'.
      const q2 = summary.per_question.find(p => p.question_id === 'q2');
      expect(q2).toBeDefined();
      expect(q2!.verdict).toBe('upstream_error');
      expect(q2!.error).toBe('upstream OOM');
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('malformed rows (missing question or hypothesis) count toward malformed_count + exit 2', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
      { question_id: 'q2' /* missing question and hypothesis */ },
      { question_id: 'q3', question: 'c', hypothesis: 'c-ans' },
    ]);
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--output', summaryPath, '--limit', '10',
         '--cycles', '1', '--concurrent', '2', '--max-usd', '1000'],
        { runEval: makeStubRunEval(['pass', 'pass']) },
      );
      expect(exit).toBe(2);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
      expect(summary.malformed_count).toBe(1);
      expect(summary.total).toBe(3);  // 2 scored + 0 upstream + 1 malformed
      expect(summary.verdict).toBe('error');
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
      rmSync(summaryPath, { force: true });
    }
  });

  test('--limit 0 is rejected (would bypass the gate with empty result → PASS)', async () => {
    const fixturePath = writeBatchFixture([
      { question_id: 'q1', question: 'a', hypothesis: 'a-ans' },
    ]);
    try {
      const exit = await runEvalCrossModal(
        ['--batch', fixturePath, '--limit', '0'],
        { runEval: makeStubRunEval(['pass']) },
      );
      expect(exit).toBe(1);
    } finally {
      rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. #5506: the summary and stderr name the judge panel; per-judge scores
// stay slot-indexed. Scores go through the real aggregate(), so the verdict
// and exit code are exactly what the same scores produce without the panel.
// ---------------------------------------------------------------------------

interface ScoredQuestion {
  /** Per dimension, one score per slot; null: that slot returned no score for it. */
  scores: Record<string, Array<number | null>>;
  /** Slot positions whose judge call errored. */
  erroredSlots?: number[];
}

function makeScoredRunEval(questions: ScoredQuestion[]) {
  let i = 0;
  return async (opts: RunEvalOpts): Promise<RunEvalResult> => {
    const q = questions[i++ % questions.length]!;
    const slotResults: SlotResult[] = (opts.slots ?? []).map((slot, idx) => {
      if (q.erroredSlots?.includes(idx)) return { ok: false, modelId: slot.model, error: 'stub judge timeout' };
      const scores: Record<string, { score: number }> = {};
      for (const [dim, perSlot] of Object.entries(q.scores)) {
        const score = perSlot[idx];
        if (typeof score === 'number') scores[dim.toUpperCase()] = { score };
      }
      return { ok: true, modelId: slot.model, parsed: { scores, improvements: [] } };
    });
    const agg = aggregate({ slots: slotResults });
    return {
      finalAggregate: agg,
      cycles: [{
        schema_version: 1,
        cycle: 1,
        task: opts.task,
        output_sha8: 'stub0000',
        slug: opts.slug ?? 'stub',
        timestamp: '2026-10-02T11:14:26Z',
        dimensions: opts.dimensions ?? [],
        // The receipt's id is the provider's first letter; scores must be
        // read by position, never by this id.
        slots: slotResults.map(s => ({
          id: s.modelId.split(':')[0]!.toUpperCase().slice(0, 1),
          model: s.modelId,
          ok: s.ok,
          error: s.ok ? undefined : s.error,
          parsed: s.ok ? s.parsed : undefined,
        })),
        aggregate: agg,
        receipt_path: '/tmp/fake-receipt.json',
      }],
      finalReceiptPath: '/tmp/fake-receipt.json',
    };
  };
}

async function runScoredBatch(slotModels: string[], questions: ScoredQuestion[]) {
  const fixturePath = writeBatchFixture(questions.map((_, i) => ({
    question_id: `q${i + 1}`, question: `question ${i + 1}?`, hypothesis: `answer ${i + 1}`,
  })));
  const summaryPath = join(mkdtempSync(join(tmpdir(), 'cm-summary-')), 'summary.json');
  const stderr: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runEvalCrossModal(
      ['--batch', fixturePath, '--output', summaryPath, '--cycles', '1', '--max-usd', '1000',
       '--slot-a-model', slotModels[0]!, '--slot-b-model', slotModels[1]!, '--slot-c-model', slotModels[2]!],
      { runEval: makeScoredRunEval(questions) },
    );
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BatchSummary;
    return { exit, summary, stderr: stderr.join('') };
  } finally {
    process.stderr.write = originalWrite;
    rmSync(fixturePath, { recursive: true, force: true });
    rmSync(summaryPath, { force: true });
  }
}

// The production night: directness 6,7,6 fails on its mean while
// correctness is 10,10,10; a second question passes.
const DIRECTNESS_FAIL: ScoredQuestion = { scores: { directness: [6, 7, 6], correctness: [10, 10, 10] } };
const ALL_PASS: ScoredQuestion = { scores: { directness: [8, 9, 8], correctness: [10, 10, 10] } };

describe('#5506: batch judge panel', () => {
  const SONNET = 'anthropic:claude-sonnet-4-6';
  const OPUS = 'anthropic:claude-opus-4-7';
  const ALL_SCORED = { directness: [6, 7, 6], correctness: [10, 10, 10] };
  const PANEL_CASES = [
    {
      name: 'slots A and C on one model (the production panel)',
      slots: [SONNET, OPUS, SONNET],
      panel: { distinct_models: 2, distinct_providers: 1, slot_scored_questions: [2, 2, 2] },
      sharedLine: `[eval cross-modal batch] judge ${SONNET} holds slots A, C, so its votes count more than once.\n`,
      notCrossModal: true,
    },
    {
      name: 'three different claude-cli models',
      slots: ['claude-cli:claude-opus-5-5', 'claude-cli:claude-sonnet-5', 'claude-cli:claude-haiku-4-5-20251001'],
      panel: { distinct_models: 3, distinct_providers: 1, slot_scored_questions: [2, 2, 2] },
      notCrossModal: true,
    },
    {
      name: 'three different models from two providers',
      slots: ['claude-cli:claude-opus-5-5', SONNET, OPUS],
      panel: { distinct_models: 3, distinct_providers: 2, slot_scored_questions: [2, 2, 2] },
      notCrossModal: true,
    },
    {
      name: 'the default three-provider panel',
      slots: DEFAULT_SLOTS.map(s => s.model),
      panel: { distinct_models: 3, distinct_providers: 3, slot_scored_questions: [2, 2, 2] },
      notCrossModal: false,
    },
    {
      // Slot B errors on every question: two providers judged, not three.
      name: 'the default panel with a slot that scored no question',
      slots: DEFAULT_SLOTS.map(s => s.model),
      erroredSlots: [1],
      panel: { distinct_models: 2, distinct_providers: 2, slot_scored_questions: [2, 0, 2] },
      silentLine: `[eval cross-modal batch] judge ${DEFAULT_SLOTS[1]!.model} in slot B scored no question, so it did not judge.\n`,
      notCrossModal: true,
      slotScores: { directness: [6, null, 6], correctness: [10, null, 10] },
    },
    {
      // Slot C shares slot A's model but never scored, so no vote counts twice.
      name: 'a shared model whose second slot scored no question',
      slots: [SONNET, OPUS, SONNET],
      erroredSlots: [2],
      panel: { distinct_models: 2, distinct_providers: 1, slot_scored_questions: [2, 2, 0] },
      silentLine: `[eval cross-modal batch] judge ${SONNET} in slot C scored no question, so it did not judge.\n`,
      notCrossModal: true,
      slotScores: { directness: [6, 7, null], correctness: [10, 10, null] },
    },
  ];

  test.each(PANEL_CASES)('$name', async ({ slots, erroredSlots, panel, sharedLine, silentLine, notCrossModal, slotScores }) => {
    const { exit, summary, stderr } = await runScoredBatch(
      slots,
      [DIRECTNESS_FAIL, ALL_PASS].map(q => ({ ...q, erroredSlots })),
    );
    // Verdict and exit code are the aggregate's, whatever the panel.
    expect(exit).toBe(1);
    expect(summary.verdict).toBe('fail');
    expect(summary.slots.map(s => s.model)).toEqual(slots);
    expect(summary.panel).toEqual(panel);
    expect(stderr).toContain(
      `(total 2) distinct_judge_models=${panel.distinct_models} distinct_judge_providers=${panel.distinct_providers}\n`,
    );
    if (sharedLine) expect(stderr).toContain(sharedLine);
    else expect(stderr).not.toContain('so its votes count more than once');
    if (silentLine) expect(stderr).toContain(silentLine);
    else expect(stderr).not.toContain('scored no question');
    expect(stderr.includes('fewer than 3 providers judged, so this panel is not cross-modal.')).toBe(notCrossModal);
    expect(summary.per_question[0]!.slot_scores).toEqual(slotScores ?? ALL_SCORED);
  });

  test('a slot that errored or gave no score holds null at its position, never shifting a vote', async () => {
    const { exit, summary } = await runScoredBatch(
      ['anthropic:claude-sonnet-4-6', 'anthropic:claude-opus-4-7', 'anthropic:claude-sonnet-4-6'],
      [
        // B errored: the aggregate keeps [6, 5] for directness.
        { scores: { directness: [6, 9, 5], correctness: [10, 10, 10] }, erroredSlots: [1] },
        // C answered but gave no directness score.
        { scores: { directness: [6, 6, null], correctness: [10, 10, 10] } },
      ],
    );
    expect(exit).toBe(1);
    // B missed one question and still judged the other.
    expect(summary.panel.slot_scored_questions).toEqual([2, 1, 2]);
    const [q1, q2] = summary.per_question;
    expect((q1!.final_aggregate as AggregateResult).dimensions.directness!.scores).toEqual([6, 5]);
    expect(q1!.slot_scores).toEqual({ directness: [6, null, 5], correctness: [10, null, 10] });
    expect(q2!.slot_scores).toEqual({ directness: [6, 6, null], correctness: [10, 10, 10] });
  });
});
