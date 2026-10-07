/**
 * Remediation impact history (#6109).
 *
 * `gbrain onboard --history` reads migration_impact_log. runRemediation is
 * its writer: every executed step whose job moves a tracked metric records
 * that metric just before its job is submitted and again once the job is
 * terminal. Each metric must be the number the rest of the brain reports
 * (get_health's orphan_pages, the onboard coverage checks' population, the
 * embed worker's stale count), and history bookkeeping must never change a
 * step's outcome.
 *
 * Protects: the history rows a real remediation run leaves, and the
 * definitions of the captured metrics. Fails when the capture is unwired
 * (history stays empty), a step writes a row it should not (dry run,
 * unmapped job), a capture or log-write failure changes the step result, or
 * a metric drifts from the check it is meant to measure.
 * Seams: none; real remediation with inline jobs on PGLite. The Postgres arm
 * of the JSONB details write is test/e2e/onboard-full-flow.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRemediation } from '../src/core/remediation/index.ts';
import { makeRemediationStep } from '../src/core/remediation-step.ts';
import { captureMetric } from '../src/core/onboard/impact-capture.ts';
import { buildQuarantineMarker } from '../src/core/quarantine.ts';
import { runOnboard } from '../src/commands/onboard.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

interface HistoryEntry {
  remediation_id: string;
  metric_name: string;
  metric_before: number | null;
  metric_after: number | null;
  delta: number | null;
  applied_at: string;
}

async function onboardStdout(args: string[]): Promise<string> {
  let captured = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as never);
  try {
    await runOnboard(engine, args);
  } finally {
    write.mockRestore();
  }
  return captured;
}

async function historyEntries(): Promise<HistoryEntry[]> {
  return (JSON.parse(await onboardStdout(['--history', '--json'])) as { history: HistoryEntry[] }).history;
}

async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = '';
  const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as never);
  try {
    return { result: await fn(), stderr };
  } finally {
    write.mockRestore();
  }
}

/**
 * Three unextracted pages: a note wikilinking two entities. All three are
 * orphans until extraction runs, so the planner schedules extract.stale and
 * its job takes the orphan count from 3 to 0.
 */
async function seedUnextractedNote(): Promise<void> {
  await engine.putPage('notes/kickoff-example', {
    type: 'note', title: 'Kickoff', compiled_truth: 'Met [[people/carol-example]] and [[companies/delta-example]].',
  });
  await engine.putPage('people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: 'An engineer.' });
  await engine.putPage('companies/delta-example', { type: 'company', title: 'Delta Example', compiled_truth: 'A company.' });
}

describe('remediation writes onboard history (#6109)', () => {
  test('an executed step records its metric before and after its job', async () => {
    await seedUnextractedNote();
    expect(await historyEntries()).toEqual([]);

    const result = await runRemediation(engine, { targetScore: 0, inlineJobs: true });
    const step = result.submitted.find((s) => s.id === 'extract.stale');
    expect(step?.status).toBe('completed');

    const entries = await historyEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      remediation_id: 'extract.stale', metric_name: 'orphan_count', metric_before: 3, metric_after: 0, delta: -3,
    });
    expect(entries[0]!.applied_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await onboardStdout(['--history'])).toBe(
      `Onboard history (last 1):\n  ${entries[0]!.applied_at}  extract.stale  orphan_count: 3 → 0 (-3)\n`);

    const [row] = await engine.executeRaw<{ job_id: number; idempotency_key: string; details: Record<string, unknown> }>(
      'SELECT job_id, idempotency_key, details FROM migration_impact_log');
    const [job] = await engine.executeRaw<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM minion_jobs WHERE id = $1', [step!.job_id]);
    expect(Number(row!.job_id)).toBe(step!.job_id!);
    expect(row!.idempotency_key).toBe(job!.idempotency_key);
    expect(row!.details).toEqual({ job: 'extract', status: 'completed', doctor_run_id: result.doctor_run_id });
  });

  test("a step whose job moves no tracked metric records nothing, even once it is terminal", async () => {
    await seedUnextractedNote();
    const unmapped = makeRemediationStep({
      id: 'onboard.unmapped-example', job: 'unify-types', params: { apply: false },
      severity: 'low', est_seconds: 30, est_usd_cost: 0, protected: true, rationale: 'synthetic unmapped job',
    });
    const { result } = await withStderr(() => runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [unmapped] }));
    const unmappedStep = result.submitted.find((s) => s.id === 'onboard.unmapped-example');
    expect(unmappedStep?.job_id).not.toBeNull();
    expect(['completed', 'failed', 'dead']).toContain(unmappedStep!.status);
    expect((await historyEntries()).map((e) => e.remediation_id)).toEqual(['extract.stale']);
  });

  test('a dry run records nothing', async () => {
    await seedUnextractedNote();
    const dry = await runRemediation(engine, { targetScore: 0, dryRun: true });
    expect(dry.submitted.map((s) => s.status)).toContain('dry_run');
    expect(await historyEntries()).toEqual([]);
  });

  test('an unreadable metric still records the attempt, with unknown values', async () => {
    await seedUnextractedNote();
    const orphans = spyOn(engine, 'findOrphanPages').mockRejectedValue(new Error('synthetic read failure'));
    try {
      const { result, stderr } = await withStderr(() => runRemediation(engine, { targetScore: 0, inlineJobs: true }));
      expect(result.submitted.find((s) => s.id === 'extract.stale')?.status).toBe('completed');
      expect(stderr).toContain('[impact-capture] failed to capture orphan_count: synthetic read failure');
    } finally {
      orphans.mockRestore();
    }
    expect(await historyEntries()).toMatchObject([
      { remediation_id: 'extract.stale', metric_before: null, metric_after: null, delta: null },
    ]);
  });

  test('a failed history write leaves the step completed', async () => {
    await seedUnextractedNote();
    // A real write failure: every new history row violates this constraint.
    await engine.executeRaw('ALTER TABLE migration_impact_log ADD CONSTRAINT impact_log_rejects_writes CHECK (false) NOT VALID');
    try {
      const { result, stderr } = await withStderr(() => runRemediation(engine, { targetScore: 0, inlineJobs: true }));
      expect(result.submitted.find((s) => s.id === 'extract.stale')?.status).toBe('completed');
      expect(stderr).toContain('[impact-capture] failed to write log row for extract.stale');
    } finally {
      await engine.executeRaw('ALTER TABLE migration_impact_log DROP CONSTRAINT impact_log_rejects_writes');
    }
    expect(await historyEntries()).toEqual([]);
  });
});

describe('captured metrics match the numbers the brain reports (#6109)', () => {
  test("orphan_count is get_health's orphan_pages, read without get_health", async () => {
    await engine.putPage('notes/alone-example', { type: 'note', title: 'Alone', compiled_truth: 'Nothing links here.' });
    await engine.putPage('notes/outbound-example', { type: 'note', title: 'Outbound', compiled_truth: 'Links out.' });
    await engine.putPage('notes/target-example', { type: 'note', title: 'Target', compiled_truth: 'Linked from outbound.' });
    await engine.putPage('notes/ghost-linked-example', { type: 'note', title: 'Ghost linked', compiled_truth: 'Only a deleted page links here.' });
    await engine.putPage('notes/ghost-example', { type: 'note', title: 'Ghost', compiled_truth: 'Soft-deleted.' });
    await engine.putPage('templates/new-person', { type: 'note', title: 'Template', compiled_truth: 'Excluded by the orphan policy.' });
    await engine.putPage('notes/hidden-example', {
      type: 'note', title: 'Hidden', compiled_truth: 'Quarantined.',
      frontmatter: { quarantine: buildQuarantineMarker('junk_pattern', 'synthetic fixture') },
    });
    await engine.addLink('notes/outbound-example', 'notes/target-example', '', 'mentions', 'manual');
    await engine.addLink('notes/ghost-example', 'notes/ghost-linked-example', '', 'mentions', 'manual');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/ghost-example'`);

    const health = spyOn(engine, 'getHealth');
    let orphans: number | null;
    try {
      orphans = await captureMetric(engine, 'orphan_count');
      expect(health).not.toHaveBeenCalled();
    } finally {
      health.mockRestore();
    }
    // alone + ghost-linked; the linked pair, the template and the quarantined page are not orphans.
    expect(orphans).toBe(2);
    expect(orphans).toBe((await engine.getHealth()).orphan_pages);
  });

  test("coverage metrics leave out the entity pages the onboard checks leave out", async () => {
    const quarantine = { quarantine: buildQuarantineMarker('junk_pattern', 'synthetic fixture') };
    await engine.putPage('notes/source-example', { type: 'note', title: 'Source', compiled_truth: 'A note.' });
    await engine.putPage('people/linked-example', { type: 'person', title: 'Linked', compiled_truth: 'Visible.' });
    await engine.putPage('people/plain-example', { type: 'person', title: 'Plain', compiled_truth: 'Visible.' });
    await engine.putPage('people/hidden-example', { type: 'person', title: 'Hidden', compiled_truth: 'Quarantined.', frontmatter: quarantine });
    await engine.addLink('notes/source-example', 'people/linked-example', '', 'mentions', 'manual');
    await engine.addLink('notes/source-example', 'people/hidden-example', '', 'mentions', 'manual');
    await engine.addTimelineEntry('people/linked-example', { date: '2026-01-02', source: 'synthetic', summary: 'Met' });
    await engine.addTimelineEntry('people/hidden-example', { date: '2026-01-02', source: 'synthetic', summary: 'Met' });

    expect(await captureMetric(engine, 'entity_link_coverage')).toBe(0.5);
    expect(await captureMetric(engine, 'timeline_coverage')).toBe(0.5);
  });

  test("stale_count is the embed worker's stale count, so embed_skip chunks are not stale", async () => {
    await engine.putPage('notes/waiting-example', { type: 'note', title: 'Waiting', compiled_truth: 'Needs a vector.' });
    await installFixtureChunks(engine, 'notes/waiting-example', [{ chunk_index: 0, chunk_text: 'Needs a vector.', chunk_source: 'compiled_truth' }]);
    await engine.putPage('notes/skip-example', { type: 'note', title: 'Skip', compiled_truth: 'Never embedded.', frontmatter: { embed_skip: true } });
    await installFixtureChunks(engine, 'notes/skip-example', [{ chunk_index: 0, chunk_text: 'Never embedded.', chunk_source: 'compiled_truth' }]);

    expect(await engine.countStaleChunks()).toBe(1);
    expect(await captureMetric(engine, 'stale_count')).toBe(1);
  });
});
