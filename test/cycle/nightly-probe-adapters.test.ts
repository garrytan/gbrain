/**
 * Unit tests for `src/core/cycle/nightly-probe-adapters.ts`.
 *
 * The adapters bridge object-shape `NightlyProbeDeps` arguments to the
 * existing argv-array CLI functions. Tests pin:
 *   - argv shape passed to each underlying CLI function (codex round-2 #1)
 *   - receipt file parsing happy path
 *   - exit 1 + missing receipt → optional summary (reason remains ambiguous)
 *   - other missing receipt exits → throw with paste-ready hint
 *   - malformed receipt JSON → throws with the bad content prefix
 *   - exit-code passthrough
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCrossModalProbeArgv,
  readCrossModalProbeSummary,
  runCrossModalBatchForProbe,
} from '../../src/core/cycle/nightly-probe-adapters.ts';

describe('nightly-probe-adapters: cross-modal receipt parsing', () => {
  test('exit 1 without a receipt returns an optional summary without classifying the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    try {
      const summaryPath = join(dir, 'not-written-on-budget-refusal.json');
      const batchPath = join(dir, 'one-question.jsonl');
      writeFileSync(batchPath, JSON.stringify({
        question_id: 'q-1',
        question: 'What is the answer?',
        answer: 'forty-two',
        hypothesis: 'forty-two',
      }) + '\n');

      const result = await runCrossModalBatchForProbe({
        batchPath,
        summaryPath,
        maxUsd: 0,
        limit: 1,
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing summary on exit 2 still throws with a paste-ready hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    try {
      const summaryPath = join(dir, 'missing.json');
      expect(() => readCrossModalProbeSummary(summaryPath, 2))
        .toThrow(/finished \(exit 2\).*summary file is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed summary JSON throws with content prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    try {
      const summaryPath = join(dir, 'bad-summary.json');
      writeFileSync(summaryPath, '{not valid json');
      expect(() => readCrossModalProbeSummary(summaryPath, 1))
        .toThrow(/malformed JSON.*First 200 chars: \{not valid json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('valid summary is projected to the probe contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    try {
      const summaryPath = join(dir, 'summary.json');
      writeFileSync(summaryPath, JSON.stringify({
        schema_version: 1,
        total: 1,
        pass_count: 1,
        fail_count: 0,
        inconclusive_count: 0,
        error_count: 0,
        upstream_error_count: 0,
        malformed_count: 0,
        est_cost_usd: 0.2,
        verdict: 'pass',
        extra_field: 'ignored',
      }));
      expect(readCrossModalProbeSummary(summaryPath, 0)).toEqual({
        total: 1,
        pass_count: 1,
        fail_count: 0,
        inconclusive_count: 0,
        error_count: 0,
        upstream_error_count: 0,
        malformed_count: 0,
        est_cost_usd: 0.2,
        verdict: 'pass',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('nightly-probe-adapters: argv shape regression (codex round-2 #1)', () => {
  test('adapter argv shape includes --output explicitly (regression for codex finding)', () => {
    const argv = buildCrossModalProbeArgv({
      batchPath: '/tmp/questions.jsonl',
      summaryPath: '/tmp/summary.json',
      maxUsd: 0.2,
      limit: 25,
    });

    expect(argv).toContain('--output');
    expect(argv).toContain('/tmp/summary.json');
    expect(argv).toContain('--batch');
    expect(argv).toContain('--max-usd');
    expect(argv).toContain('0.2');
    expect(argv).toContain('--limit');
    expect(argv).toContain('25');
    expect(argv).not.toContain('--yes');
    expect(argv).toContain('--json');
  });

  test('runLongMemEvalForProbe builds argv with --output for output path', () => {
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    // longmemeval adapter: first positional arg is fixturePath, then --output outputPath.
    expect(source).toMatch(/runEvalLongMemEval\(\[args\.fixturePath, '--output', args\.outputPath\]\)/);
  });
});

describe('nightly-probe-adapters: contract regression', () => {
  test('returns the documented shape: {exitCode, summary?}', () => {
    // Static type-shape check via source inspection — if the return shape
    // ever drifts, this regression catches it.
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    expect(source).toMatch(/Promise<\{ exitCode: number; summary\?: CrossModalBatchSummary \}>/);
  });

  test('CrossModalBatchSummary shape includes denominator and outcome fields', () => {
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    expect(source).toContain('total');
    expect(source).toContain('pass_count');
    expect(source).toContain('fail_count');
    expect(source).toContain('inconclusive_count');
    expect(source).toContain('error_count');
    expect(source).toContain('upstream_error_count');
    expect(source).toContain('malformed_count');
    expect(source).toContain('est_cost_usd');
    expect(source).toContain('verdict');
  });
});
