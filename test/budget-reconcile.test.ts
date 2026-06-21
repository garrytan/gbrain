import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBudgetReconcileReport,
  parseBudgetReconcileArgs,
  runBudget,
} from '../src/commands/budget.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;
let oldStdoutWrite: typeof process.stdout.write;
let stdoutCapture: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-budget-reconcile-'));
  stdoutCapture = '';
  oldStdoutWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    stdoutCapture += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  (process.stdout as { write: unknown }).write = oldStdoutWrite;
  rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

describe('budget reconcile readback', () => {
  test('summarizes recent Anthropic budget ledger rows with cache tokens', async () => {
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        schema_version: 1,
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        label: 'dream.synthesize',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_creation_tokens: 10,
        actual_cost_usd: 0.25,
      },
      {
        schema_version: 1,
        ts: '2026-06-20T12:05:00.000Z',
        event: 'record',
        label: 'deepseek',
        kind: 'chat',
        model: 'deepseek:deepseek-v4-pro',
        actual_cost_usd: 0.99,
      },
      {
        schema_version: 1,
        ts: '2026-06-20T12:10:00.000Z',
        event: 'reserve',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        projected_cost_usd: 10,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const args = parseBudgetReconcileArgs(['--days', '7'], new Date('2026-06-21T00:00:00.000Z'));
      const report = buildBudgetReconcileReport(args);
      expect(report.internal.records).toBe(1);
      expect(report.internal.cost_usd).toBe(0.25);
      expect(report.internal.cache_read_tokens).toBe(20);
      expect(report.internal.cache_creation_tokens).toBe(10);
      expect(report.internal.by_model[0]).toEqual({
        model: 'anthropic:claude-sonnet-4-6',
        records: 1,
        cost_usd: 0.25,
      });
    });
  });

  test('compares internal ledger to a local external receipt export', async () => {
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'claude-haiku-4-5',
        actual_cost_usd: 0.25,
      },
    ]);
    const external = join(tmp, 'anthropic-export.jsonl');
    writeJsonl(external, [
      {
        timestamp: '2026-06-20T12:01:00.000Z',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        cost_usd: 0.245,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const args = parseBudgetReconcileArgs(
        ['--days', '7', '--external-receipts', external],
        new Date('2026-06-21T00:00:00.000Z'),
      );
      const report = buildBudgetReconcileReport(args);
      expect(report.external?.records).toBe(1);
      expect(report.comparison.delta_usd).toBeCloseTo(0.005, 8);
      expect(report.comparison.within_one_cent).toBe(true);
    });
  });

  test('runBudget writes an optional JSON receipt path', async () => {
    writeJsonl(join(tmp, 'budget.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 0.1,
      },
    ]);
    const out = join(tmp, 'receipt.json');
    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const rc = await runBudget(['reconcile', '--days', '30', '--json', '--out', out]);
      expect(rc).toBe(0);
      expect(existsSync(out)).toBe(true);
      const written = JSON.parse(readFileSync(out, 'utf-8'));
      const printed = JSON.parse(stdoutCapture);
      expect(written.internal.cost_usd).toBe(0.1);
      expect(printed.internal.cost_usd).toBe(0.1);
    });
  });
});
