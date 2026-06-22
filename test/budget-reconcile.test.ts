import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBudgetReconcileReport,
  parseBudgetReconcileArgs,
  runBudget,
} from '../src/commands/budget.ts';
import { budgetAuditRowFingerprint } from '../src/core/budget/monthly-cap.ts';
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
      expect(report.comparison.gate_passed).toBe(null);
    });
  });

  test('separates provider candidates from estimates, fallback rows, and test rows', async () => {
    const legacyFixtureRow = {
      ts: '2026-06-20T12:02:00.000Z',
      event: 'record',
      label: 'cycle.propose_takes',
      kind: 'chat',
      model: 'anthropic:claude-sonnet-4-6',
      sub_label: 'gateway.chat',
      input_tokens: 2_000_000,
      output_tokens: 0,
      actual_cost_usd: 6,
    };
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        label: 'gateway.unscoped',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.25,
      },
      {
        ts: '2026-06-20T12:01:00.000Z',
        event: 'reserve',
        label: 'gateway.unscoped',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        projected_cost_usd: 0.5,
      },
      legacyFixtureRow,
      {
        ts: '2026-06-20T12:03:00.000Z',
        event: 'record',
        label: 'outer-test',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 10_000,
        output_tokens: 1_000,
        actual_cost_usd: 0.045,
      },
      {
        ts: '2026-06-20T12:04:00.000Z',
        event: 'record',
        label: 'some.phase',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        sub_label: 'gateway.chat.failed.fallback',
        input_tokens: 2_000,
        output_tokens: 0,
        actual_cost_usd: 0.006,
      },
    ]);
    writeJsonl(join(tmp, 'budget-quarantine.jsonl'), [
      {
        fingerprint: budgetAuditRowFingerprint(legacyFixtureRow),
        reason: 'legacy_local_test_fixture',
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const args = parseBudgetReconcileArgs(['--days', '7'], new Date('2026-06-21T00:00:00.000Z'));
      const report = buildBudgetReconcileReport(args);
      expect(report.internal.records).toBe(1);
      expect(report.internal.cost_usd).toBe(0.25);
      expect(report.non_billed_internal.estimates.records).toBe(1);
      expect(report.non_billed_internal.estimates.projected_cost_usd).toBe(0.5);
      expect(report.non_billed_internal.fallback_error.records).toBe(1);
      expect(report.non_billed_internal.fallback_error.cost_usd).toBe(0.006);
      expect(report.non_billed_internal.test_simulated.records).toBe(2);
      expect(report.non_billed_internal.test_simulated.cost_usd).toBeCloseTo(6.045, 8);
      expect(report.excluded_internal.records).toBe(4);
      expect(report.excluded_internal.cost_usd).toBeCloseTo(6.051, 8);
      expect(report.excluded_internal.projected_cost_usd).toBe(0.5);
      expect(report.excluded_internal.by_kind.map((r) => r.kind)).toEqual([
        'test_or_simulated',
        'estimate_or_reservation',
        'fallback_or_error',
      ]);
    });
  });

  test('counts failed rows with provider-reported usage as billed candidates', async () => {
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        label: 'gateway.unscoped',
        sub_label: 'gateway.chat.failed.provider_usage',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.25,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const args = parseBudgetReconcileArgs(['--days', '7'], new Date('2026-06-21T00:00:00.000Z'));
      const report = buildBudgetReconcileReport(args);
      expect(report.internal.records).toBe(1);
      expect(report.internal.cost_usd).toBe(0.25);
      expect(report.excluded_internal.records).toBe(0);
    });
  });

  test('fails the proof gate when delta exceeds the requested max', async () => {
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 0.25,
      },
    ]);
    const external = join(tmp, 'anthropic-export.jsonl');
    writeJsonl(external, [
      {
        timestamp: '2026-06-20T12:01:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cost_usd: 0.1,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const rc = await runBudget([
        'reconcile',
        '--days', '7',
        '--external-receipts', external,
        '--max-delta-usd', '0.05',
      ]);
      expect(rc).toBe(1);
      expect(stdoutCapture).toContain('Gate: FAIL');
      expect(stdoutCapture).toContain('max delta $0.0500');
    });
  });

  test('passes the proof gate when delta stays within the requested max', async () => {
    writeJsonl(join(tmp, 'budget-2026-W25.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 0.25,
      },
    ]);
    const external = join(tmp, 'anthropic-export.jsonl');
    writeJsonl(external, [
      {
        timestamp: '2026-06-20T12:01:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cost_usd: 0.245,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const rc = await runBudget([
        'reconcile',
        '--days', '7',
        '--external-receipts', external,
        '--max-delta-usd', '0.01',
      ]);
      expect(rc).toBe(0);
      expect(stdoutCapture).toContain('Gate: PASS');
    });
  });

  test('rejects a max delta gate without external receipts', () => {
    expect(() => parseBudgetReconcileArgs(['--days', '7', '--max-delta-usd', '0.01'])).toThrow(
      '--max-delta-usd requires --external-receipts',
    );
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

  test('json output carries the gate fields', async () => {
    writeJsonl(join(tmp, 'budget.jsonl'), [
      {
        ts: '2026-06-20T12:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 0.1,
      },
    ]);
    const external = join(tmp, 'anthropic-export.jsonl');
    writeJsonl(external, [
      {
        timestamp: '2026-06-20T12:01:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cost_usd: 0.095,
      },
    ]);

    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      const rc = await runBudget([
        'reconcile',
        '--days', '30',
        '--json',
        '--external-receipts', external,
        '--max-delta-usd', '0.01',
      ]);
      expect(rc).toBe(0);
      const printed = JSON.parse(stdoutCapture);
      expect(printed.comparison.max_delta_usd).toBe(0.01);
      expect(printed.comparison.gate_passed).toBe(true);
    });
  });
});
