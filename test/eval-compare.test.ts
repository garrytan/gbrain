/**
 * v0.32.3 — eval-compare report tests.
 * Pins the markdown + JSON shape and the metric-glossary integration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalCompare } from '../src/commands/eval-compare.ts';

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
    expect(report._meta.methodology).toContain('bootstrap');
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
});
