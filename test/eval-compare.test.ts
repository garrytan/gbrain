/**
 * v0.32.3 — eval-compare report tests.
 * Pins the markdown + JSON shape, the metric-glossary integration, and the
 * paired statistics computed from per-query rows (aggregate-only runs must
 * say so and compute nothing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathWithinRoot, runEvalCompare } from '../src/commands/eval-compare.ts';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-eval-compare-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_RECORDS = [
  {
    schema_version: 2,
    run_id: 'a-longmemeval-conservative-42',
    ran_at: '2026-05-12T10:00:00Z',
    suite: 'longmemeval',
    mode: 'conservative',
    commit: 'a',
    seed: 42,
    status: 'completed',
    duration_ms: 1000,
    metrics: { 'recall@10': 0.71, 'ndcg@10': 0.682 },
  },
  {
    schema_version: 2,
    run_id: 'a-longmemeval-balanced-42',
    ran_at: '2026-05-12T10:05:00Z',
    suite: 'longmemeval',
    mode: 'balanced',
    commit: 'a',
    seed: 42,
    status: 'completed',
    duration_ms: 1000,
    metrics: { 'recall@10': 0.78, 'ndcg@10': 0.741 },
  },
  {
    schema_version: 2,
    run_id: 'a-longmemeval-tokenmax-42',
    ran_at: '2026-05-12T10:10:00Z',
    suite: 'longmemeval',
    mode: 'tokenmax',
    commit: 'a',
    seed: 42,
    status: 'completed',
    duration_ms: 1000,
    metrics: { 'recall@10': 0.81, 'ndcg@10': 0.762 },
  },
];

function writeJsonl(records: object[]): string {
  const path = join(tmp, 'eval-results.jsonl');
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return path;
}

async function captureRun(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => { captured.push(s); return true; }) as never;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured.join('');
}

beforeEach(() => {
  rmSync(join(tmp, 'eval-results.jsonl'), { force: true });
});

describe('runEvalCompare', () => {
  test('--json output has schema_version + grouped + _meta.metric_glossary', async () => {
    const path = writeJsonl(SAMPLE_RECORDS);
    const out = await captureRun(() => runEvalCompare(['--json', '--input', path]));
    const report = JSON.parse(out);
    expect(report.schema_version).toBe(2);
    expect(report.grouped.longmemeval).toBeDefined();
    expect(report.grouped.longmemeval.conservative.metrics['recall@10']).toBe(0.71);
    expect(report.grouped.longmemeval.tokenmax.metrics['ndcg@10']).toBe(0.762);
    expect(report._meta.metric_glossary['recall@10']).toBeDefined();
    expect(report._meta.metric_glossary['ndcg@10']).toBeDefined();
    // No per-query rows: nothing statistical is computed, and it says so.
    expect(report.paired).toEqual([]);
    expect(report._meta.methodology).toStartWith('Aggregate-only');
    expect(report._meta.methodology).not.toContain('Bonferroni');
    expect(report.paired_unavailable.map((u: { run_id: string }) => u.run_id).sort()).toEqual(SAMPLE_RECORDS.map(r => r.run_id).sort());
  });

  test('--md output names every mode + metric', async () => {
    const path = writeJsonl(SAMPLE_RECORDS);
    const out = await captureRun(() => runEvalCompare(['--md', '--input', path]));
    expect(out).toContain('# Search Mode Comparison');
    expect(out).toContain('## longmemeval');
    expect(out).toContain('conservative');
    expect(out).toContain('balanced');
    expect(out).toContain('tokenmax');
    expect(out).toContain('### recall@10');
    expect(out).toContain('### ndcg@10');
    expect(out).toContain('Plain English:'); // Glossary line surfaced
  });

  test('missing file → friendly hint, no crash', async () => {
    const path = join(tmp, 'does-not-exist.jsonl');
    const out = await captureRun(() => runEvalCompare(['--md', '--input', path]));
    expect(out).toContain('No eval-results.jsonl found');
    expect(out).toContain('gbrain eval run-all');
  });

  test('--modes filter narrows the table', async () => {
    const path = writeJsonl(SAMPLE_RECORDS);
    const out = await captureRun(() => runEvalCompare(['--json', '--modes', 'conservative,tokenmax', '--input', path]));
    const report = JSON.parse(out);
    // Records list is filtered.
    expect(report.records.length).toBe(2);
    // The grouped table preserves the SEARCH_MODES order (conservative/balanced/tokenmax).
    // Filtered balanced → null in grouped output.
    expect(report.grouped.longmemeval.balanced).toBeNull();
  });

  test('multiple runs for same (suite, mode) → most-recent wins', async () => {
    const oldRun = { ...SAMPLE_RECORDS[0], ran_at: '2026-05-12T09:00:00Z', metrics: { 'recall@10': 0.5 } };
    const newRun = { ...SAMPLE_RECORDS[0], ran_at: '2026-05-12T11:00:00Z', metrics: { 'recall@10': 0.9 } };
    const path = writeJsonl([oldRun, newRun]);
    const out = await captureRun(() => runEvalCompare(['--json', '--input', path]));
    const report = JSON.parse(out);
    expect(report.grouped.longmemeval.conservative.metrics['recall@10']).toBe(0.9);
  });

  test('--md output labels an aggregate-only report', async () => {
    const path = writeJsonl(SAMPLE_RECORDS);
    const out = await captureRun(() => runEvalCompare(['--md', '--input', path]));
    expect(out).toContain('## Paired comparisons');
    expect(out).toContain('Aggregate-only: no per-query rows');
    expect(out).not.toContain('| Suite | Baseline');
  });
});

// Per-query fixtures: 40 questions. The candidate fixes 12 baseline misses
// and breaks 2 baseline hits on recall_all; recall_any is identical.
function perQueryFile(name: string, hits: (i: number) => boolean): string {
  const path = join(tmp, name);
  const rows = Array.from({ length: 40 }, (_, i) => ({
    question_id: `q${String(i).padStart(2, '0')}`,
    recall_all_hit: hits(i),
    recall_any_hit: true,
  }));
  writeFileSync(path, [...rows.map(r => JSON.stringify(r)), JSON.stringify({ kind: 'by_type_summary' })].join('\n') + '\n', 'utf-8');
  return path;
}

describe('runEvalCompare — paired statistics from per-query rows', () => {
  // Per-query files must live under the repository root; outside a git
  // checkout the root is the working directory, so run from the tmp dir.
  let cwd: string;
  beforeAll(() => { cwd = process.cwd(); process.chdir(tmp); });
  afterAll(() => { process.chdir(cwd); });

  const baseHit = (i: number) => i < 20;                         // 20/40
  const candHit = (i: number) => (i < 20 && i !== 0 && i !== 1) || (i >= 20 && i < 32); // 18 kept + 12 fixed = 30/40
  const records = () => [
    { ...SAMPLE_RECORDS[0], run_id: 'base-run', mode: 'balanced', params: { output: perQueryFile('base.jsonl', baseHit) } },
    { ...SAMPLE_RECORDS[1], run_id: 'cand-run', mode: 'balanced', ran_at: '2026-05-13T10:00:00Z', params: { output: perQueryFile('cand.jsonl', candHit) } },
  ];

  test('--baseline/--candidate computes a paired bootstrap over the joined questions', async () => {
    const path = writeJsonl(records());
    const out = await captureRun(() => runEvalCompare(['--json', '--input', path, '--baseline', 'base-run', '--candidate', 'cand-run']));
    const report = JSON.parse(out);
    const all = report.paired.find((c: { metric: string }) => c.metric === 'recall_all@k');
    expect(all).toMatchObject({ n: 40, clusters: 40, wins: 12, losses: 2, ties: 26, baseline_mean: 0.5, candidate_mean: 0.75 });
    expect(all.delta).toBeCloseTo(0.25, 10);
    expect(all.ci95[0]).toBeGreaterThan(0);
    expect(all.ci95[1]).toBeLessThan(0.5);
    // Sign-flip over questions is the sign test on the 14 discordant pairs:
    // exact two-sided p = 2 * (1 + 14 + 91) / 2^14 = 0.01294 (Monte Carlo here).
    expect(all.p_value).toBeGreaterThan(0.008);
    expect(all.p_value).toBeLessThan(0.02);
    const any = report.paired.find((c: { metric: string }) => c.metric === 'recall_any@k');
    expect(any).toMatchObject({ delta: 0, p_value: 1, ci95: [0, 0], significant: false });
    // Holm across the two-comparison family.
    expect(all.holm_p_value).toBeCloseTo(Math.min(1, all.p_value * 2), 10);
    expect(all.significant).toBe(true);
    expect(report._meta.methodology).toContain('Paired cluster bootstrap');
    expect(report._meta.methodology).toContain('Holm correction across the 2 comparison(s)');
  });

  test('deterministic: the same seed reproduces the same numbers; the seed is honored', async () => {
    const path = writeJsonl(records());
    const args = ['--json', '--input', path, '--baseline', 'base-run', '--candidate', 'cand-run'];
    const a = JSON.parse(await captureRun(() => runEvalCompare(args))).paired;
    const b = JSON.parse(await captureRun(() => runEvalCompare(args))).paired;
    const c = JSON.parse(await captureRun(() => runEvalCompare([...args, '--seed', '7']))).paired;
    expect(a).toEqual(b);
    expect(c[0].ci95).not.toEqual(a[0].ci95);
  });

  test('mode pairs compare automatically; --md renders the table with a verdict', async () => {
    const path = writeJsonl([
      { ...records()[0], mode: 'conservative' },
      { ...records()[1], mode: 'tokenmax' },
    ]);
    const out = await captureRun(() => runEvalCompare(['--md', '--input', path]));
    expect(out).toContain('| longmemeval | `base-run` (conservative) → `cand-run` (tokenmax) | recall_all@k | 40 (40) |');
    expect(out).toContain('| significant |');
    expect(out).toContain('| not significant |');
  });

  test('a run whose per-query file is missing is listed, not silently skipped', async () => {
    const path = writeJsonl([records()[0], { ...records()[1], params: { output: join(tmp, 'gone.jsonl') } }]);
    const report = JSON.parse(await captureRun(() => runEvalCompare(['--json', '--input', path, '--baseline', 'base-run', '--candidate', 'cand-run'])));
    expect(report.paired).toEqual([]);
    expect(report.paired_unavailable).toEqual([{ run_id: 'cand-run', reason: expect.stringContaining('not found') }]);
    expect(report._meta.methodology).toStartWith('Aggregate-only');
  });
});

describe('per-query paths stay inside the repository root', () => {
  test('pathWithinRoot refuses .., outside absolute paths and escaping symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-eval-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-eval-outside-'));
    try {
      mkdirSync(join(root, 'runs'));
      writeFileSync(join(root, 'runs', 'a.jsonl'), '{}\n');
      writeFileSync(join(outside, 'secret.jsonl'), '{}\n');
      symlinkSync(join(outside, 'secret.jsonl'), join(root, 'runs', 'link.jsonl'));
      expect(pathWithinRoot(root, 'runs/a.jsonl')).toEndWith(join('runs', 'a.jsonl'));
      expect(pathWithinRoot(root, join(root, 'runs', 'a.jsonl'))).toEndWith(join('runs', 'a.jsonl'));
      expect(pathWithinRoot(root, 'runs/../runs/missing.jsonl')).toEndWith(join('runs', 'missing.jsonl'));
      expect(pathWithinRoot(root, '../outside.jsonl')).toBeNull();
      expect(pathWithinRoot(root, 'runs/../../x.jsonl')).toBeNull();
      expect(pathWithinRoot(root, join(outside, 'secret.jsonl'))).toBeNull();
      expect(pathWithinRoot(root, 'runs/link.jsonl')).toBeNull();
      expect(pathWithinRoot(root, '.')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a ledger record pointing outside the root is refused with a clear reason and never read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-eval-outside-'));
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const escaping = join(outside, 'rows.jsonl');
      writeFileSync(escaping, JSON.stringify({ question_id: 'q1', recall_all_hit: true }) + '\n');
      const path = writeJsonl([
        { ...SAMPLE_RECORDS[0], run_id: 'b', params: { output: escaping } },
        { ...SAMPLE_RECORDS[1], run_id: 'c', params: { output: '../../etc/passwd' } },
      ]);
      const report = JSON.parse(await captureRun(() => runEvalCompare(['--json', '--input', path, '--baseline', 'b', '--candidate', 'c'])));
      expect(report.paired).toEqual([]);
      expect(report.paired_unavailable).toEqual([
        { run_id: 'b', reason: expect.stringContaining('refused per-query file outside the repository root') },
        { run_id: 'c', reason: expect.stringContaining('refused per-query file outside the repository root') },
      ]);
    } finally {
      process.chdir(cwd);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

