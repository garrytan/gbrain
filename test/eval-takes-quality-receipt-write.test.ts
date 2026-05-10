/**
 * takes-quality-eval/receipt-write — DB-authoritative + best-effort disk
 * (codex review #6).
 *
 * Tests the two-phase write: DB INSERT must succeed (authoritative), disk
 * artifact may fail (best-effort, logs but doesn't fail run). Idempotency
 * via the 4-sha unique key (re-running the same eval is INSERT...ON
 * CONFLICT DO NOTHING).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeReceiptToDb, writeReceiptArtifact, writeReceipt } from '../src/core/takes-quality-eval/receipt-write.ts';
import type { TakesQualityReceipt } from '../src/core/takes-quality-eval/receipt.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let originalGbrainHome: string | undefined;

beforeAll(async () => {
  // Steer ~/.gbrain/eval-receipts to a tempdir so the disk-artifact test
  // doesn't pollute the developer's real brain.
  originalGbrainHome = process.env.GBRAIN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-receipt-test-'));
  process.env.GBRAIN_HOME = tmpHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
});

function makeReceipt(corpus = 'aaaa1111'): TakesQualityReceipt {
  return {
    schema_version: 1,
    ts: new Date().toISOString(),
    rubric_version: 'v1.0',
    rubric_sha8: 'rrrr1111',
    corpus: { source: 'db', n_takes: 10, slug_prefix: null, corpus_sha8: corpus },
    prompt_sha8: 'pppp1111',
    models_sha8: 'mmmm1111',
    models: ['openai:gpt-4o'],
    cycles_run: 1,
    successes_per_cycle: [1],
    verdict: 'pass',
    scores: {
      accuracy: { mean: 8, min: 8, max: 8, scores: [8], per_model: { 'openai:gpt-4o': 8 } },
    },
    overall_score: 8,
    cost_usd: 0.5,
    improvements: [],
    errors: [],
    verdictMessage: 'PASS test',
  };
}

describe('writeReceiptToDb — DB-authoritative path (codex review #6)', () => {
  test('inserts a row into eval_takes_quality_runs with full receipt_json', async () => {
    const r = makeReceipt('test0001');
    await writeReceiptToDb(engine, r);
    const rows = await engine.executeRaw<{ verdict: string; receipt_json: any; rubric_version: string }>(
      `SELECT verdict, receipt_json, rubric_version FROM eval_takes_quality_runs
         WHERE receipt_sha8_corpus = $1`,
      ['test0001'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('pass');
    expect(rows[0].rubric_version).toBe('v1.0');
    const json = typeof rows[0].receipt_json === 'string' ? JSON.parse(rows[0].receipt_json) : rows[0].receipt_json;
    expect(json.schema_version).toBe(1);
    expect(json.corpus.corpus_sha8).toBe('test0001');
  });

  test('idempotent: re-running with the same 4-sha key is ON CONFLICT DO NOTHING', async () => {
    const r = makeReceipt('test0002');
    await writeReceiptToDb(engine, r);
    await writeReceiptToDb(engine, r);
    const rows = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM eval_takes_quality_runs
         WHERE receipt_sha8_corpus = $1`,
      ['test0002'],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  test('different rubric_sha8 → distinct row (codex #3 — segregates rubric epochs)', async () => {
    const r1 = makeReceipt('test0003');
    const r2 = { ...makeReceipt('test0003'), rubric_sha8: 'differnt' };
    await writeReceiptToDb(engine, r1);
    await writeReceiptToDb(engine, r2);
    const rows = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM eval_takes_quality_runs
         WHERE receipt_sha8_corpus = $1`,
      ['test0003'],
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('writeReceiptArtifact — best-effort disk path (codex review #6)', () => {
  test('writes file to ~/.gbrain/eval-receipts/<filename>', () => {
    const r = makeReceipt('artif001');
    const path = writeReceiptArtifact(r);
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    expect(path).toContain('eval-receipts');
    expect(path).toContain('takes-quality-artif001-pppp1111-mmmm1111-rrrr1111.json');
  });
});

describe('writeReceipt — combined (DB authoritative, disk best-effort)', () => {
  test('returns {db: true, disk_path}', async () => {
    const r = makeReceipt('combined1');
    const result = await writeReceipt(engine, r);
    expect(result.db).toBe(true);
    expect(result.disk_path).toBeDefined();
    expect(existsSync(result.disk_path!)).toBe(true);
  });
});
