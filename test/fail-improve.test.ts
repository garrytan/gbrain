import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { FailImproveLoop } from '../src/core/fail-improve.ts';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('fail-improve', () => {
  let tempDir: string;
  let loop: FailImproveLoop;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-fail-improve-'));
    loop = new FailImproveLoop(tempDir);
  });

  afterAll(() => {
    // Clean up temp dirs
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('execute returns deterministic result when it succeeds', async () => {
    const result = await loop.execute(
      'test_op',
      'hello',
      (input) => input.toUpperCase(),
      async () => 'llm-fallback',
    );
    expect(result).toBe('HELLO');
  });

  test('execute falls back to LLM when deterministic returns null', async () => {
    const result = await loop.execute(
      'test_op',
      'hello',
      () => null,
      async (input) => `llm: ${input}`,
    );
    expect(result).toBe('llm: hello');
  });

  test('execute logs failure when deterministic returns null', async () => {
    await loop.execute(
      'test_op',
      'test-input',
      () => null,
      async () => 'llm-result',
    );

    const failures = loop.getFailures('test_op');
    expect(failures.length).toBe(1);
    expect(failures[0].deterministic_result).toBeNull();
    expect(failures[0].llm_result).toContain('llm-result');
    expect(failures[0].input).toBe('test-input');
  });

  test('execute throws LLM error when both fail (cascade)', async () => {
    try {
      await loop.execute(
        'cascade_op',
        'input',
        () => null,
        async () => { throw new Error('LLM failed'); },
      );
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toBe('LLM failed');
    }

    // Verify both failures are logged
    const failures = loop.getFailures('cascade_op');
    expect(failures.length).toBe(1);
    expect(failures[0].llm_result).toContain('error: LLM failed');
    expect(failures[0].metadata?.cascade_failure).toBe(true);
  });

  test('logFailure creates JSONL file with valid entries', () => {
    loop.logFailure({
      timestamp: '2026-04-15T00:00:00Z',
      operation: 'jsonl_test',
      input: 'test input',
      deterministic_result: null,
      llm_result: 'llm output',
    });

    const filePath = join(tempDir, 'jsonl_test.jsonl');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.operation).toBe('jsonl_test');
  });

  test('getFailures returns empty array for non-existent operation', () => {
    const failures = loop.getFailures('nonexistent');
    expect(failures).toEqual([]);
  });

  test('getFailuresByPattern groups by input prefix', async () => {
    const prefix = 'a]'.repeat(30); // 60 chars, only first 50 used as key
    loop.logFailure({ timestamp: 't1', operation: 'group_test', input: prefix + ' suffix1', deterministic_result: null, llm_result: 'a' });
    loop.logFailure({ timestamp: 't2', operation: 'group_test', input: prefix + ' suffix2', deterministic_result: null, llm_result: 'b' });
    loop.logFailure({ timestamp: 't3', operation: 'group_test', input: 'different input entirely', deterministic_result: null, llm_result: 'c' });

    const patterns = loop.getFailuresByPattern('group_test');
    expect(patterns.size).toBe(2); // same 50-char prefix groups together, "different" is separate
  });

  test('analyzeFailures computes metrics', async () => {
    // Run some executions
    await loop.execute('metrics_op', 'a', () => 'det', async () => 'llm');
    await loop.execute('metrics_op', 'b', () => null, async () => 'llm');
    await loop.execute('metrics_op', 'c', () => 'det', async () => 'llm');

    const analysis = loop.analyzeFailures('metrics_op');
    expect(analysis.operation).toBe('metrics_op');
    expect(analysis.total_calls).toBe(3);
    expect(analysis.deterministic_hits).toBe(2);
    expect(analysis.deterministic_rate).toBeCloseTo(2 / 3, 2);
    expect(analysis.total_failures).toBe(1); // one LLM fallback logged
  });

  test('generateTestCases creates tests from successful LLM fallbacks', async () => {
    await loop.execute('testgen_op', 'input-1', () => null, async () => 'expected-1');
    await loop.execute('testgen_op', 'input-2', () => null, async () => 'expected-2');

    const cases = loop.generateTestCases('testgen_op');
    expect(cases.length).toBe(2);
    expect(cases[0].input).toBe('input-1');
    expect(cases[0].source).toBe('fail-improve-loop');
  });

  test('generateTestCases excludes cascade failures', async () => {
    await loop.execute('excl_op', 'ok', () => null, async () => 'good');
    try {
      await loop.execute('excl_op', 'bad', () => null, async () => { throw new Error('boom'); });
    } catch {}

    const cases = loop.generateTestCases('excl_op');
    expect(cases.length).toBe(1); // only the successful fallback
  });

  test('logImprovement records improvement history', () => {
    loop.logImprovement('improve_op', 'Added regex for MRR format');
    loop.logImprovement('improve_op', 'Added regex for ARR format');

    const analysis = loop.analyzeFailures('improve_op');
    expect(analysis.total_improvements).toBe(2);
  });

  test('input is truncated to 1000 chars in log entries', async () => {
    const longInput = 'x'.repeat(5000);
    await loop.execute('trunc_op', longInput, () => null, async () => 'result');

    const failures = loop.getFailures('trunc_op');
    expect(failures[0].input.length).toBe(1000);
  });

  // ---- AbortSignal threading (PR 2.5+ guarantees) ----

  test('aborts before deterministic call when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let detCalled = false;
    let llmCalled = false;
    await expect(loop.execute(
      'abort_early',
      'x',
      () => { detCalled = true; return 'det'; },
      async () => { llmCalled = true; return 'llm'; },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(detCalled).toBe(false);
    expect(llmCalled).toBe(false);
  });

  test('aborts between deterministic miss and LLM fallback', async () => {
    const controller = new AbortController();
    let llmCalled = false;
    await expect(loop.execute(
      'abort_between',
      'x',
      () => { controller.abort(); return null; },
      async () => { llmCalled = true; return 'llm'; },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(llmCalled).toBe(false);
  });

  test('forwards signal into deterministic + LLM callbacks', async () => {
    const controller = new AbortController();
    let seenDet: AbortSignal | undefined;
    let seenLlm: AbortSignal | undefined;
    await loop.execute(
      'fwd',
      'x',
      (_i, s) => { seenDet = s; return null; },
      async (_i, s) => { seenLlm = s; return 'ok'; },
      { signal: controller.signal },
    );
    expect(seenDet).toBe(controller.signal);
    expect(seenLlm).toBe(controller.signal);
  });

  test('LLM AbortError propagates without logging a failure entry', async () => {
    await expect(loop.execute(
      'abort_llm',
      'x',
      () => null,
      async () => {
        const err = new Error('user aborted');
        err.name = 'AbortError';
        throw err;
      },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(loop.getFailures('abort_llm')).toEqual([]);
  });

  test('log rotation keeps last 1000 entries', () => {
    // Write 1010 entries
    for (let i = 0; i < 1010; i++) {
      loop.logFailure({
        timestamp: `2026-04-15T00:00:${String(i).padStart(2, '0')}Z`,
        operation: 'rotation_test',
        input: `entry-${i}`,
        deterministic_result: null,
        llm_result: `result-${i}`,
      });
    }

    const failures = loop.getFailures('rotation_test');
    expect(failures.length).toBeLessThanOrEqual(1000);
    // Last entry should be preserved
    expect(failures[failures.length - 1].input).toBe('entry-1009');
  });
});

// ---------------------------------------------------------------------------
// Regression: path traversal via the operation parameter
//
// FailImproveLoop is exported with method signatures typed as `string` on
// the operation parameter. Every current in-tree caller passes a hard-coded
// identifier ("extract_mrr", "rotation_test"), but the class is new and the
// first consumer that forwards a request field — recipe name, webhook slug,
// user-typed label — turns operation into an arbitrary-write primitive:
// logFailure writes JSONL to `{logDir}/{operation}.jsonl` and logImprovement
// writes JSON to `{logDir}/{operation}/improvements.json`. Without an input
// check, `operation = '../../../../../tmp/owned'` escapes logDir entirely.
//
// The fix asserts operation matches a conservative charset (alnum + _ + -)
// and is ≤64 chars. These tests lock that in so a future "let's allow dots"
// loosening surfaces in review.
// ---------------------------------------------------------------------------

describe('fail-improve / operation name validation', () => {
  let tempDir: string;
  let loop: FailImproveLoop;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-fail-improve-pt-'));
    loop = new FailImproveLoop(tempDir);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const BAD: Array<{ label: string; op: string }> = [
    { label: 'parent-dir traversal', op: '../../../tmp/owned' },
    { label: 'single parent',        op: '../owned' },
    { label: 'absolute path',        op: '/tmp/owned' },
    { label: 'embedded slash',       op: 'a/b' },
    { label: 'backslash',            op: 'a\\b' },
    { label: 'null byte',            op: 'ok\u0000evil' },
    { label: 'leading dot',          op: '.hidden' },
    { label: 'empty string',         op: '' },
    { label: 'only dots',            op: '...' },
    { label: 'over length',          op: 'x'.repeat(65) },
    // Non-ASCII attacks: confirm Unicode support did not open a hole.
    { label: 'CJK with slash',       op: '田中/..' },
    { label: 'CJK traversal',        op: '../田中' },
    { label: 'arabic with null',     op: 'مَهَمَّة\u0000x' },
    { label: 'cyrillic leading dot', op: '.иван' },
    { label: 'emoji (not letter)',   op: '🚀_op' },
    { label: 'RTL override',         op: 'ok\u202eevil' },
    { label: 'whitespace',           op: 'has space' },
  ];

  for (const { label, op } of BAD) {
    test(`rejects ${label}: '${op.slice(0, 40)}'`, async () => {
      await expect(
        loop.execute(op, 'in', () => null, async () => 'res')
      ).rejects.toThrow(/invalid operation name/);
    });
  }

  test('path-traversal payload does not create files outside logDir', async () => {
    // Use a unique sentinel name so this test is robust against leftover
    // pollution from prior test runs (or prior vulnerable-code sessions).
    // If the operation check is missing, logFailure would normalize
    // `../{sentinel}` against tempDir and write a .jsonl outside it.
    const sentinel = `gbrain-escape-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const outsidePath = join(tempDir, '..', `${sentinel}.jsonl`);
    try {
      await expect(
        loop.execute('../' + sentinel, 'x', () => null, async () => 'y')
      ).rejects.toThrow(/invalid operation name/);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      try { rmSync(outsidePath, { force: true }); } catch {}
    }
  });

  const GOOD = [
    // ASCII identifiers already in use in-tree
    'extract_mrr', 'rotation_test', 'op-1', 'ABC_123', 'a', 'x'.repeat(64),
    // Non-ASCII scripts — callers that derive operation names from entity
    // pages, recipe titles, or user labels in other languages must keep
    // working. One test per script family, both mixed and pure.
    '田中-enrich',           // CJK + ascii punctuation
    'extract_タスク',         // katakana + underscore mix
    'иван_stats',            // cyrillic
    '抽出_mrr',              // CJK prefix
    'مَهَمَّة',              // arabic
    'mañana',                // latin-extended (ñ)
    '任務1',                 // CJK + digit
    'Δ_delta',               // greek
  ];
  for (const op of GOOD) {
    test(`accepts '${op.slice(0, 40)}'`, async () => {
      const result = await loop.execute(op, 'in', () => null, async () => 'ok');
      expect(result).toBe('ok');
      // File was written inside logDir, not outside
      const expected = join(tempDir, `${op}.jsonl`);
      expect(existsSync(expected)).toBe(true);
    });
  }

  test('logImprovement also validates the operation name', () => {
    expect(() => loop.logImprovement('../escape', 'test')).toThrow(/invalid operation name/);
  });
});
