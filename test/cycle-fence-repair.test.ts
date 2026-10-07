/**
 * #6188 `fence_repair` maintenance phase (src/core/cycle/fence-repair.ts).
 *
 * Protects: the global maintenance lane repairs fences on its own, bounded and
 * honest. `fences.repair.enabled false` pauses it without calling the kind; the
 * run's deadline is min(300 s, a third of the maintenance job's remaining time)
 * all the way from the job handler; a run past its deadline stops with
 * `time_budget` and the next run resumes after the last committed item; the
 * report carries the kind's verification (candidates, repairs per tier, held
 * by reason, model spend, oldest hold age, USD per model repair) and says when
 * Tier 3 is off; a non-time stop or an internal error reports `warn` with the
 * next step and no error text; the phase is brain-global, after sync, and never
 * in a per-source freshness payload.
 * Fails when: the enabled gate is dropped, the budget formula or its plumbing
 * changes, the phase drops the kind's stop or verification, an error fails the
 * cycle or leaks its message, or the phase lands in a per-source lane.
 * Why new: runRepair's own tests cover the cursor and the time_budget stop for
 * direct callers; nothing covered the cycle wrapper, its gate, its budget or its
 * place in the scheduling lists. The managed phase matrix runs the real kind
 * once per engine (Postgres arm there).
 * Seams: the repair runner's existing `registry` stub-spec seam, which the phase
 * passes through (production passes none); `now` pins the deadline arithmetic;
 * bun's setSystemTime moves the clock past the deadline inside a stub apply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { dispatchGlobalMaintenance, dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { ALL_PHASES, GLOBAL_PHASES, MAINTENANCE_PHASES, PHASE_SCOPE, SOURCE_FRESHNESS_PHASES, SOURCE_PHASES, normalizeQueuedSourcePhases } from '../src/core/cycle.ts';
import { CONNECTOR_SOURCE_PHASES } from '../src/core/cycle/phase-scope.ts';
import { MANAGED_PHASE_TABLE } from '../src/core/cycle/phase-table.ts';
import { FENCE_REPAIR_PHASE_BUDGET_MS, runFenceRepairPhase } from '../src/core/cycle/fence-repair.ts';
import { afterCursor, type RepairCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlanOptions } from '../src/core/repair/core.ts';
import type { RepairKindSpec } from '../src/core/repair/registry.ts';
import type { FenceRepairVerification } from '../src/core/repair/fences.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

interface Stub {
  spec: RepairKindSpec;
  plans: Array<{ after: RepairCursor | null; opts?: RepairPlanOptions }>;
  applied: Array<{ id: number; deadline?: number }>;
}

/** A stub `fences` kind over `count` items that honors the core's resume cursor, like the real kind's plan. */
function stubKind(count: number, behavior: {
  onApply?: (item: RepairItem) => Partial<RepairItemOutcome> | void;
  plan?: () => never;
  verification?: Partial<FenceRepairVerification>;
} = {}): Stub {
  const items: RepairItem[] = Array.from({ length: count }, (_, id) => ({ cursor: { phase: 0, id }, source_id: 'default',
    slug: `people/alice-example-${id}`, chars: 10, action: 'repair' }));
  const stub: Stub = { plans: [], applied: [], spec: undefined as never };
  const handler: RepairHandler = {
    kind: 'fences', publication: 'projection', embeds: false,
    async plan(_engine, _scope, after, opts) {
      stub.plans.push({ after, opts });
      behavior.plan?.();
      return { items: items.filter(item => afterCursor(item.cursor, after)), residuals: {}, llm: { usd: 0, cap_remaining_usd: 1 }, scan: { fresh_at: null, partial: false } };
    },
    async apply(_ctx, item, opts) {
      stub.applied.push({ id: item.cursor.id, deadline: opts?.deadline });
      return { applied: true, outcome: 'repaired', detail: { tier: 'deterministic' }, ...behavior.onApply?.(item) };
    },
    ...(behavior.verification ? { async report() { return { repaired: stub.applied.length, verification: behavior.verification as Record<string, unknown> }; } } : {}),
  };
  stub.spec = { kind: 'fences', handler, summary: 'stub', embeds: 'none', checks: ['fence_integrity'], preview_bound: true, spends: 'llm' };
  return stub;
}

describe('fence_repair phase gates and budget', () => {
  test('fences.repair.enabled false skips the phase and never calls the kind', async () => {
    const stub = stubKind(2);
    await engine.setConfig('fences.repair.enabled', 'false');
    const paused = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] });
    expect(paused.status).toBe('skipped');
    expect(paused.details.reason).toBe('disabled');
    expect(paused.summary).toContain('nothing was repaired');
    expect(paused.summary).toContain('gbrain config set fences.repair.enabled true');
    expect(stub.plans).toHaveLength(0);
    expect(stub.applied).toHaveLength(0);

    await engine.setConfig('fences.repair.enabled', 'true');
    const resumed = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] });
    expect(resumed.status).toBe('ok');
    expect(stub.applied.map(a => a.id)).toEqual([0, 1]);
  });

  test('the deadline is min(300 s, a third of the remaining job deadline), 300 s without a job deadline', async () => {
    const t = Date.now();
    const cases: Array<[number | null, number]> = [[t + 600_000, 200_000], [t + 3_600_000, FENCE_REPAIR_PHASE_BUDGET_MS], [null, FENCE_REPAIR_PHASE_BUDGET_MS]];
    for (const [deadlineAtMs, budget] of cases) {
      const stub = stubKind(1);
      const result = await runFenceRepairPhase(engine, { dryRun: false, deadlineAtMs, registry: [stub.spec], now: () => t });
      expect(result.details.time_budget_ms).toBe(budget);
      expect(stub.plans[0]?.opts?.deadline).toBe(t + budget);
      expect(stub.applied[0]?.deadline).toBe(t + budget);
    }
    const stub = stubKind(1);
    const late = await runFenceRepairPhase(engine, { dryRun: false, deadlineAtMs: t, registry: [stub.spec], now: () => t });
    expect(late).toMatchObject({ status: 'skipped', details: { reason: 'deadline' } });
    expect(stub.plans).toHaveLength(0);
  });

  test('a run past its deadline stops with time_budget, and the next run resumes after the last committed item', async () => {
    const stub = stubKind(3, { onApply: item => { if (item.cursor.id === 0) setSystemTime(new Date(Date.now() + FENCE_REPAIR_PHASE_BUDGET_MS + 1_000)); } });
    let first;
    try { first = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] }); }
    finally { setSystemTime(); }
    expect(first.status).toBe('ok');
    expect(first.details).toMatchObject({ stopped_reason: 'time_budget', complete: false, repaired: 1 });
    expect(first.summary).toContain('the next maintenance run resumes');
    expect(stub.applied.map(a => a.id)).toEqual([0]);

    const second = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] });
    expect(stub.plans[1]?.after).toEqual({ phase: 0, id: 0 });
    expect(stub.applied.map(a => a.id)).toEqual([0, 1, 2]);
    expect(second.details).toMatchObject({ stopped_reason: null, complete: true });
  });

  test('a dry run previews the kind and writes nothing', async () => {
    const stub = stubKind(2);
    const result = await runFenceRepairPhase(engine, { dryRun: true, registry: [stub.spec] });
    expect(result.details).toMatchObject({ mode: 'dry_run', candidates: 2, repaired: 0 });
    expect(result.summary).toContain('dry run: 2 fence candidate(s) planned, nothing written');
    expect(stub.applied).toHaveLength(0);
  });
});

describe('fence_repair phase report', () => {
  test('aggregates the kind verification, spend and hold age, and says when Tier 3 is off', async () => {
    const t = Date.now();
    const stub = stubKind(2, {
      onApply: item => item.cursor.id === 1 ? { llm_usd: 0.012, detail: { tier: 'llm' } } : undefined,
      verification: { candidates: 5, repaired_by_tier: { deterministic: 1, resolver: 0, llm: 1 }, held_by_reason: { holder_unresolved: 1, llm_disabled: 1, missing_begin: 1 },
        oldest_hold_at: new Date(t - 26 * 3_600_000).toISOString(), llm_repairs: 1, llm_usd_per_repair: 0.012, partial: false },
    });
    await engine.setConfig('fences.repair.llm', 'false');
    const result = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec], now: () => t });
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({
      mode: 'apply', candidates: 5, repaired: 2, repaired_by_tier: { deterministic: 1, resolver: 0, llm: 1 },
      held_by_reason: { holder_unresolved: 1, llm_disabled: 1, missing_begin: 1 }, llm_usd: 0.012, llm_usd_per_repair: 0.012, llm_repairs: 1,
      oldest_hold_age_hours: 26, llm_enabled: false, scan_partial: false, stopped_reason: null,
    });
    expect(result.summary).toContain('repaired 2 of 5 fence candidate(s) (deterministic 1, resolver 0, model 1; $0.0120 on the model, $0.0120 per model repair)');
    expect(result.summary).toContain('3 still held (holder_unresolved 1, llm_disabled 1, missing_begin 1)');
    expect(result.summary).toContain('the oldest unresolved hold is 26 h old');
    expect(result.summary).toContain('Model (Tier 3) repair is off (fences.repair.llm false): 1 fence(s) wait for it');
    expect(result.summary).toContain('gbrain config set fences.repair.llm true');
    expect(result.summary).toContain('1 need a manual edit');
    expect((result.details.fix as { argv?: string[] }).argv).toEqual(['gbrain', 'repair', 'fences']);
  });

  test('a stop other than the time budget reports warn with the kind fix', async () => {
    const fix = { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<n>'], consent: ['paid' as const], actor: 'user' as const, why: 'cap', requires_exclusive: false };
    const stub = stubKind(3, { onApply: () => ({ stop: { reason: 'budget_exhausted', message: 'The daily fence repair cap is spent.', fix } }) });
    const result = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] });
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ stopped_reason: 'budget_exhausted', fix });
    expect(result.summary).toContain('Stopped (budget_exhausted): The daily fence repair cap is spent.');
    expect(stub.applied).toHaveLength(1);
  });

  test('an internal error is contained as warn without its message; an aborted cycle still propagates', async () => {
    const failing = stubKind(1, { plan: () => { throw new OperationError('database_error' as never, 'boom SENTINEL-CELL-VALUE'); } });
    const result = await runFenceRepairPhase(engine, { dryRun: false, registry: [failing.spec] });
    expect(result).toMatchObject({ status: 'warn', details: { reason: 'error', code: 'database_error' } });
    expect(JSON.stringify(result)).not.toContain('SENTINEL-CELL-VALUE');
    expect(result.summary).toContain('gbrain repair fences');

    const controller = new AbortController();
    controller.abort();
    await expect(runFenceRepairPhase(engine, { dryRun: false, registry: [failing.spec], signal: controller.signal })).rejects.toThrow('SENTINEL-CELL-VALUE');
  });
});

describe('fence_repair scheduling lanes', () => {
  test('brain-global, right after sync, classified writes, never a source or freshness phase', () => {
    expect(PHASE_SCOPE.fence_repair).toBe('global');
    expect(ALL_PHASES.indexOf('fence_repair')).toBe(ALL_PHASES.indexOf('sync') + 1);
    expect(GLOBAL_PHASES).toContain('fence_repair');
    expect(MAINTENANCE_PHASES).toContain('fence_repair');
    expect(SOURCE_PHASES).not.toContain('fence_repair');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('fence_repair');
    expect(CONNECTOR_SOURCE_PHASES).not.toContain('fence_repair');
    expect(MANAGED_PHASE_TABLE.fence_repair.class).toBe('writes');
    expect(normalizeQueuedSourcePhases(['sync', 'fence_repair'], 'repo-a')).toEqual({ phases: ['sync'], rejected: ['fence_repair'] });
  });

  test('per-source payloads never carry fence_repair; the global maintenance payload does', async () => {
    const added: Array<{ name: string; data: { phases: string[] } }> = [];
    const fake = { kind: 'postgres' as const, listAllSources: async () => [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }],
      getConfig: async () => null, executeRaw: async () => [] } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: { phases: string[] }) => { added.push({ name, data }); return { id: added.length }; } } as never;
    await dispatchPerSource(fake, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {} });
    await dispatchGlobalMaintenance(fake, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, jsonMode: true, emit: () => {}, log: () => {} });
    const perSource = added.filter(job => job.name === 'autopilot-cycle');
    expect(perSource).toHaveLength(2);
    for (const job of perSource) expect(job.data.phases).not.toContain('fence_repair');
    expect(added.find(job => job.name === 'autopilot-global-maintenance')?.data.phases).toContain('fence_repair');
  });

  test('the maintenance job hands its deadline to the phase; a queued per-source payload drops it', async () => {
    const handlers = new Map<string, (job: unknown) => Promise<any>>();
    await registerBuiltinHandlers({ register(name: string, fn: (job: unknown) => Promise<any>) { handlers.set(name, fn); } } as never, engine);
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-fence-repair-maintenance-'));
    const startedAt = Date.now();
    const maintenance = await handlers.get('autopilot-global-maintenance')!({ id: 6188, data: { phases: ['fence_repair'], repoPath }, signal: undefined,
      deadlineAtMs: startedAt + 600_000 });
    const phase = maintenance.report.phases.find((p: { phase: string }) => p.phase === 'fence_repair');
    expect(phase?.status).toBe('ok');
    expect(phase?.details.mode).toBe('apply');
    expect(phase?.details.time_budget_ms).toBeGreaterThan(190_000);
    expect(phase?.details.time_budget_ms).toBeLessThanOrEqual(200_000);

    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, NULL)', ['repo-a']);
    const perSource = await handlers.get('autopilot-cycle')!({ data: { source_id: 'repo-a', phases: ['sync', 'fence_repair'], pull: false }, signal: undefined });
    expect(perSource.phases_rejected_by_normalization).toEqual(['fence_repair']);
    expect(perSource.report.phases.map((p: { phase: string }) => p.phase)).not.toContain('fence_repair');
  });
});
