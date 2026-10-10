/**
 * #6377 `content_repair` maintenance phase (src/core/cycle/content-repair.ts)
 * and the content lane it runs (src/core/repair/content-lane.ts).
 *
 * Protects: the global maintenance lane runs the rest of the content-repair
 * lane by itself, bounded and honest. With `CONTENT_REPAIR_KINDS` holding only
 * `fences` the phase runs nothing and says so (`no_kinds`); a kind handed to
 * it runs through the shared repair runner with the lane's deadline
 * (min(120 s, a third of the job's remaining time)); `fences.repair.enabled`
 * false pauses it without calling the kind; the report carries counts by
 * outcome and reason, the lane's spend and the oldest hold's age; a non-time
 * stop or an internal error reports `warn` with the next step and no error
 * text; the phase is brain-global, right after `fence_repair`, and never in a
 * per-source payload. The lane itself: every component plan is built before
 * the first mutation and each kind applies against its own hash; the paid
 * allowance flows minus the earlier kind's spend; `--expect` needs one hash
 * per kind.
 * Fails when: the enabled gate is dropped, the budget formula changes, the
 * phase hides a kind's stop, an error fails the cycle or leaks its message,
 * the lane applies before planning, or the allowance stops flowing.
 * Why new: the fence_repair test covers one kind's wrapper; nothing covered a
 * lane of kinds sharing one allowance, nor the plan-first apply.
 * Seams: the repair runner's `registry` stub-spec seam, passed through the
 * lane and the phase; `kinds` names the stub kind the phase should run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ALL_PHASES, GLOBAL_PHASES, MAINTENANCE_PHASES, PHASE_SCOPE, SOURCE_FRESHNESS_PHASES, SOURCE_PHASES, normalizeQueuedSourcePhases } from '../src/core/cycle.ts';
import { CONNECTOR_SOURCE_PHASES } from '../src/core/cycle/phase-scope.ts';
import { MANAGED_PHASE_TABLE } from '../src/core/cycle/phase-table.ts';
import { CONTENT_REPAIR_PHASE_BUDGET_MS, contentRepairPhaseKinds, runContentRepairPhase } from '../src/core/cycle/content-repair.ts';
import { CONTENT_REPAIR_HOLD_KINDS, CONTENT_REPAIR_KINDS, contentHoldDisposition, parseContentLaneExpect, runContentLane } from '../src/core/repair/content-lane.ts';
import { afterCursor, resolveRepairScope, type RepairCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairKind, type RepairPlanOptions } from '../src/core/repair/core.ts';
import type { RepairKindSpec } from '../src/core/repair/registry.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

interface Stub {
  spec: RepairKindSpec;
  plans: Array<{ apply: boolean; after: RepairCursor | null; opts?: RepairPlanOptions }>;
  applied: Array<{ id: number; deadline?: number; allowance?: number; expect?: string }>;
}

/** A stub lane kind over `count` items: preview-bound (its hash binds the selection), spends on the model, honors the resume cursor. */
function stubKind(kind: RepairKind, count: number, behavior: {
  onApply?: (item: RepairItem) => Partial<RepairItemOutcome> | void;
  plan?: () => never;
  llmUsdPerItem?: number;
  verification?: Record<string, unknown>;
} = {}): Stub {
  const items: RepairItem[] = Array.from({ length: count }, (_, id) => ({ cursor: { phase: 0, id }, source_id: 'default', slug: `people/alice-example-${id}`, chars: 10, action: 'repair',
    ...(behavior.llmUsdPerItem ? { llm_usd: behavior.llmUsdPerItem } : {}) }));
  const stub: Stub = { plans: [], applied: [], spec: undefined as never };
  let repaired = 0;
  const handler: RepairHandler = {
    kind, publication: 'projection', embeds: false,
    async plan(_engine, _scope, after, opts) {
      stub.plans.push({ apply: opts?.apply === true, after, opts });
      behavior.plan?.();
      return { items: items.filter(item => afterCursor(item.cursor, after)), residuals: {}, preview_hash: `${kind}-hash-${count}`,
        llm: { usd: items.length * (behavior.llmUsdPerItem ?? 0), cap_remaining_usd: 1 }, scan: { fresh_at: null, partial: false } };
    },
    async apply(_ctx, item, opts) {
      stub.applied.push({ id: item.cursor.id, deadline: opts?.deadline, allowance: opts?.llmAllowanceUsd, expect: opts?.expect });
      const outcome: RepairItemOutcome = { applied: true, outcome: 'repaired', detail: { tier: 'deterministic', path: `${item.slug}.md` }, ...(behavior.llmUsdPerItem ? { llm_usd: behavior.llmUsdPerItem } : {}), ...behavior.onApply?.(item) };
      if (outcome.applied) repaired++;
      return outcome;
    },
    ...(behavior.verification ? { async report() { return { repaired, verification: behavior.verification }; } } : {}),
  };
  stub.spec = { kind, handler, summary: 'stub', embeds: 'none', checks: [], preview_bound: true, spends: 'llm' };
  return stub;
}

describe('the content lane', () => {
  test('the lane runs fences then slug-conflicts; the hold table maps each hold code to its kind', () => {
    expect(CONTENT_REPAIR_KINDS).toEqual(['fences', 'slug-conflicts']);
    expect(CONTENT_REPAIR_HOLD_KINDS.invalid_fence).toBe('fences');
    expect(CONTENT_REPAIR_HOLD_KINDS.frontmatter_slug_conflict).toBe('slug-conflicts');
    expect(contentRepairPhaseKinds()).toEqual(['slug-conflicts']);
    const meta = { recovery_version: RECOVERY_VERSION };
    expect(contentHoldDisposition({ code: 'frontmatter_slug_conflict', meta })).toEqual({ action: 'repair', kind: 'slug-conflicts' });
    expect(contentHoldDisposition({ code: 'invalid_frontmatter', meta })).toEqual({ action: 'unsupported' });
    expect(contentHoldDisposition({ code: 'invalid_fence', meta: { ...meta, reason: 'holder_unresolved' } })).toEqual({ action: 'repair', kind: 'fences' });
    expect(contentHoldDisposition({ code: 'invalid_fence', meta: { ...meta, reason: 'repeated_marker' } })).toEqual({ action: 'listed', kind: 'fences', state: 'needs_human', reason: 'repeated_marker' });
    expect(contentHoldDisposition({ code: 'invalid_fence', meta: { ...meta, reason: 'no_header', fence_repair: { reason: 'budget_exhausted', tier: 'llm', at: 't', next_attempt_after: 'u' } } }))
      .toEqual({ action: 'listed', kind: 'fences', state: 'paid', reason: 'budget_exhausted' });
    expect(contentHoldDisposition({ code: 'invalid_fence', meta: { ...meta, reason: 'no_header', fence_repair: { reason: 'host_mismatch', tier: 'llm', at: 't', next_attempt_after: null } } }))
      .toEqual({ action: 'listed', kind: 'fences', state: 'owner', reason: 'host_mismatch' });
  });

  test('a dry run plans every kind, prints each kind\'s own hash and writes nothing; the apply command carries one hash per kind', async () => {
    const a = stubKind('fences', 2, { llmUsdPerItem: 0.1 }), b = stubKind('connector-fences', 1, { llmUsdPerItem: 0.1 });
    const scope = await resolveRepairScope(engine);
    const lane = await runContentLane(engine, scope, { apply: false, kinds: ['fences', 'connector-fences'], registry: [a.spec, b.spec], maxLlmUsd: 0.5, sourceFlag: 'default' });
    expect(lane.mode).toBe('dry_run');
    expect(lane.kinds).toEqual(['fences', 'connector-fences']);
    expect(lane.preview_hashes).toEqual({ fences: 'fences-hash-2', 'connector-fences': 'connector-fences-hash-1' });
    expect(lane.results.map(r => [r.kind, r.mode, r.affected, r.preview_hash])).toEqual([['fences', 'dry_run', 2, 'fences-hash-2'], ['connector-fences', 'dry_run', 1, 'connector-fences-hash-1']]);
    expect(lane.cost.llm_usd).toBeCloseTo(0.3); expect(lane.cost.llm_allowance_remaining_usd).toBeCloseTo(0.2);
    expect(lane.apply_command).toBe('gbrain repair content --source default --max-usd 0.5 --apply --expect fences-hash-2,connector-fences-hash-1');
    expect(a.applied).toHaveLength(0); expect(b.applied).toHaveLength(0);
    // The second kind's plan was built with the allowance left after the first kind's estimate.
    expect(b.plans[0]?.opts?.maxLlmUsd).toBeCloseTo(0.3);
  });

  test('a bare apply runs each kind\'s current plan in order (its own plan, its own apply, as gbrain repair <kind> --apply); the allowance flows minus the earlier spend', async () => {
    const a = stubKind('fences', 2, { llmUsdPerItem: 0.1 });
    const b = stubKind('connector-fences', 2, { llmUsdPerItem: 0.1 });
    const lane = await runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: ['fences', 'connector-fences'], registry: [a.spec, b.spec], maxLlmUsd: 0.35 });
    expect(lane.mode).toBe('apply');
    expect(a.plans.map(p => p.apply)).toEqual([true]);
    expect(b.plans.map(p => p.apply)).toEqual([true]);
    expect(a.applied.map(x => x.expect)).toEqual([undefined, undefined]);
    expect(a.applied[0]!.allowance).toBeCloseTo(0.35); expect(a.applied[1]!.allowance).toBeCloseTo(0.25);
    // fences spent 0.20; connector-fences gets 0.15, enough for one item, then stops before the second (budget_exhausted).
    expect(b.plans[0]?.opts?.maxLlmUsd).toBeCloseTo(0.15);
    expect(b.applied).toHaveLength(1);
    expect(b.applied[0]!.allowance).toBeCloseTo(0.15);
    expect(lane.preview_hashes).toEqual({ fences: null, 'connector-fences': null });
    expect(lane.stopped.map(s => [s.kind, s.reason])).toEqual([['connector-fences', 'budget_exhausted']]);
    expect(lane.cost.llm_usd).toBeCloseTo(0.3);
    expect(lane.cost.llm_allowance_remaining_usd).toBeCloseTo(0.05);
  });

  test('--expect binds each kind to the operator\'s hash in lane order, and a count that does not match the lane refuses before anything runs', async () => {
    const a = stubKind('fences', 1), b = stubKind('connector-fences', 1);
    const lane = await runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: ['fences', 'connector-fences'], registry: [a.spec, b.spec], expect: ['h1', 'h2'] });
    expect(a.plans.map(p => p.apply)).toEqual([true]);
    expect(a.applied[0]?.expect).toBe('h1'); expect(b.applied[0]?.expect).toBe('h2');
    expect(lane.preview_hashes).toEqual({ fences: 'h1', 'connector-fences': 'h2' });
    const c = stubKind('fences', 1);
    await expect(runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: ['fences', 'connector-fences'], registry: [c.spec, b.spec], expect: ['h1'] }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(c.plans).toHaveLength(0);
    expect(() => parseContentLaneExpect('h1', ['fences', 'connector-fences'], ['gbrain', 'repair', 'content'])).toThrow(OperationError);
    expect(parseContentLaneExpect('h1, h2', ['fences', 'connector-fences'], ['gbrain', 'repair', 'content'])).toEqual(['h1', 'h2']);
  });

  test('a time_budget stop in one kind ends the lane; the deadline reaches every kind', async () => {
    const t = Date.now();
    const a = stubKind('fences', 2, { onApply: item => ({ stop: item.cursor.id === 0 ? { reason: 'time_budget', message: 'out of time' } : undefined }) });
    const b = stubKind('connector-fences', 1);
    const lane = await runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: ['fences', 'connector-fences'], registry: [a.spec, b.spec], deadline: t + 1000 });
    expect(a.applied).toHaveLength(1);
    expect(a.applied[0]?.deadline).toBe(t + 1000);
    expect(b.applied).toHaveLength(0);
    expect(lane.results.map(r => r.kind)).toEqual(['fences']);
    expect(lane.stopped.map(s => s.reason)).toEqual(['time_budget']);
  });
});

describe('content_repair phase gates and budget', () => {
  test('with no lane kind beyond fences the phase runs nothing and says so', async () => {
    const result = await runContentRepairPhase(engine, { dryRun: false, kinds: [] });
    expect(result).toMatchObject({ status: 'skipped', details: { reason: 'no_kinds', kinds: [] } });
    expect(result.summary).toContain('ran nothing');
  });

  test('fences.repair.enabled false skips the phase and never calls the kind', async () => {
    const stub = stubKind('connector-fences', 2);
    await engine.setConfig('fences.repair.enabled', 'false');
    const paused = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(paused).toMatchObject({ status: 'skipped', details: { reason: 'disabled', kinds: ['connector-fences'] } });
    expect(paused.summary).toContain('gbrain config set fences.repair.enabled true');
    expect(paused.summary).toContain('gbrain repair content');
    expect(stub.plans).toHaveLength(0);
    await engine.setConfig('fences.repair.enabled', 'true');
    const resumed = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(resumed.status).toBe('ok');
    expect(stub.applied.map(a => a.id)).toEqual([0, 1]);
  });

  test('the deadline is min(120 s, a third of the remaining job deadline), 120 s without a job deadline', async () => {
    const t = Date.now();
    const cases: Array<[number | null, number]> = [[t + 180_000, 60_000], [t + 3_600_000, CONTENT_REPAIR_PHASE_BUDGET_MS], [null, CONTENT_REPAIR_PHASE_BUDGET_MS]];
    for (const [deadlineAtMs, budget] of cases) {
      const stub = stubKind('connector-fences', 1);
      const result = await runContentRepairPhase(engine, { dryRun: false, deadlineAtMs, kinds: ['connector-fences'], registry: [stub.spec], now: () => t });
      expect(result.details.time_budget_ms).toBe(budget);
      expect(stub.plans[0]?.opts?.deadline).toBe(t + budget);
      expect(stub.applied[0]?.deadline).toBe(t + budget);
    }
    const stub = stubKind('connector-fences', 1);
    const late = await runContentRepairPhase(engine, { dryRun: false, deadlineAtMs: t, kinds: ['connector-fences'], registry: [stub.spec], now: () => t });
    expect(late).toMatchObject({ status: 'skipped', details: { reason: 'deadline' } });
    expect(stub.plans).toHaveLength(0);
  });

  test('a dry run previews the kind and writes nothing', async () => {
    const stub = stubKind('connector-fences', 2);
    const result = await runContentRepairPhase(engine, { dryRun: true, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(result.details).toMatchObject({ mode: 'dry_run', candidates: 2, repaired: 0 });
    expect(result.summary).toContain('dry run: 2 content candidate(s) planned across connector-fences, nothing written');
    expect(stub.applied).toHaveLength(0);
  });
});

describe('content_repair phase report', () => {
  test('counts by kind, outcome and reason, the lane spend and the oldest hold age; needs_human holds point at sync status', async () => {
    const t = Date.now();
    const stub = stubKind('connector-fences', 3, {
      onApply: item => item.cursor.id === 0 ? { llm_usd: 0.02, detail: { tier: 'llm' } }
        : item.cursor.id === 1 ? { applied: false, outcome: 'held', reason: 'merge_recommended' } : { applied: false, outcome: 'skipped', reason: 'sync_in_progress' },
      verification: { oldest_hold_at: new Date(t - 30 * 3_600_000).toISOString() },
    });
    const result = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec], now: () => t });
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ mode: 'apply', kinds: ['connector-fences'], candidates: 3, repaired: 1, llm_usd: 0.02, oldest_hold_age_hours: 30, stopped_reason: null,
      held_by_reason: { merge_recommended: 1, sync_in_progress: 1 } });
    expect((result.details.by_kind as Record<string, { outcomes: Record<string, number> }>)['connector-fences']!.outcomes).toEqual({ repaired: 1, held: 1, skipped: 1 });
    expect(result.summary).toContain('repaired 1 of 3 content candidate(s) across connector-fences ($0.0200 on the model)');
    expect(result.summary).toContain('2 still held (merge_recommended 1, sync_in_progress 1)');
    expect(result.summary).toContain('the oldest unresolved hold is 30 h old');
    expect(result.summary).toContain('1 wait for a person: gbrain sync status');
    expect((result.details.fix as { argv?: string[] }).argv).toEqual(['gbrain', 'repair', 'content']);
  });

  test('a stop other than the time budget reports warn with the kind fix; a time-budget stop stays ok', async () => {
    const fix = { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<n>'], consent: ['paid' as const], actor: 'user' as const, why: 'cap', requires_exclusive: false };
    const stub = stubKind('connector-fences', 3, { onApply: () => ({ stop: { reason: 'budget_exhausted', message: 'The daily content repair cap is spent.', fix } }) });
    const result = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ stopped_reason: 'budget_exhausted', fix });
    expect(result.summary).toContain('Stopped (connector-fences: budget_exhausted): The daily content repair cap is spent.');
    const timed = stubKind('connector-fences', 2, { onApply: () => ({ stop: { reason: 'time_budget', message: 'out of time' } }) });
    const ok = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [timed.spec] });
    expect(ok.status).toBe('ok');
    expect(ok.details.stopped_reason).toBe('time_budget');
    expect(ok.summary).toContain('the next maintenance run resumes');
  });

  test('an internal error is contained as warn without its message; an aborted cycle still propagates', async () => {
    const failing = stubKind('connector-fences', 1, { plan: () => { throw new OperationError('database_error' as never, 'boom SENTINEL-CELL-VALUE'); } });
    const result = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [failing.spec] });
    expect(result).toMatchObject({ status: 'warn', details: { reason: 'error', code: 'database_error' } });
    expect(JSON.stringify(result)).not.toContain('SENTINEL-CELL-VALUE');
    expect(result.summary).toContain('gbrain repair content');
    const controller = new AbortController();
    controller.abort();
    await expect(runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [failing.spec], signal: controller.signal })).rejects.toThrow('SENTINEL-CELL-VALUE');
  });
});

describe('content_repair scheduling lanes', () => {
  test('brain-global, right after fence_repair, classified writes, never a source or freshness phase', () => {
    expect(PHASE_SCOPE.content_repair).toBe('global');
    expect(ALL_PHASES.indexOf('content_repair')).toBe(ALL_PHASES.indexOf('fence_repair') + 1);
    expect(GLOBAL_PHASES).toContain('content_repair');
    expect(MAINTENANCE_PHASES).toContain('content_repair');
    expect(SOURCE_PHASES).not.toContain('content_repair');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('content_repair');
    expect(CONNECTOR_SOURCE_PHASES).not.toContain('content_repair');
    expect(MANAGED_PHASE_TABLE.content_repair.class).toBe('writes');
    expect(normalizeQueuedSourcePhases(['sync', 'content_repair'], 'repo-a')).toEqual({ phases: ['sync'], rejected: ['content_repair'] });
  });
});
