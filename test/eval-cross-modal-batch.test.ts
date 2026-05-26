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
import type { RunEvalResult } from '../src/core/cross-modal-eval/runner.ts';
import type { AggregateResult } from '../src/core/cross-modal-eval/aggregate.ts';

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

describe('runWithLimit semaphore (v0.40.1.0 Track D / T4, per D6)', () => {
  test('never exceeds the in-flight limit', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithLimit(items, 3, async (_item) => {
      inFlight++;
      if (inFlight > maxObserved) maxObserved = inFlight;
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return 1;
    });
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThanOrEqual(1);
  });

  test('per-item errors do not abort the whole batch', async () => {
    const items = [0, 1, 2, 3, 4];
    const results = await runWithLimit(items, 2, async (item) => {
      if (item === 2) throw new Error(`fail-${item}`);
      return item * 10;
    });
    expect(results.length).toBe(5);
    expect(results[0]).toEqual({ ok: true, value: 0 });
    expect(results[1]).toEqual({ ok: true, value: 10 });
    expect(results[2].ok).toBe(false);
    expect(results[3]).toEqual({ ok: true, value: 30 });
    expect(results[4]).toEqual({ ok: true, value: 40 });
  });

  test('preserves input order in results array', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const results = await runWithLimit(items, 4, async (item) => {
      // Intentional non-uniform sleep to scramble completion order.
      await new Promise(r => setTimeout(r, (10 - item) * 2));
      return item * item;
    });
    for (let i = 0; i < items.length; i++) {
      expect(results[i]).toEqual({ ok: true, value: i * i });
    }
  });

  test('limit=1 = serial', async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3];
    await runWithLimit(items, 1, async (item) => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, 5));
      order.push(item);
      return Date.now() - start;
    });
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('limit > items.length still completes correctly', async () => {
    const results = await runWithLimit([0, 1, 2], 100, async (x) => x + 1);
    expect(results).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
    ]);
  });

  test('limit < 1 throws (defensive)', async () => {
    await expect(runWithLimit([1, 2, 3], 0, async (x) => x)).rejects.toThrow(/limit must be >= 1/);
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
