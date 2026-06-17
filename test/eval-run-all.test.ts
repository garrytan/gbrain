/**
 * v0.32.3 — eval-run-all orchestrator unit tests.
 * Pins arg parsing + cost-guard semantics + persist hook + audit trail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseRunAllArgs,
  estimateRunCost,
  evaluateCostGuard,
  persistRunRecord,
  type EvalRunRecord,
} from '../src/commands/eval-run-all.ts';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-eval-runall-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseRunAllArgs', () => {
  test('defaults: all modes, longmemeval+replay suites, seed=42', () => {
    const opts = parseRunAllArgs([]);
    expect(opts.modes).toEqual(['conservative', 'balanced', 'tokenmax']);
    expect(opts.suites).toEqual(['longmemeval', 'replay']);
    expect(opts.seed).toBe(42);
    expect(opts.parallel).toBe(1);
    expect(opts.budgetUsdRetrieval).toBe(5);
    expect(opts.budgetUsdAnswer).toBe(20);
    expect(opts.yes).toBe(false);
  });

  test('--modes filters to a subset', () => {
    const opts = parseRunAllArgs(['--modes', 'conservative,tokenmax']);
    expect(opts.modes).toEqual(['conservative', 'tokenmax']);
  });

  test('--modes rejects invalid mode', () => {
    expect(() => parseRunAllArgs(['--modes', 'frontier'])).toThrow(/not a valid mode/);
  });

  test('--suites filters; rejects unknown', () => {
    const opts = parseRunAllArgs(['--suites', 'longmemeval']);
    expect(opts.suites).toEqual(['longmemeval']);
    expect(() => parseRunAllArgs(['--suites', 'foo'])).toThrow(/not a recognized suite/);
  });

  test('--budget-usd-retrieval + --budget-usd-answer override defaults', () => {
    const opts = parseRunAllArgs(['--budget-usd-retrieval', '15', '--budget-usd-answer', '50']);
    expect(opts.budgetUsdRetrieval).toBe(15);
    expect(opts.budgetUsdAnswer).toBe(50);
  });

  test('--parallel clamps to mode count', () => {
    const opts = parseRunAllArgs(['--parallel', '10']);
    expect(opts.parallel).toBe(3); // clamped to SEARCH_MODES.length
  });

  test('--parallel rejects 0 / negative', () => {
    expect(() => parseRunAllArgs(['--parallel', '0'])).toThrow(/must be >= 1/);
    expect(() => parseRunAllArgs(['--parallel', '-1'])).toThrow(/must be >= 1/);
  });

  test('--yes flag toggles', () => {
    expect(parseRunAllArgs(['--yes']).yes).toBe(true);
    expect(parseRunAllArgs(['-y']).yes).toBe(true);
  });
});

describe('estimateRunCost', () => {
  test('returns retrieval/answer/total breakdown', () => {
    const est = estimateRunCost({ suites: ['longmemeval'], modes: ['balanced'], limit: 100 });
    expect(est.total_usd).toBe(est.retrieval_usd + est.answer_usd);
    expect(est.answer_usd).toBeGreaterThan(0); // longmemeval has answer-gen
    expect(est.retrieval_usd).toBeGreaterThan(0);
  });

  test('tokenmax incurs expansion cost (Haiku per query)', () => {
    const bal = estimateRunCost({ suites: ['replay'], modes: ['balanced'], limit: 100 });
    const tok = estimateRunCost({ suites: ['replay'], modes: ['tokenmax'], limit: 100 });
    expect(tok.retrieval_usd).toBeGreaterThan(bal.retrieval_usd);
  });

  test('replay suite has zero answer cost', () => {
    const est = estimateRunCost({ suites: ['replay'], modes: ['balanced'], limit: 100 });
    expect(est.answer_usd).toBe(0);
  });

  test('multi-suite multi-mode estimate sums correctly', () => {
    const est = estimateRunCost({ suites: ['longmemeval', 'replay'], modes: ['conservative', 'balanced'], limit: 100 });
    expect(Object.keys(est.per_suite).length).toBe(4); // 2 × 2
  });
});

describe('evaluateCostGuard', () => {
  test('within-budget proceeds without --yes', () => {
    const g = evaluateCostGuard(
      { retrieval_usd: 1, answer_usd: 10, total_usd: 11 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: false, isTty: true },
    );
    expect(g.proceed).toBe(true);
  });

  test('over-cap TTY without --yes refuses', () => {
    const g = evaluateCostGuard(
      { retrieval_usd: 30, answer_usd: 30, total_usd: 60 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: false, isTty: true },
    );
    expect(g.proceed).toBe(false);
    expect(g.reason).toContain('--yes');
  });

  test('over-cap TTY with --yes proceeds', () => {
    const g = evaluateCostGuard(
      { retrieval_usd: 30, answer_usd: 30, total_usd: 60 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: true, isTty: true },
    );
    expect(g.proceed).toBe(true);
  });

  test('over-cap non-TTY without --yes refuses (exit 2 path)', () => {
    const g = evaluateCostGuard(
      { retrieval_usd: 30, answer_usd: 30, total_usd: 60 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: false, isTty: false },
    );
    expect(g.proceed).toBe(false);
    expect(g.reason).toContain('Non-TTY requires --yes');
  });

  test('only-retrieval-over OR only-answer-over both trigger guard', () => {
    const a = evaluateCostGuard(
      { retrieval_usd: 100, answer_usd: 1, total_usd: 101 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: false, isTty: false },
    );
    expect(a.proceed).toBe(false);
    const b = evaluateCostGuard(
      { retrieval_usd: 1, answer_usd: 100, total_usd: 101 },
      { budgetUsdRetrieval: 5, budgetUsdAnswer: 20, yes: false, isTty: false },
    );
    expect(b.proceed).toBe(false);
  });
});

describe('persistRunRecord audit trail', () => {
  beforeEach(() => {
    rmSync(join(tmp, '.gbrain-evals'), { recursive: true, force: true });
    rmSync(join(tmp, 'eval-results.jsonl'), { force: true });
  });

  test('appends to eval-results.jsonl, creates dir if missing', () => {
    const record: EvalRunRecord = {
      schema_version: 2,
      run_id: 'abc123-longmemeval-conservative-42',
      ran_at: '2026-05-12T12:00:00Z',
      suite: 'longmemeval',
      mode: 'conservative',
      commit: 'abc123',
      seed: 42,
      params: {},
      status: 'completed',
      duration_ms: 12_345,
    };
    persistRunRecord(tmp, record, tmp);
    const path = join(tmp, 'eval-results.jsonl');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('abc123-longmemeval-conservative-42');
    const parsed = JSON.parse(content.trim());
    expect(parsed.mode).toBe('conservative');
    expect(parsed.schema_version).toBe(2);
  });

  test('appends multiple records (NDJSON)', () => {
    const base = {
      schema_version: 2 as const,
      ran_at: '2026-05-12T12:00:00Z',
      suite: 'longmemeval' as const,
      commit: 'abc',
      seed: 42,
      params: {},
      status: 'completed' as const,
      duration_ms: 1,
    };
    persistRunRecord(tmp, { ...base, run_id: 'a', mode: 'conservative' }, tmp);
    persistRunRecord(tmp, { ...base, run_id: 'b', mode: 'balanced' }, tmp);
    persistRunRecord(tmp, { ...base, run_id: 'c', mode: 'tokenmax' }, tmp);
    const content = readFileSync(join(tmp, 'eval-results.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);
  });
});
