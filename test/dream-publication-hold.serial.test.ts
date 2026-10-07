/**
 * #6052: a managed dream publication that is accepted-but-pending, or whose
 * admission rolled back under database contention, is held for a later cycle
 * instead of failing the patterns or drift phase. Anything else still fails.
 *
 * Serial (R2): mock.module replaces the paid child, the chat gateway and the
 * managed publication boundary (prepared-maintenance.ts) for the whole process.
 * The engine, job queue, evidence watermark, take/timeline evidence, drift
 * candidate selection, report building and the hold classifier are real; the
 * contention error is produced by the real admission retry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const PATTERN_A = 'wiki/personal/patterns/acme-example-rhythm';
const PATTERN_B = 'wiki/personal/patterns/acme-example-drift';
const WATERMARK = 'dream.patterns.last_evidence_ts';

/** Per-slug failure each mocked publication throws; a slug absent here publishes. */
const failures = new Map<string, unknown>();
const calls = { publish: [] as string[], stamp: [] as string[], verify: [] as string[][] };
let childWrites: string[] = [];
let childOutcome = 'completed';

const failFor = (slug: string) => {
  const error = failures.get(slug);
  if (error !== undefined) throw error;
};

mock.module('../src/core/ai/gateway.ts', () => ({ probeChatModel: () => ({ ok: true }) }));
mock.module('../src/core/cycle/synthesize-concepts.ts', () => ({ resolveSynthMaxOutputTokens: () => 2048 }));
mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
}));
mock.module('../src/core/persistence/prepared-maintenance.ts', () => ({
  maintenancePreflight: async () => ({ writer: { sourceId: 'default' } }),
  publishMaintenancePage: async (_engine: unknown, _authority: unknown, slug: string) => { calls.publish.push(slug); failFor(slug); return {}; },
  stampMaintenancePage: async (_engine: unknown, _authority: unknown, slug: string) => { calls.stamp.push(slug); failFor(slug); },
  verifyMaintenanceOutputs: async (_engine: unknown, _authority: unknown, refs: Array<{ slug: string }>) => {
    calls.verify.push(refs.map(ref => ref.slug));
    return refs.length;
  },
}));
mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletionRenewing: async (_queue: unknown, jobId: number, opts?: { renew?: () => Promise<void> }) => {
    await opts?.renew?.();
    for (const [i, slug] of childWrites.entries()) {
      await engine.executeRaw(`INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, output, status)
        VALUES ($1, $2, $3, 'brain_put_page', $4::text::jsonb, '{}'::jsonb, 'complete')`, [jobId, i, `write-${i}`, JSON.stringify({ slug })]);
    }
    return { id: jobId, status: childOutcome };
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');
const { runPhaseDrift } = await import('../src/core/cycle/drift.ts');

let engine: PGLiteEngine;
let version: string;
const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-publication-hold-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  version = (await engine.getConfig('version'))!;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', version);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
  failures.clear();
  calls.publish = []; calls.stamp = []; calls.verify = [];
  childWrites = [PATTERN_A];
  childOutcome = 'completed';
  for (const day of ['01', '02', '03']) {
    await engine.putPage(`wiki/personal/reflections/2031-04-${day}`, { type: 'note', title: `Reflection ${day}`, compiled_truth: 'Weekly planning keeps slipping.' });
  }
  const person = await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Placeholder person.' });
  await engine.addTakesBatch([{ page_id: person.id, row_num: 1, claim: 'Prefers async updates', kind: 'take', holder: 'brain', weight: 0.7 }]);
  await engine.addTimelineEntriesBatch([{ slug: person.slug, date: '2031-04-10', source: 'meeting', summary: 'Asked for a weekly sync' }]);
});

const pendingReceipt = (state = 'queued') => {
  const error = new OperationError('write_pending', 'Publication accepted.', 'Poll the receipt.');
  error.writeRequest = { request_id: '7a1c0d2e-0000-4000-8000-00000000c0de', state: state as never, retry_after_ms: state === 'queued' ? 500 : null };
  return error;
};

async function admissionContention(): Promise<unknown> {
  const lockTimeout = async () => { throw Object.assign(new Error('lock wait'), { code: '55P03' }); };
  return retryWriteAdmission('7a1c0d2e-0000-4000-8000-00000000beef', lockTimeout, 0).then(
    () => { throw new Error('admission unexpectedly succeeded'); },
    (error: unknown) => error,
  );
}

const patterns = () => runPhasePatterns(engine, { brainDir, dryRun: false, once: true });
const drift = () => runPhaseDrift(engine, {
  dryRun: false, forceEnabled: true, cycleDate: '2031-04-14', auditPath: join(brainDir, 'drift-audit.jsonl'),
  judge: async () => ({ drifted: true, confidence: 0.8, reasoning: 'Evidence moved.' }),
});

describe('patterns phase holds unfinished managed publications (#6052)', () => {
  test('a pending provenance stamp warns, skips verification of that page and leaves the watermark; the next cycle finishes', async () => {
    failures.set(PATTERN_A, pendingReceipt());
    const held = await patterns();
    expect(held.status).toBe('warn');
    expect(held.error).toBeUndefined();
    expect(held.details).toMatchObject({ patterns_written: 0, publish_deferred: 1, child_outcome: 'completed' });
    expect(calls.verify).toEqual([[]]);
    expect(await engine.getConfig(WATERMARK)).toBeNull();

    failures.clear();
    const next = await patterns();
    expect(next.status).toBe('ok');
    expect(next.details).toMatchObject({ patterns_written: 1, publish_deferred: 0 });
    expect(await engine.getConfig(WATERMARK)).not.toBeNull();
  });

  test('a contended grounding publish is not stamped and does not block a sibling page', async () => {
    childWrites = [PATTERN_A, PATTERN_B];
    for (const slug of childWrites) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Planning slips every week.' });
    }
    failures.set(PATTERN_B, await admissionContention());
    const held = await patterns();
    expect(held.status).toBe('warn');
    expect(held.details).toMatchObject({ patterns_written: 1, publish_deferred: 1 });
    expect(calls.publish).toContain(PATTERN_B);
    expect(calls.stamp).toEqual([PATTERN_A]);
    expect(calls.verify).toEqual([[PATTERN_A]]);
    expect(await engine.getConfig(WATERMARK)).toBeNull();
  });

  test('a failed child with only held output is still a failure', async () => {
    childOutcome = 'failed';
    failures.set(PATTERN_A, pendingReceipt());
    const result = await patterns();
    expect(result.status).toBe('fail');
    expect(result.error?.code).toBe('PATTERNS_CHILD_FAILED');
    expect(await engine.getConfig(WATERMARK)).toBeNull();
  });
});

describe('drift phase holds an unfinished report (#6052)', () => {
  test('pending: partial, nothing counted as written, no report link', async () => {
    failures.set('reports/drift-2031-04-14', pendingReceipt('running'));
    const result = await drift();
    expect(result.status).toBe('partial');
    expect(result.totals).toMatchObject({ judged: 1, reports_written: 0, publish_deferred: 1 });
    expect(result.detail).toContain('report accepted, still publishing');
    expect(result.detail).not.toContain('→');
  });

  test('contention: partial, and the detail says the next cycle writes it', async () => {
    failures.set('reports/drift-2031-04-14', await admissionContention());
    const result = await drift();
    expect(result.status).toBe('partial');
    expect(result.totals).toMatchObject({ reports_written: 0, publish_deferred: 1 });
    expect(result.detail).toContain('database contention');
  });

  test('control: a published report completes and is linked', async () => {
    const result = await drift();
    expect(result.status).toBe('complete');
    expect(result.totals).toMatchObject({ reports_written: 1, publish_deferred: 0 });
    expect(result.detail).toContain('→ reports/drift-2031-04-14');
  });
});

describe('errors that are not holds still fail both phases (#6052)', () => {
  const contentionWithReceipt = () => {
    const error = new OperationError('storage_error', 'Contended after admission.', 'Poll the receipt.');
    error.detail = 'database_contention';
    error.writeRequest = pendingReceipt().writeRequest;
    return error;
  };
  const cases: Array<[string, () => unknown]> = [
    ['permission_denied', () => new OperationError('permission_denied', 'Writer grant revoked.', '')],
    ['storage_error without contention detail', () => new OperationError('storage_error', 'Disk full.', '')],
    ['contention that already carries a receipt', contentionWithReceipt],
    ['write_pending with a terminal receipt', () => pendingReceipt('failed')],
    ['write_pending with no receipt', () => new OperationError('write_pending', 'No receipt.', '')],
    ['a plain Error naming database_contention', () => new Error('storage_error: database_contention')],
    ['a look-alike object that is not an OperationError', () => ({ code: 'write_pending', writeRequest: { state: 'queued' } })],
  ];
  for (const [label, make] of cases) {
    test(label, async () => {
      const error = make();
      failures.set(PATTERN_A, error);
      failures.set('reports/drift-2031-04-14', error);
      const result = await patterns();
      expect(result.status).toBe('fail');
      expect(await engine.getConfig(WATERMARK)).toBeNull();
      await expect(drift()).rejects.toBe(error);
    });
  }
});
