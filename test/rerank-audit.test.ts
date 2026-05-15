/**
 * v0.33.2+ rerank-audit JSONL round-trip.
 *
 * Pins:
 *  - logRerankFailure → readRecentRerankFailures round-trip
 *  - error_summary truncated to 200 chars (privacy/size)
 *  - corrupt rows skipped (audit is informational, never breaks search)
 *  - ISO-week filename rotation
 *  - CDX2-F22: logRerankSuccess does NOT exist (success-events were dropped
 *    per adversarial review — hot-path I/O churn + privacy concerns)
 *
 * Uses `withEnv()` per the test-isolation lint rule R1: never mutate
 * process.env directly outside `*.serial.test.ts` (process.env is global
 * and leaks across files in the parallel runner's shard process).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import {
  logRerankFailure,
  readRecentRerankFailures,
  computeRerankAuditFilename,
} from '../src/core/rerank-audit.ts';

/**
 * Run a test body inside a fresh tmp audit dir scoped to that test. Cleans
 * up the dir after. `withEnv` handles env-restore via try/finally.
 */
async function withFreshAuditDir(body: (tmpDir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-audit-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('rerank-audit JSONL round-trip', () => {
  test('log → read returns the same event shape', async () => {
    await withFreshAuditDir(() => {
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'auth',
        query_hash: 'a1b2c3d4',
        doc_count: 30,
        error_summary: 'invalid api key',
      });
      const events = readRecentRerankFailures(7);
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        model: 'zeroentropyai:zerank-2',
        reason: 'auth',
        query_hash: 'a1b2c3d4',
        doc_count: 30,
        error_summary: 'invalid api key',
        severity: 'warn',
      });
      expect(typeof events[0]!.ts).toBe('string');
    });
  });

  test('error_summary truncated to ~200 chars', async () => {
    await withFreshAuditDir(() => {
      const longMsg = 'x'.repeat(500);
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'unknown',
        query_hash: 'deadbeef',
        doc_count: 0,
        error_summary: longMsg,
      });
      const events = readRecentRerankFailures(7);
      expect(events[0]!.error_summary.length).toBeLessThanOrEqual(200);
    });
  });

  test('multiple failures append to same JSONL file', async () => {
    await withFreshAuditDir(() => {
      for (let i = 0; i < 5; i++) {
        logRerankFailure({
          model: 'zeroentropyai:zerank-2',
          reason: 'network',
          query_hash: `hash${i}`,
          doc_count: 30,
          error_summary: `failure ${i}`,
        });
      }
      const events = readRecentRerankFailures(7);
      expect(events.length).toBe(5);
      expect(new Set(events.map(e => e.query_hash)).size).toBe(5);
    });
  });

  test('corrupt JSONL rows skipped silently', async () => {
    await withFreshAuditDir((tmpDir) => {
      const filename = computeRerankAuditFilename();
      const filepath = path.join(tmpDir, filename);
      // First write a valid row, then garbage, then another valid row.
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'timeout',
        query_hash: 'good1',
        doc_count: 30,
        error_summary: 'ok 1',
      });
      fs.appendFileSync(filepath, 'not valid json\n');
      fs.appendFileSync(filepath, '{"partial":\n');
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'timeout',
        query_hash: 'good2',
        doc_count: 30,
        error_summary: 'ok 2',
      });
      const events = readRecentRerankFailures(7);
      expect(events.length).toBe(2);
      expect(events.map(e => e.query_hash)).toEqual(['good1', 'good2']);
    });
  });

  test('missing audit dir → readRecentRerankFailures returns []', async () => {
    // Point at a never-existing path; readRecentRerankFailures should
    // skip the readFileSync error and return [].
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-empty-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: path.join(tmpRoot, 'nonexistent') }, async () => {
        const events = readRecentRerankFailures(7);
        expect(events).toEqual([]);
      });
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('CDX2-F22 — logRerankSuccess MUST NOT exist', () => {
  test('module does not export logRerankSuccess', async () => {
    const mod: any = await import('../src/core/rerank-audit.ts');
    expect(mod.logRerankSuccess).toBeUndefined();
  });
});

describe('ISO-week filename rotation', () => {
  test('filename format is rerank-failures-YYYY-Www.jsonl', () => {
    const filename = computeRerankAuditFilename(new Date('2026-05-14T00:00:00Z'));
    expect(filename).toMatch(/^rerank-failures-\d{4}-W\d{2}\.jsonl$/);
  });

  test('readRecentRerankFailures walks current + previous week', async () => {
    await withFreshAuditDir((tmpDir) => {
      // Write a row in the "current" week's file.
      logRerankFailure({
        model: 'zeroentropyai:zerank-2',
        reason: 'auth',
        query_hash: 'now',
        doc_count: 1,
        error_summary: 'recent',
      });
      // Synthesize a "last week" row to confirm both files are walked.
      const lastWeek = new Date(Date.now() - 7 * 86400000);
      const lastWeekName = computeRerankAuditFilename(lastWeek);
      const lastWeekPath = path.join(tmpDir, lastWeekName);
      fs.appendFileSync(
        lastWeekPath,
        JSON.stringify({
          ts: new Date(Date.now() - 3 * 86400000).toISOString(),
          model: 'zeroentropyai:zerank-2',
          reason: 'auth',
          query_hash: 'old',
          doc_count: 1,
          error_summary: 'older',
          severity: 'warn',
        }) + '\n',
      );
      const events = readRecentRerankFailures(7);
      expect(events.length).toBe(2);
      expect(new Set(events.map(e => e.query_hash))).toEqual(new Set(['now', 'old']));
    });
  });
});
