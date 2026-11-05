/**
 * #8669: the actual maintenance handler must dispatch an explicitly approved source,
 * never multiply the synthesis budget by fanning out a full phase per source.
 * Existing partition tests check phase names, but never a non-default synthesis turn.
 * Uses the existing injected runCycle seam; PGLite holds real source/config metadata.
 * Wrong version: omit sourceId or loop all configured sources in one job.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { makeAutopilotGlobalMaintenanceHandler, GLOBAL_MAINTENANCE_PROGRESS_KEY } from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { runCycle } from '../src/core/cycle.ts';
import type { CycleOpts, CycleReport } from '../src/core/cycle.ts';

const key = 'autopilot.global_maintenance.synthesis_sources';
const pins = [
  { source_id: 'work-a', incarnation: '11111111-1111-4111-8111-111111111111' },
  { source_id: 'work-b', incarnation: '22222222-2222-4222-8222-222222222222' },
];
let engine: PGLiteEngine;
let emptyReport: CycleReport;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  emptyReport = await runCycle(null, { brainDir: null, phases: [], dryRun: true });
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  for (const pin of pins) await engine.executeRaw(
    `INSERT INTO sources(id, name, incarnation, config) VALUES($1,$1,$2::uuid,'{"federated":true}'::jsonb)`, [pin.source_id, pin.incarnation]);
  await engine.setConfig(key, JSON.stringify(pins));
  await engine.setConfig('dream.synthesize.budget_usd', '5');
});

function runner() {
  const calls: CycleOpts[] = [];
  const handler = makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: async (_engine, opts) => {
    calls.push(opts);
    return { ...emptyReport, brain_dir: '/tmp/synthetic-brain', status: 'ok', timestamp: new Date().toISOString(), duration_ms: 1,
      phases: [{ phase: opts.phases![0], status: 'ok', duration_ms: 1, summary: 'recorded, no model call', details: {} }] } as CycleReport;
  } });
  return { calls, run: (id: number, phases = ['synthesize']) => handler({ id, attempts_made: 0,
    data: { phases, repoPath: '/tmp/synthetic-brain' }, deadlineAtMs: null } as never) };
}

test('one approved source per job, durable rotation, unchanged other global phases and budget', async () => {
  const first = runner();
  await first.run(1, ['synthesize', 'patterns', 'embed']);
  expect(first.calls.map(c => [c.phases, c.sourceId])).toEqual([
    [['synthesize'], 'work-a'], [['patterns'], undefined], [['embed'], undefined],
  ]);
  expect(first.calls[0]).toMatchObject({ privateQueueOwnerJobId: 1, forceGlobalOrphans: true, pull: false, stampSourceCycle: false, synthesisSourceIncarnation: pins[0]!.incarnation });
  const second = runner(); // separate handler: state must survive jobs, not live in a closure
  await second.run(2);
  expect(second.calls.map(c => c.sourceId)).toEqual(['work-b']);
  const third = runner(); await third.run(3);
  expect(third.calls.map(c => c.sourceId)).toEqual(['work-a']);
  expect(await engine.getConfig('dream.synthesize.budget_usd')).toBe('5');
});

for (const invalid of ['archived', 'recreated', 'isolated', 'missing', 'malformed']) {
  test(`a ${invalid} approved source fails closed before any cycle call`, async () => {
    if (invalid === 'archived') await engine.executeRaw("UPDATE sources SET archived=true WHERE id='work-a'");
    if (invalid === 'recreated') await engine.executeRaw("UPDATE sources SET incarnation='33333333-3333-4333-8333-333333333333' WHERE id='work-a'");
    if (invalid === 'isolated') await engine.executeRaw(`UPDATE sources SET config='{"federated":false}'::jsonb WHERE id='work-a'`);
    if (invalid === 'missing') await engine.executeRaw("DELETE FROM sources WHERE id='work-a'");
    if (invalid === 'malformed') await engine.setConfig(key, '{not-json');
    const r = runner();
    await r.run(4).catch(() => undefined);
    expect(r.calls).toEqual([]);
  });
}

test('explicit empty approval list submits nothing; absent list retains legacy behavior', async () => {
  await engine.setConfig(key, '[]');
  const empty = runner(); await empty.run(5);
  expect(empty.calls).toEqual([]);
  await engine.executeRaw('DELETE FROM config WHERE key=$1', [key]);
  const legacy = runner(); await legacy.run(6);
  expect(legacy.calls).toHaveLength(1);
  expect(legacy.calls[0]!.sourceId).toBeUndefined();
});

test('a phase resume does not restart synthesis; a prior crash preserves the source cursor', async () => {
  const first = runner(); await first.run(10);
  const saved = JSON.parse((await engine.getConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY))!);
  await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ ...saved, next_phase: 'embed' }));
  const resume = runner(); await resume.run(11, ['synthesize', 'embed']);
  expect(resume.calls.map(c => c.phases)).toEqual([['embed']]);
  const next = runner(); await next.run(12);
  expect(next.calls.map(c => c.sourceId)).toEqual(['work-b']);
});


test('duplicate queued phases cannot multiply synthesis invocations', async () => {
  const r = runner(); await r.run(20, ['synthesize', 'synthesize', 'embed']);
  expect(r.calls.map(c => c.phases)).toEqual([['synthesize'], ['embed']]);
});

test('routed global synthesis never marks source freshness', async () => {
  await engine.setConfig('dream.synthesize.enabled', 'false');
  const before = await engine.executeRaw<{config: unknown}>("SELECT config FROM sources WHERE id='work-a'");
  const report = await runCycle(engine, { brainDir: '/tmp/synthetic-brain', sourceId: 'work-a',
    stampSourceCycle: false, phases: ['synthesize'], pull: false });
  expect(report.status).not.toBe('failed');
  const after = await engine.executeRaw<{config: unknown}>("SELECT config FROM sources WHERE id='work-a'");
  expect(after).toEqual(before);
});


test('a failed durable cursor write stops the routed invocation', async () => {
  const calls: CycleOpts[] = [];
  const broken = new Proxy(engine, { get(target, key) {
    if (key === 'setConfig') return async (name: string, value: string) => {
      if (name === GLOBAL_MAINTENANCE_PROGRESS_KEY && JSON.parse(value).last_synthesis_source) throw new Error('synthetic storage unavailable');
      return target.setConfig(name, value);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const handler = makeAutopilotGlobalMaintenanceHandler(broken, { runCycle: async (_e, opts) => {
    calls.push(opts); throw new Error('must not execute');
  } });
  await handler({ id: 30, attempts_made: 0, data: { phases: ['synthesize'], repoPath: '/tmp/synthetic-brain' } } as never).catch(() => undefined);
  expect(calls).toEqual([]);
});


test('a child with no corpus pin still rejects a replaced approved source before model work', async () => {
  const { refuseChangedSessionSource } = await import('../src/core/cycle/synthesize-source-routing.ts');
  const data = { source_id: 'work-a', source_incarnation: pins[0]!.incarnation };
  await engine.executeRaw("UPDATE sources SET incarnation='33333333-3333-4333-8333-333333333333' WHERE id='work-a'");
  await expect(refuseChangedSessionSource(engine, data)).rejects.toThrow('approved_source_changed');
});


test('native synthesis rejects a changed approved source before configuration or triage', async () => {
  const { runPhaseSynthesize } = await import('../src/core/cycle/synthesize.ts');
  await engine.setConfig('dream.synthesize.enabled', 'false');
  const result = await runPhaseSynthesize(engine, { brainDir: '/tmp/synthetic-brain', sourceId: 'work-a',
    sourceIncarnation: '33333333-3333-4333-8333-333333333333', dryRun: false });
  expect(result.status).toBe('fail');
  expect(JSON.stringify(result.error)).toContain('approved_source_changed');
});


test('source recreation between selection and native cycle refuses the replacement', async () => {
  await engine.setConfig('dream.synthesize.enabled', 'false');
  const handler = makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: async (nativeEngine, opts) => {
    await engine.executeRaw("UPDATE sources SET incarnation='33333333-3333-4333-8333-333333333333' WHERE id='work-a'");
    return runCycle(nativeEngine, opts);
  } });
  const result = await handler({ id: 40, attempts_made: 0,
    data: { phases: ['synthesize'], repoPath: '/tmp/synthetic-brain' } } as never) as { report: CycleReport };
  expect(result.report.phases[0]!.status).toBe('fail');
  expect(JSON.stringify(result.report.phases[0]!.error)).toContain('approved_source_changed');
});

test('shared cooldown skips retain the pending source instead of starving it by phase alignment', async () => {
  const first = runner(); await first.run(50); // work-a owns the preceding eligible turn
  const attempts: string[] = [];
  const handler = makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: async (_e, opts) => {
    attempts.push(opts.sourceId!);
    return { ...emptyReport, brain_dir: '/tmp/synthetic-brain', status: 'clean', timestamp: new Date().toISOString(), duration_ms: 1,
      phases: [{ phase: 'synthesize', status: 'skipped', duration_ms: 1,
        summary: 'shared cooldown', details: { reason: 'cooldown_active' } }] } as CycleReport;
  } });
  for (const id of [51, 52]) await handler({ id, attempts_made: 0,
    data: { phases: ['synthesize'], repoPath: '/tmp/synthetic-brain' } } as never);
  expect(attempts).toEqual(['work-b', 'work-b']);
  const eligible = runner(); await eligible.run(53);
  expect(eligible.calls.map(c => c.sourceId)).toEqual(['work-b']);
});
