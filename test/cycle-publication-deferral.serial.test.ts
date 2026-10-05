import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';

// Only the paid child and maintenance boundary are replaced. Phase selection,
// evidence, jobs, watermark and drift report construction use the real engine.
let publishError: unknown;
let stampCalls = 0;
let publishCalls = 0;
let verified = 0;
let childStatus = 'completed';
const maintenance = { writer: { sourceId: 'default' } };
mock.module('../src/core/ai/gateway.ts', () => ({ probeChatModel: () => ({ ok: true }) }));
mock.module('../src/core/cycle/synthesize-concepts.ts', () => ({ resolveSynthMaxOutputTokens: () => 4096 }));
mock.module('../src/core/persistence/prepared-maintenance.ts', () => ({
  maintenancePreflight: async () => maintenance,
  stampMaintenancePage: async () => { stampCalls++; if (publishError) throw publishError; },
  publishMaintenancePage: async () => { publishCalls++; if (publishError) throw publishError; return {}; },
  verifyMaintenanceOutputs: async () => { verified++; return 1; },
}));
mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
}));
mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletionRenewing: async (_queue: unknown, jobId: number, opts?: { renew?: () => Promise<void> }) => {
    await opts?.renew?.();
    await engine.executeRaw(`INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, output, status)
      VALUES ($1, 0, 'fixture-tool', 'brain_put_page', '{"slug":"wiki/personal/patterns/example"}'::jsonb, '{}'::jsonb, 'complete')`, [jobId]);
    return { id: jobId, status: childStatus };
  },
}));
const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');
const { runPhaseDrift } = await import('../src/core/cycle/drift.ts');
let engine: PGLiteEngine;
let schemaVersion: string;
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-publication-deferral-'));
const STAMP_KEY = 'dream.patterns.last_evidence_ts';
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(scratch, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  publishError = undefined; stampCalls = 0; publishCalls = 0; verified = 0; childStatus = 'completed';
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
  for (let i = 0; i < 3; i++) await engine.putPage(`wiki/personal/reflections/example-${i}`, {
    type: 'note', title: `Reflection ${i}`, compiled_truth: 'A recurring synthetic theme.',
  });
  const page = await engine.putPage('people/erin-example', { type: 'person', title: 'Erin', compiled_truth: 'Example person.' });
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Careful operator', kind: 'take', holder: 'brain', weight: 0.6 }]);
  await engine.addTimelineEntriesBatch([{ slug: page.slug, date: '2030-01-15', source: 'meeting', summary: 'Changed roles' }]);
});
async function contention(): Promise<unknown> {
  try { await retryWriteAdmission('00000000-0000-4000-a000-000000000001', async () => { throw Object.assign(new Error('synthetic SQL lock'), { code: '55P03' }); }, 0); }
  catch (error) { return error; }
  throw new Error('Admission must fail');
}
function pending(terminal = false): OperationError {
  const error = new OperationError('write_pending', 'Accepted publication is pending.', 'Read its receipt.');
  error.writeRequest = { request_id: '00000000-0000-4000-a000-000000000002',
    state: terminal ? 'failed' : 'queued', retry_after_ms: terminal ? null : 1000 };
  return error;
}
const runDrift = () => runPhaseDrift(engine, { dryRun: false, forceEnabled: true, cycleDate: '2030-01-20',
  auditPath: join(scratch, 'drift.jsonl'), judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'Changed evidence.' }) });

describe('managed dream publication deferral (#6052)', () => {
  for (const fault of ['contention', 'pending'] as const) {
    test(`patterns defers ${fault} without advancing evidence or verifying unfinished output`, async () => {
      publishError = fault === 'contention' ? await contention() : pending();
      const result = await runPhasePatterns(engine, { brainDir: scratch, dryRun: false, once: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('warn');
      expect(result.details.publish_deferred).toBe(1);
      expect(result.details.patterns_written).toBe(0);
      expect(result.details.child_outcome).toBe('completed');
      expect(result.error).toBeUndefined();
      expect(verified).toBe(0);
      expect(await engine.getConfig(STAMP_KEY)).toBeNull();
      publishError = undefined;
      const resumed = await runPhasePatterns(engine, { brainDir: scratch, dryRun: false, once: true });
      expect(resumed.status).toBe('ok');
      expect(await engine.getConfig(STAMP_KEY)).not.toBeNull();
    });
    test(`drift defers ${fault} without claiming a published report`, async () => {
      publishError = fault === 'contention' ? await contention() : pending();
      const result = await runDrift();
      expect(result.status).toBe('partial');
      expect(result.totals?.publish_deferred).toBe(1);
      expect(result.totals?.reports_written).toBe(0);
      expect(result.totals?.judged).toBe(1);
      expect(result.detail).toContain('publication deferred');
      expect(result.detail).not.toContain(' → reports/');
      expect(await engine.getPage('reports/drift-2030-01-20')).toBeNull();
    });
  }
  test('a failed patterns child remains a failure even if its partial output is pending', async () => {
    childStatus = 'failed'; publishError = pending();
    const result = await runPhasePatterns(engine, { brainDir: scratch, dryRun: false, once: true });
    expect(result.status).toBe('fail');
    expect(result.error?.code).toBe('PATTERNS_CHILD_FAILED');
    expect(await engine.getConfig(STAMP_KEY)).toBeNull();
  });
  for (const error of [new OperationError('storage_error', 'A real storage failure.', ''),
    new OperationError('permission_denied', 'Revoked writer.', ''), pending(true),
    new OperationError('write_pending', 'No accepted receipt.', '')]) {
    test(`does not defer ${error.message}`, async () => {
      publishError = error;
      expect((await runPhasePatterns(engine, { brainDir: scratch, dryRun: false, once: true })).status).toBe('fail');
      await expect(runDrift()).rejects.toBe(error);
    });
  }
});
