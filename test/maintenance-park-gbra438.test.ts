/**
 * GBRA-438 PR 2: the give-up rule for budgeted (serve) upkeep runs
 * (src/core/maintenance/run.ts UPKEEP_PARK_AFTER_SLICES).
 *
 * 1. Protects: a work item that starts and does not finish in
 *    UPKEEP_PARK_AFTER_SLICES budgeted slices is parked, the items behind it
 *    run and the round finishes, so the idle serve goes quiet until the next
 *    round instead of restarting the same item forever. --status and doctor
 *    name the parked item; an unbudgeted run (gbrain maintain --unattended)
 *    finishes it and clears it; retryParked (a serve's first idle run) gives
 *    it exactly one more set of slices.
 * 2. Fails when: a slow item is retried without bound, blocks the items
 *    behind it, keeps the serve doing upkeep work after the round, is
 *    reported as ok, or stays parked after a full run finished it.
 * 3. Real seams: a real PGLite brain whose default source is too large for
 *    the budget (the extract_facts walk alone outlasts it); runCycle runs for
 *    real and is only counted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle, type CycleOpts, type CycleReport } from '../src/core/cycle.ts';
import { UPKEEP_PARK_AFTER_SLICES, readUpkeepRecord, runUnattendedMaintenance, type SafePhaseProviders } from '../src/core/maintenance/run.ts';
import { runIdleUpkeep } from '../src/core/maintenance/idle.ts';
import { readUpkeepStatus } from '../src/core/maintenance/status.ts';
import { checkUnattendedMaintenance } from '../src/commands/doctor/checks/unattended-maintenance.ts';
import { runMaintain } from '../src/commands/maintain.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

const KEYLESS: SafePhaseProviders = { embedding: false, decideConflict: false, fenceRepairModel: false, contentRepairModel: false };
const BUDGET_MS = 250;
const PAGES = 2000;

describe('budgeted upkeep parks an item that cannot finish inside its slices (PGLite, repo-less)', () => {
  let engine: BrainEngine;
  const calls: string[] = [];
  const counted = (e: BrainEngine | null, o: CycleOpts) => { calls.push(o.sourceId ?? 'global'); return runCycle(e, o); };
  const slice = (extra: { retryParked?: boolean } = {}) =>
    runIdleUpkeep(engine, { runner: 'serve', signal: new AbortController().signal, providers: KEYLESS, budgetMs: BUDGET_MS, cycle: counted, ...extra });

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (let i = 0; i < PAGES; i++) {
      await engine.putPage(`bulk/p${i}`, { type: 'concept', title: `P${i}`, compiled_truth: `P${i} relies on [[bulk/p${(i + 1) % PAGES}]].` });
    }
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('zz-small', 'zz-small')");
    for (let i = 0; i < 3; i++) await engine.putPage(`small/s${i}`, { type: 'concept', title: `S${i}`, compiled_truth: `S${i} is a plain page.` }, { sourceId: 'zz-small' });
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
    _resetCliExitVerdictForTests();
    process.exitCode = 0;
  });

  test('the slow source parks, the source behind it runs, the round finishes and the serve goes quiet; status, doctor, retry and a full run follow', async () => {
    // (i) + (ii): slices until the round finishes.
    let finished = null as Awaited<ReturnType<typeof slice>>;
    const sliceSteps: NonNullable<NonNullable<typeof finished>['record']>['steps'] = [];
    for (let n = 0; n < UPKEEP_PARK_AFTER_SLICES + 10 && !finished; n++) {
      const outcome = await slice();
      sliceSteps.push(...outcome?.record?.steps ?? []);
      if (outcome?.record && outcome.record.cursor === null) finished = outcome;
    }
    expect(finished).not.toBeNull();
    const record = (await readUpkeepRecord(engine))!;
    expect(record.cursor).toBeNull();
    expect(record.parked).toEqual([{ key: 'source:default', since: expect.any(String), slices: UPKEEP_PARK_AFTER_SLICES }]);
    expect(calls.filter((c) => c === 'default')).toHaveLength(UPKEEP_PARK_AFTER_SLICES);
    expect(calls).toContain('zz-small');
    expect(sliceSteps.filter((s) => s.reason === 'parked')).toEqual([{ name: 'cycle', scope: 'default', status: 'skipped', reason: 'parked' }]);
    expect(sliceSteps.some((s) => s.scope === 'zz-small' && s.name === 'extract_facts' && s.status === 'ok')).toBe(true);
    expect(Date.parse(record.next_due_at)).toBeGreaterThan(Date.now());

    // (iii): the next idle runs do nothing: no cycle call, no record write.
    const before = JSON.stringify(await readUpkeepRecord(engine));
    calls.length = 0;
    for (let n = 0; n < 3; n++) expect(await slice()).toBeNull();
    expect(await runUnattendedMaintenance(engine, { runner: 'serve', budgetMs: BUDGET_MS, providers: KEYLESS, cycle: counted })).toMatchObject({ status: 'not_due' });
    expect(calls).toEqual([]);
    expect(JSON.stringify(await readUpkeepRecord(engine))).toBe(before);

    // (iv): --status (text and JSON) and doctor name the parked item and warn.
    const status = await readUpkeepStatus(engine);
    expect(status.state).toBe('parked');
    expect(status.parked).toEqual(record.parked!);
    expect(status.message).toContain(`parked source:default after ${UPKEEP_PARK_AFTER_SLICES} slices`);
    expect(status.message).toContain('gbrain maintain --unattended');
    const check = await checkUnattendedMaintenance(engine);
    expect(check).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'maintain', '--unattended'] },
      details: { state: 'parked', parked: record.parked, alternative_fix: { argv: ['gbrain', 'maintain', '--schedule'] } } });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      await runMaintain(engine, ['--status']);
      await runMaintain(engine, ['--status', '--json']);
    } finally {
      console.log = log;
    }
    expect(lines.join('\n')).toContain(`Parked: source:default since ${record.parked![0]!.since} (${UPKEEP_PARK_AFTER_SLICES} slices)`);
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ state: 'parked', parked: record.parked });

    // (vi): a serve's first idle run (retryParked) gives it exactly one more set of slices, then it parks again.
    const dueAt = record.next_due_at;
    calls.length = 0;
    expect(await slice({ retryParked: true })).not.toBeNull();
    for (let n = 0; n < UPKEEP_PARK_AFTER_SLICES + 10; n++) if (!await slice()) break;
    expect(calls).toEqual(Array(UPKEEP_PARK_AFTER_SLICES).fill('default'));
    const retried = (await readUpkeepRecord(engine))!;
    expect(retried.cursor).toBeNull();
    expect(retried.parked).toEqual([{ key: 'source:default', since: record.parked![0]!.since, slices: 2 * UPKEEP_PARK_AFTER_SLICES }]);
    expect(retried.next_due_at).toBe(dueAt);
    expect(await slice()).toBeNull();

    // (v): an unbudgeted run (gbrain maintain --unattended) finishes the parked item and clears it.
    calls.length = 0;
    const full = await runUnattendedMaintenance(engine, { runner: 'cli', providers: KEYLESS, cycle: counted });
    expect(full).toMatchObject({ status: 'ran', exit: 0 });
    expect(calls).toEqual(['default']);
    const cleared = (await readUpkeepRecord(engine))!;
    expect(cleared.cursor).toBeNull();
    expect(cleared.parked ?? []).toEqual([]);
    expect(cleared.steps.some((s) => s.scope === 'default' && s.name === 'extract_facts' && s.status === 'ok')).toBe(true);
    expect((await readUpkeepStatus(engine)).state).toBe('ok');
  }, 180_000);
});

describe('parking counts only the budget, and a new round tries a parked item again (PGLite, counted fake cycle)', () => {
  let engine: BrainEngine;
  const ok = { status: 'ok', phases: [] } as unknown as CycleReport;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a tool call that stops a slice never counts toward parking', async () => {
    for (let n = 0; n < UPKEEP_PARK_AFTER_SLICES + 5; n++) {
      const foreground = new AbortController();
      await runUnattendedMaintenance(engine, {
        runner: 'serve', budgetMs: 60_000, signal: foreground.signal, providers: KEYLESS,
        cycle: async (_e, o) => {
          if (o.sourceId !== 'default') return ok;
          foreground.abort();
          throw new Error('stopped by a request');
        },
      });
    }
    const record = (await readUpkeepRecord(engine))!;
    expect(record.parked ?? []).toEqual([]);
    expect(record.cursor?.attempts?.['source:default']).toBeUndefined();
  });

  test('a new round gives a parked item a fresh set of slices', async () => {
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'maintenance.%'");
    const calls: string[] = [];
    const slow = async (_e: BrainEngine | null, o: CycleOpts): Promise<CycleReport> => {
      calls.push(o.sourceId ?? 'global');
      if (o.sourceId !== 'default') return ok;
      if (!o.signal!.aborted) await new Promise<void>((resolve) => o.signal!.addEventListener('abort', () => resolve()));
      throw new Error('stopped by the budget');
    };
    const slice = (now?: Date) => runUnattendedMaintenance(engine, {
      runner: 'serve', budgetMs: 5, signal: new AbortController().signal, providers: KEYLESS, cycle: slow, ...(now ? { now: () => now } : {}),
    });
    for (let n = 0; n < UPKEEP_PARK_AFTER_SLICES + 5; n++) {
      await slice();
      if ((await readUpkeepRecord(engine))?.cursor === null) break;
    }
    const parked = (await readUpkeepRecord(engine))!;
    expect(parked.parked).toEqual([{ key: 'source:default', since: expect.any(String), slices: UPKEEP_PARK_AFTER_SLICES }]);
    calls.length = 0;
    await slice(new Date(Date.parse(parked.next_due_at) + 60_000));
    expect(calls).toContain('default');
    expect((await readUpkeepRecord(engine))!.cursor?.attempts?.['source:default']).toBe(1);
  });
});
