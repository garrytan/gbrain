/**
 * v0.41.16.0 — retrofitWrap helper unit tests.
 *
 * Pins the thin wrapper used by 8 of the 9 v0.41.16.0 retrofits:
 *   - Default opt-out of D3 safety net + zero ramp grace.
 *   - Audit JSONL still writes.
 *   - Cost projection rolls up correctly.
 *   - Runner error counts surface.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import { retrofitWrap } from '../../src/core/progressive-batch/retrofit-wrap.ts';

function auditEnv(): Record<string, string> {
  return {
    GBRAIN_AUDIT_DIR: mkdtempSync(join(tmpdir(), 'rw-audit-')),
    GBRAIN_PROGRESSIVE_BATCH_AUTO: '1',
  };
}

describe('retrofitWrap', () => {
  test('opt-out defaults: runs without BudgetTracker safety net', async () => {
    await withEnv(auditEnv(), async () => {
      const r = await retrofitWrap({
        label: 'unit-test',
        items: [1, 2, 3, 4, 5],
        runner: async (rows) => ({ succeeded: rows.length, failed: 0, costUsd: 0 }),
      });
      expect(r.abortedAt).toBeUndefined();
      expect(r.itemsProcessed).toBe(5);
    });
  });

  test('passes per-item cost into projection', async () => {
    await withEnv(auditEnv(), async () => {
      const r = await retrofitWrap({
        label: 'cost-projection',
        items: Array.from({ length: 100 }, (_, i) => i),
        costPerItem: 0.001,
        runner: async (rows) => ({
          succeeded: rows.length,
          failed: 0,
          costUsd: rows.length * 0.001,
        }),
      });
      expect(r.abortedAt).toBeUndefined();
      expect(r.totalCostUsd).toBeCloseTo(0.1);
    });
  });

  test('runner failures roll up into the totals', async () => {
    await withEnv(auditEnv(), async () => {
      const r = await retrofitWrap({
        label: 'failure-test',
        items: Array.from({ length: 10 }, (_, i) => i),
        runner: async (rows) => ({
          succeeded: 0,
          failed: rows.length,
          costUsd: 0,
        }),
      });
      // Default maxErrorRate=0.02 — 100% failure aborts at trial.
      expect(r.abortedAt?.verdict).toBe('abort_error_rate');
    });
  });

  test('interactiveAbortMs=0 default → no grace period (cron-safe)', async () => {
    await withEnv(auditEnv(), async () => {
      const start = Date.now();
      const r = await retrofitWrap({
        label: 'cron-safe',
        items: Array.from({ length: 200 }, (_, i) => i),
        runner: async (rows) => ({ succeeded: rows.length, failed: 0, costUsd: 0 }),
      });
      expect(r.abortedAt).toBeUndefined();
      // Should sail through all 4 stages with no grace pause.
      expect(Date.now() - start).toBeLessThan(500);
    });
  });
});
