import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbed from '../../src/commands/embed.ts';
import * as realGateway from '../../src/core/ai/gateway.ts';
import * as realInlineDrain from '../../src/core/cycle/inline-drain.ts';
import type { CycleReport } from '../../src/core/cycle.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import type { MinionJobContext, MinionJobStatus } from '../../src/core/minions/types.ts';
import { TIER_DEFAULTS } from '../../src/core/model-config.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';

let abortDuringEmbed: AbortController | undefined;
let stealDuringEmbed = false;
mock.module('../../src/commands/embed.ts', () => ({
  ...realEmbed,
  runEmbedCore: async (engine: BrainEngine, opts: { signal?: AbortSignal }) => {
    if (stealDuringEmbed) {
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks SET acquired_at = acquired_at + INTERVAL '1 millisecond'
         WHERE id = 'gbrain-cycle'`,
      );
      await new Promise<void>(resolve => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0 };
    }
    if (abortDuringEmbed) {
      abortDuringEmbed.abort();
      return { embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0 };
    }
    throw new Error('synthetic required phase failure');
  },
}));

mock.module('../../src/core/ai/gateway.ts', () => ({
  ...realGateway,
  probeChatModel: () => ({ ok: true }),
  chat: async () => { throw new Error('unexpected model call in global freshness test'); },
}));

let childStatuses: MinionJobStatus[] = [];
let writtenChildSlug: string | undefined;
mock.module('../../src/core/cycle/inline-drain.ts', () => ({
  ...realInlineDrain,
  runSubagentsInline: async (engine: BrainEngine, _queue: MinionQueue, queueName: string) => {
    const jobs = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE queue = $1 ORDER BY id`, [queueName],
    );
    for (const [index, job] of jobs.entries()) {
      if (writtenChildSlug) {
        await engine.putPage(writtenChildSlug, {
          title: 'Synthetic pattern', type: 'note', compiled_truth: 'A recurring synthetic theme.', timeline: '',
        });
        await engine.executeRaw(
          `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
           VALUES ($1, 0, 'fixture-write', 'brain_put_page', $2::jsonb, 'complete')`,
          [job.id, { slug: writtenChildSlug }],
        );
      }
      await engine.executeRaw(
        `UPDATE minion_jobs SET status = $2, finished_at = NOW() WHERE id = $1`,
        [job.id, childStatuses[index] ?? 'completed'],
      );
    }
  },
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { registerBuiltinHandlers } = await import('../../src/commands/jobs.ts');
const { LAST_GLOBAL_AT_KEY } = await import('../../src/core/cycle.ts');
const { isGlobalMaintenanceStale } = await import('../../src/commands/autopilot-fanout.ts');
const { TRIAGE_VERSION } = await import('../../src/core/cycle/synthesize.ts');
const engine = new PGLiteEngine();
const repoPath = mkdtempSync(join(tmpdir(), 'global-postcondition-'));
const corpusPath = join(repoPath, 'corpus');
const priorHome = process.env.GBRAIN_HOME;
let schemaVersion: string;
let ownerJobId: number;
let handler: (job: MinionJobContext) => Promise<{ report: CycleReport }>;

beforeAll(async () => {
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
  process.env.GBRAIN_HOME = join(repoPath, 'home');
  await registerBuiltinHandlers({ register: (name: string, fn: typeof handler) => {
    if (name === 'autopilot-global-maintenance') handler = fn;
  } } as never, engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  ownerJobId = (await new MinionQueue(engine).add('autopilot-global-maintenance', {})).id;
  await engine.putPage('atoms/example', { title: 'Example', type: 'note', compiled_truth: 'A synthetic note.', timeline: '' });
  rmSync(corpusPath, { recursive: true, force: true });
  mkdirSync(corpusPath);
  childStatuses = [];
  writtenChildSlug = undefined;
});

async function seedTranscripts(count: number): Promise<void> {
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusPath);
  await engine.setConfig('dream.synthesize.summary_file_write', 'false');
  for (let i = 0; i < count; i++) {
    const filePath = join(corpusPath, `2026-08-01-example-${i}.txt`);
    const content = `Synthetic transcript ${i} line.\n`.repeat(250);
    writeFileSync(filePath, content);
    await engine.putDreamVerdict(filePath, createHash('sha256').update(content).digest('hex'), {
      worth_processing: true, reasons: ['synthetic fixture'], score: 0.9,
      content_type: null, segments: [], entities: [], model: TIER_DEFAULTS.utility,
      triage_version: TRIAGE_VERSION,
    });
  }
}

async function seedReflections(): Promise<void> {
  await engine.setConfig('dream.patterns.enabled', 'true');
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`wiki/personal/reflections/example-${i}`, {
      title: `Reflection ${i}`, type: 'note', compiled_truth: `Recurring synthetic theme ${i}.`, timeline: '',
    });
  }
}

describe('global maintenance freshness postcondition (#5089)', () => {
  test('a required-phase failure stays due even when another phase succeeds', async () => {
    const result = await handler({ id: ownerJobId, data: { phases: ['orphans', 'embed'], repoPath } } as unknown as MinionJobContext);
    expect(result.report.status).toBe('partial');
    expect(result.report.phases.find(p => p.phase === 'embed')?.status).toBe('fail');
    const stamp = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamp).toBeNull();
    expect(isGlobalMaintenanceStale(stamp, Date.now() + 60_000, 60)).toBe(true);
  }, 60_000);

  test('a successful read-only maintenance run stamps freshness', async () => {
    const result = await handler({ id: ownerJobId, data: { phases: ['orphans'], repoPath } } as unknown as MinionJobContext);
    expect(result.report.phases.some(p => p.status === 'fail')).toBe(false);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);

  test('a warning-only partial stamps freshness instead of rerunning every tick', async () => {
    for (const slug of ['people/example-a', 'people/example-b']) {
      await engine.putPage(slug, { title: slug, type: 'person', compiled_truth: 'An isolated synthetic page.', timeline: '' });
    }
    const result = await handler({ id: ownerJobId, data: { phases: ['orphans'], repoPath } } as unknown as MinionJobContext);
    expect(result.report.status).toBe('partial');
    expect(result.report.phases[0].status).toBe('warn');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);

  test('mixed completed and dead synthesis children stay due despite an ok phase', async () => {
    await seedTranscripts(2);
    childStatuses = ['completed', 'dead'];
    const result = await handler({ id: ownerJobId, data: { phases: ['synthesize'], repoPath } } as unknown as MinionJobContext);
    const phase = result.report.phases[0];
    expect(phase.status).toBe('ok');
    expect(phase.details.child_outcomes).toEqual([
      expect.objectContaining({ status: 'completed' }), expect.objectContaining({ status: 'dead' }),
    ]);
    expect(phase.details.synthesis).toMatchObject({ non_completed_jobs: 1, degraded: true });
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    const stamp = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamp).toBeNull();
    expect(isGlobalMaintenanceStale(stamp, Date.now(), 60)).toBe(true);
  }, 60_000);

  test('budget-deferred transcripts stay due even when every submitted child completed', async () => {
    await seedTranscripts(2);
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const realAdd = MinionQueue.prototype.add;
    const submit = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function (this: MinionQueue, ...args) {
      const child = await realAdd.apply(this, args);
      clock.mockReturnValue(now + 4 * 60_000);
      return child;
    });
    let result;
    try {
      result = await handler({
        id: ownerJobId, data: { phases: ['synthesize'], repoPath }, deadlineAtMs: now + 5 * 60_000,
      } as unknown as MinionJobContext);
    } finally {
      submit.mockRestore();
      clock.mockRestore();
    }
    const phase = result.report.phases[0];
    expect(phase.status).toBe('ok');
    expect(phase.details.synthesis).toMatchObject({ non_completed_jobs: 0, degraded: false });
    expect(phase.details.children_submitted).toBe(1);
    expect(phase.details.budget_deferred_transcripts).toHaveLength(1);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test('triage-deferred transcripts stay due without submitting children', async () => {
    await seedTranscripts(1);
    await engine.executeRaw('TRUNCATE dream_verdicts');
    await engine.setConfig('dream.triage.max_ms', '1');
    const realGet = engine.getDreamVerdict.bind(engine);
    const lookup = spyOn(engine, 'getDreamVerdict').mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return realGet(...args);
    });
    let result;
    try {
      result = await handler({ id: ownerJobId, data: { phases: ['synthesize'], repoPath } } as unknown as MinionJobContext);
    } finally {
      lookup.mockRestore();
    }
    expect(result.report.phases[0].status).toBe('ok');
    expect(result.report.phases[0].details.triage).toMatchObject({ deferred: 1, degraded: 0 });
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test('mixed completed synthesis and triage deferral retries only unfinished work next tick', async () => {
    await seedTranscripts(2);
    const deferredPath = join(corpusPath, '2026-08-01-example-1.txt');
    await engine.executeRaw('DELETE FROM dream_verdicts WHERE file_path = $1', [deferredPath]);
    await engine.setConfig('dream.triage.max_ms', '1');
    const realGet = engine.getDreamVerdict.bind(engine);
    const lookup = spyOn(engine, 'getDreamVerdict').mockImplementation(async (...args) => {
      if (args[0] === deferredPath) await new Promise(resolve => setTimeout(resolve, 10));
      return realGet(...args);
    });
    const job = { id: ownerJobId, data: { phases: ['synthesize'], repoPath } } as unknown as MinionJobContext;
    let first;
    try {
      first = await handler(job);
    } finally {
      lookup.mockRestore();
    }
    expect(first.report.phases[0]).toMatchObject({
      status: 'ok',
      details: {
        triage: { cache_hits: 1, deferred: 1 }, children_submitted: 1,
        synthesis: { non_completed_jobs: 0, degraded: false }, budget_deferred_transcripts: [],
      },
    });
    const firstCooldown = await engine.getConfig('dream.synthesize.last_completion_ts');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();

    await seedTranscripts(2);
    const retry = await handler(job);
    expect(retry.report.phases[0].details.reason).not.toBe('cooldown_active');
    expect(firstCooldown).toBeNull();
    expect(retry.report.phases[0]).toMatchObject({
      status: 'ok', details: { triage: { deferred: 0 }, children_submitted: 1 },
    });
    expect(retry.report.phases[0].details.skips).toEqual([
      expect.objectContaining({ reason: 'already_synthesized_v2_single_chunk' }),
    ]);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);

  test.each(['synthesize', 'patterns'] as const)('%s skipped for an insufficient cycle budget stays due', async phase => {
    await seedTranscripts(1);
    await seedReflections();
    const result = await handler({
      id: ownerJobId, data: { phases: [phase], repoPath }, deadlineAtMs: Date.now() + 30_000,
    } as unknown as MinionJobContext);
    expect(result.report.phases[0]).toMatchObject({ status: 'skipped', details: { reason: 'insufficient_cycle_budget' } });
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test.each(['dead', 'cancelled'] as const)('patterns child %s after writing a page stays due despite a warning', async status => {
    await seedReflections();
    childStatuses = [status];
    writtenChildSlug = 'wiki/personal/patterns/example';
    const result = await handler({ id: ownerJobId, data: { phases: ['patterns'], repoPath } } as unknown as MinionJobContext);
    expect(result.report.status).toBe('partial');
    expect(result.report.phases[0]).toMatchObject({
      status: 'warn', details: { child_outcome: status, patterns_written: 1 },
    });
    expect(await engine.getPage(writtenChildSlug)).not.toBeNull();
    expect(await engine.getConfig('dream.patterns.last_evidence_ts')).toBeNull();
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test('fully completed synthesis children stamp freshness, including a later cooldown skip', async () => {
    await seedTranscripts(2);
    const job = { id: ownerJobId, data: { phases: ['synthesize'], repoPath } } as unknown as MinionJobContext;
    const result = await handler(job);
    expect(result.report.phases[0].details.synthesis).toMatchObject({ non_completed_jobs: 0, degraded: false });
    expect(result.report.phases[0].details.budget_deferred_transcripts).toEqual([]);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
    await engine.unsetConfig(LAST_GLOBAL_AT_KEY);
    const cooled = await handler(job);
    expect(cooled.report.phases[0].details.reason).toBe('cooldown_active');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);

  test('completed patterns with zero writes stamp freshness, including unchanged evidence', async () => {
    await seedReflections();
    const job = { id: ownerJobId, data: { phases: ['patterns'], repoPath } } as unknown as MinionJobContext;
    const result = await handler(job);
    expect(result.report.phases[0]).toMatchObject({
      status: 'ok', details: { child_outcome: 'completed', patterns_written: 0 },
    });
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
    await engine.unsetConfig(LAST_GLOBAL_AT_KEY);
    const unchanged = await handler(job);
    expect(unchanged.report.phases[0].details.reason).toBe('no_new_evidence');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);

  test('an aborted run does not stamp freshness', async () => {
    const controller = new AbortController();
    abortDuringEmbed = controller;
    try {
      const result = await handler({ id: ownerJobId, data: { phases: ['embed'], repoPath }, signal: controller.signal } as unknown as MinionJobContext);
      expect(result.report.reason).toBe('aborted');
      expect(result.report.phases.some(p => p.status === 'fail')).toBe(false);
      expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    } finally {
      abortDuringEmbed = undefined;
    }
  }, 60_000);

  test('a lock-stolen run does not stamp freshness or release its successor lock', async () => {
    stealDuringEmbed = true;
    try {
      await withEnv({ GBRAIN_CYCLE_LOCK_REFRESH_MS: '20' }, async () => {
        const result = await handler({ id: ownerJobId, data: { phases: ['embed', 'orphans'], repoPath } } as unknown as MinionJobContext);
        expect(result.report.reason).toBe('lock_stolen');
        expect(result.report.phases.some(p => p.status === 'fail')).toBe(false);
        expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
        const locks = await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle'`);
        expect(locks).toHaveLength(1);
      });
    } finally {
      stealDuringEmbed = false;
    }
  }, 60_000);
});
