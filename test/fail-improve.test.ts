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
