import { expect, test } from 'bun:test';
import * as nightlyQuality from '../src/core/cycle/nightly-quality-probe.ts';
const now = new Date('2026-10-22T07:01:00Z');
const event = { ts: '2026-10-21T22:00:00Z', outcome: 'error' };
test('repair admits one incomplete attempt without erasing its original audit identity', () => {
  for (const outcome of ['error', 'budget_exceeded', 'inconclusive'])
    expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, outcome }])).toBe(event.ts);
});
test('completed pass and fail remain gated, including a completed older run', () => {
  for (const outcome of ['pass', 'fail']) {
    expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, outcome }])).toBeUndefined();
    expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, ts: '2026-10-21T21:00:00Z', outcome }, event])).toBeUndefined();
  }
});
test('second repair, unknown outcome, stale event and future timestamp cannot lift a gate', () => {
  expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, retry_of: 'original' }])).toBeUndefined();
  expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, outcome: 'skipped' }])).toBeUndefined();
  expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, ts: '2026-10-20T22:00:00Z' }])).toBeUndefined();
  expect(nightlyQuality.incompleteRetryTarget(now, [{ ...event, ts: '2026-10-23T22:00:00Z' }])).toBeUndefined();
});

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withEnv } from './helpers/with-env.ts';
import { runNightlyQualityProbe } from '../src/core/cycle/nightly-quality-probe.ts';
import { logQualityProbeEvent, readRecentQualityProbeEvents } from '../src/core/audit-quality-probe.ts';
test('actual repair keeps original audit, emits every question, and cannot be replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b336-repair-'));
  const fixture = join(dir, 'fixture.jsonl'); writeFileSync(fixture, '{}');
  const clock = new Date();
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const original = { ts: new Date(clock.getTime() - 60000).toISOString(), outcome: 'error' as const,
        exit_code: 1, pass_count: 0, fail_count: 0, inconclusive_count: 0, error_count: 1, est_cost_usd: 0 };
      logQualityProbeEvent(original);
      let calls = 0;
      const questions = [{ question_id: 'q-pass', verdict: 'pass' }, { question_id: 'q-fail', verdict: 'fail' }];
      const deps = { isEnabled: () => true, hasEmbeddingProvider: () => true, resolveMaxUsd: () => 5,
        resolveFixturePath: () => fixture, now: () => clock,
        runLongMemEval: async () => { calls++; },
        runCrossModalBatch: async () => ({ exitCode: 1, summary: {
          pass_count: 1, fail_count: 1, inconclusive_count: 0, error_count: 0, est_cost_usd: 0,
          verdict: 'fail', questions } }) };
      expect((await runNightlyQualityProbe(deps)).outcome).toBe('rate_limited');
      expect(calls).toBe(0);
      const result = await runNightlyQualityProbe({ ...deps, retryIncomplete: true });
      expect(result.outcome).toBe('fail'); expect(result.questions).toEqual(questions);
      const rows = readRecentQualityProbeEvents(2, clock);
      expect(rows.some(r => r.ts === original.ts && r.outcome === 'error')).toBe(true);
      expect(rows.find(r => r.retry_of === original.ts)?.questions).toEqual(questions);
      expect((await runNightlyQualityProbe({ ...deps, retryIncomplete: true })).outcome).toBe('rate_limited');
      expect(calls).toBe(1);
    });
  } finally {
    const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, 'b336-repair-test-' + randomUUID()));
  }
});

import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
test('the actual top-level eval flag registry admits the explicit repair flag', () => {
  expect(CLI_FLAG_REGISTRY.eval).toContain('--retry-incomplete');
});
