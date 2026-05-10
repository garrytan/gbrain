/**
 * takes-quality-eval/replay — disk-only loader + DB-fallback path.
 * Codex review #10 brain-routing: replay does NOT silently hit the DB
 * when the disk file is missing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadReceiptFromDisk, loadReceiptFromDb } from '../src/core/takes-quality-eval/replay.ts';
import { writeReceiptToDb } from '../src/core/takes-quality-eval/receipt-write.ts';
import type { TakesQualityReceipt } from '../src/core/takes-quality-eval/receipt.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-test-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureReceipt(corpus = 'replay01'): TakesQualityReceipt {
  return {
    schema_version: 1,
    ts: '2026-05-09T22:00:00Z',
    rubric_version: 'v1.0',
    rubric_sha8: 'rrrr0001',
    corpus: { source: 'db', n_takes: 5, slug_prefix: null, corpus_sha8: corpus },
    prompt_sha8: 'pppp0001',
    models_sha8: 'mmmm0001',
    models: ['openai:gpt-4o'],
    cycles_run: 1,
    successes_per_cycle: [1],
    verdict: 'pass',
    scores: {
      accuracy: { mean: 8, min: 8, max: 8, scores: [8], per_model: {} },
    },
    overall_score: 8,
    cost_usd: 0.42,
  };
}

describe('loadReceiptFromDisk', () => {
  test('reads + validates a receipt file', () => {
    const path = join(tmpDir, 'r1.json');
    const r = fixtureReceipt('disk0001');
    writeFileSync(path, JSON.stringify(r));
    const loaded = loadReceiptFromDisk(path);
    expect(loaded.corpus.corpus_sha8).toBe('disk0001');
    expect(loaded.verdict).toBe('pass');
  });

  test('throws on missing file with actionable message', () => {
    expect(() => loadReceiptFromDisk(join(tmpDir, 'does-not-exist.json'))).toThrow(/not found/i);
  });

  test('Codex review #10: missing-file error mentions the DB-fallback option but does NOT silently hit DB', () => {
    try {
      loadReceiptFromDisk(join(tmpDir, 'gone.json'));
      throw new Error('expected throw');
    } catch (e) {
      // The error message should educate about DB fallback (so users know
      // they have an option) without auto-applying it.
      expect((e as Error).message).toContain('--from-db');
    }
  });

  test('throws on non-JSON file', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json {');
    expect(() => loadReceiptFromDisk(path)).toThrow(/not valid JSON/);
  });

  test('throws on unsupported schema_version', () => {
    const path = join(tmpDir, 'future.json');
    writeFileSync(path, JSON.stringify({ schema_version: 99 }));
    expect(() => loadReceiptFromDisk(path)).toThrow(/schema_version=99/);
  });
});

describe('loadReceiptFromDb — explicit fallback (NOT a silent path)', () => {
  test('reconstructs receipt from receipt_json column', async () => {
    const r = fixtureReceipt('db0001');
    await writeReceiptToDb(engine, r);
    const loaded = await loadReceiptFromDb(engine, {
      corpus_sha8: 'db0001',
      prompt_sha8: 'pppp0001',
      models_sha8: 'mmmm0001',
      rubric_sha8: 'rrrr0001',
    });
    expect(loaded.corpus.corpus_sha8).toBe('db0001');
    expect(loaded.verdict).toBe('pass');
  });

  test('throws when no row matches the 4-sha identity', async () => {
    await expect(
      loadReceiptFromDb(engine, {
        corpus_sha8: 'noexist1',
        prompt_sha8: 'noexist2',
        models_sha8: 'noexist3',
        rubric_sha8: 'noexist4',
      }),
    ).rejects.toThrow(/No DB row matching/);
  });
});
