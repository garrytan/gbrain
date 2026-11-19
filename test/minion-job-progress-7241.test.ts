/**
 * #7241: a live `sync`, `autopilot-cycle` or `autopilot-global-maintenance` job writes its phase to
 * `minion_jobs.progress`, so `foresights jobs get` shows what it is doing instead of an empty progress column.
 *
 * Each case drives the real handler against a real queue row claimed with a lock token (the worker's
 * token-fenced context from buildJobContext), then reads the column. A progress write that throws never
 * fails the job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { buildJobContext } from '../src/core/minions/job-context.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { makeAutopilotGlobalMaintenanceHandler } from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-job-progress-'));
const brain = join(home, 'brain');
let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
  mkdirSync(brain, { recursive: true });
  const repo = await makeGitFixture(brain);
  writeFileSync(join(brain, 'note.md'), '---\ntitle: Note\ntype: note\n---\n\nA short note.\n');
  repo.commitAll('add note');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

/** A queue row claimed the way a worker leaves it, with the worker's token-fenced context; every progress write is also recorded. */
async function claimed(name: string, data: Record<string, unknown>): Promise<{ ctx: MinionJobContext; writes: Array<Record<string, unknown>>; id: number }> {
  const queue = new MinionQueue(engine);
  const row = await queue.add(name, data, {}, { allowProtectedSubmit: true });
  const token = `tok-${row.id}`;
  await engine.executeRaw(`UPDATE minion_jobs SET status='active', started_at=now(), lock_until=now() + interval '5 minutes', lock_token=$2, claim_generation=claim_generation + 1 WHERE id=$1`, [row.id, token]);
  const ctx = buildJobContext(engine, queue, (await queue.getJob(row.id))!, token, new AbortController().signal, new AbortController().signal);
  const writes: Array<Record<string, unknown>> = [];
  const write = ctx.updateProgress;
  ctx.updateProgress = async (progress: unknown) => { writes.push(progress as Record<string, unknown>); await write(progress); };
  return { ctx, writes, id: row.id };
}
const storedProgress = async (id: number) =>
  (await engine.executeRaw<{ progress: Record<string, unknown> | null }>('SELECT progress FROM minion_jobs WHERE id = $1', [id]))[0]!.progress;

describe('#7241 job progress', () => {
  test('autopilot-cycle writes each phase it enters, with its position in the cycle', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { ctx, writes, id } = await claimed('autopilot-cycle', { phases: ['orphans', 'purge'] });
    const result = await makeAutopilotCycleHandler(engine)(ctx) as { report: CycleReport };
    expect(result.report.phases.map(p => p.phase)).toEqual(['orphans', 'purge']);
    expect(writes.map(w => [w.phase, w.phase_index, w.phase_count])).toEqual([['orphans', 0, 2], ['purge', 1, 2]]);
    expect(typeof writes[0]!.started_at).toBe('string');
    expect(await storedProgress(id)).toMatchObject({ phase: 'purge', phase_index: 1, phase_count: 2 });
  }), 60_000);

  test('autopilot-global-maintenance writes each maintenance phase it starts', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { ctx, writes, id } = await claimed('autopilot-global-maintenance', { phases: ['orphans', 'purge'], repoPath: brain });
    await makeAutopilotGlobalMaintenanceHandler(engine)(ctx);
    expect(writes.map(w => [w.phase, w.phase_index, w.phase_count])).toEqual([['orphans', 0, 2], ['purge', 1, 2]]);
    expect(await storedProgress(id)).toMatchObject({ phase: 'purge', phase_index: 1, phase_count: 2 });
  }), 60_000);

  test('a classic sync job writes the sync phases it reaches', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brain]);
    const { ctx, writes, id } = await claimed('sync', { sourceId: 'default', repoPath: brain, pull: false, auto_embed_backfill: false });
    await makeSyncHandler(engine)(ctx);
    const phases = writes.map(w => w.phase);
    expect(phases[0]).toBe('resolve_repo');
    expect(phases.some(p => p === 'full_import' || p === 'import')).toBe(true);
    expect((await storedProgress(id))?.phase).toBe(phases.at(-1));
  }), 60_000);

  test('a progress write that throws never fails the job', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { ctx } = await claimed('autopilot-cycle', { phases: ['orphans'] });
    ctx.updateProgress = async () => { throw new Error('progress store unavailable'); };
    const result = await makeAutopilotCycleHandler(engine)(ctx) as { report: CycleReport };
    expect(result.report.phases.map(p => [p.phase, p.status === 'fail'])).toEqual([['orphans', false]]);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brain]);
    const sync = await claimed('sync', { sourceId: 'default', repoPath: brain, pull: false, auto_embed_backfill: false });
    sync.ctx.updateProgress = async () => { throw new Error('progress store unavailable'); };
    await expect(makeSyncHandler(engine)(sync.ctx)).resolves.toBeDefined();
  }), 60_000);
});
