/**
 * #6188 PR3: paid chat model (LLM) cost surfaces of `gbrain repair` and how a
 * `spends: 'llm'` repair step composes with the `doctor --remediate` budget.
 *
 * Protects: a `spends: 'llm'` kind's dry run reports its model estimate and
 * what is left under its cap (`cost.llm_usd`, `cost.llm_cap_remaining_usd`)
 * while other kinds' results keep their shape; the remediation plan counts the
 * model estimate in `paid` and `est_usd_cost` (null when unpriced); a step
 * whose estimate exceeds the remaining cap never starts; an apply stops with
 * `budget_exhausted` once its allowance is used up and resumes when rerun;
 * under `doctor --remediate` the second of two individually affordable LLM
 * steps gets only what the first left and stops at the cap; an effect kind's
 * embedding reservation is charged once, never the LLM estimate; model spend
 * the run's own tracker metered is not counted again, and spend it did not
 * meter is still counted.
 * Fails when: the allowance is not passed down or not enforced, the LLM
 * estimate is reserved up front or ignored by the cap check, reconciliation
 * double-counts or drops model spend, or llm keys leak onto other kinds.
 * Why new: no registered kind spends on a model yet (the fences kind is PR4),
 * so no existing test reaches these paths.
 * Seams: the `registry` parameter of repairRunner, planRepairSteps,
 * runRepairSteps and runRemediation's `repairs`, which registers stub specs;
 * production callers use the registered kinds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, getCurrentBudgetTracker, resetGateway } from '../src/core/ai/gateway.ts';
import { afterCursor, resolveRepairScope, type RepairHandler, type RepairKind } from '../src/core/repair/core.ts';
import { repairMaySpend, repairRunner, repairSpec, type RepairKindSpec } from '../src/core/repair/registry.ts';
import { planRepairSteps, runRepairSteps } from '../src/core/remediation/repairs.ts';
import { runRemediation } from '../src/core/remediation/run.ts';
import { repairStepFix } from '../src/commands/doctor/remediate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-llm-cost-'));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: undefined }, fn);

/**
 * A stub `spends: 'llm'` kind: `items` pages, each spending `perItemUsd` on a model but never more than the
 * allowance it is handed (a kind caps its own reservation at it). `meter` records the call on the ambient
 * budget tracker, as a gateway call would.
 */
function llmKind(name: string, opts: { items: number; perItemUsd: number; estimate: number | null; capRemaining?: number | null;
  embeds?: RepairKindSpec['embeds']; chars?: number; meter?: boolean }) {
  const allowances: Array<number | undefined> = [];
  const kind = name as RepairKind;
  const handler: RepairHandler = {
    kind,
    publication: 'projection',
    async plan(_engine, _scope, after) {
      const items = Array.from({ length: opts.items }, (_, i) => ({ cursor: { phase: 0, id: i + 1 }, source_id: 'default', slug: `${name}/page-${i + 1}`,
        chars: opts.chars ?? 0, action: 'rewrite the fence (stub)' })).filter(item => afterCursor(item.cursor, after));
      return { items, residuals: {}, llm: { usd: opts.estimate, cap_remaining_usd: opts.capRemaining ?? null } };
    },
    async apply(_ctx, _item, applyOpts) {
      allowances.push(applyOpts?.llmAllowanceUsd);
      if (opts.meter) {
        const tracker = getCurrentBudgetTracker()!;
        const before = tracker.totalSpent;
        tracker.record({ modelId: 'anthropic:claude-sonnet-5', inputTokens: 100_000, outputTokens: 10_000 });
        return { applied: true, outcome: 'repaired', llm_usd: tracker.totalSpent - before };
      }
      const allowance = applyOpts?.llmAllowanceUsd;
      return { applied: true, outcome: 'repaired', llm_usd: allowance === undefined ? opts.perItemUsd : Math.min(opts.perItemUsd, allowance) };
    },
  };
  const spec: RepairKindSpec = { kind, handler, summary: 'stub paid-model kind', embeds: opts.embeds ?? 'none', checks: [], spends: 'llm' };
  return { spec, allowances };
}

describe('gbrain repair cost surfaces for a spends:llm kind', () => {
  test('a dry run reports the model estimate and the cap left; other kinds carry no llm keys', async () => {
    await inHome(async () => {
      const stub = llmKind('llm-stub', { items: 2, perItemUsd: 0.25, estimate: 0.5, capRemaining: 2 });
      const scope = await resolveRepairScope(engine);
      const runner = await repairRunner(engine, { apply: false, logger: quiet, registry: [stub.spec] });
      const preview = await runner.run(stub.spec.kind, scope);
      expect(preview.cost).toMatchObject({ llm_usd: 0.5, llm_cap_remaining_usd: 2 });
      // A run allowance below the daily cap is what is left.
      expect((await runner.run(stub.spec.kind, scope, { maxLlmUsd: 0.75 })).cost.llm_cap_remaining_usd).toBe(0.75);
      expect(stub.allowances).toEqual([]);
      expect(repairMaySpend(stub.spec)).toBe(true);
      expect(repairMaySpend({ ...stub.spec, spends: undefined })).toBe(false);

      const unpriced = llmKind('llm-unpriced', { items: 1, perItemUsd: 0.25, estimate: null });
      const cost = (await (await repairRunner(engine, { apply: false, logger: quiet, registry: [unpriced.spec] })).run(unpriced.spec.kind, scope)).cost;
      expect(cost).toMatchObject({ llm_usd: null, llm_cap_remaining_usd: null });

      const registered = await (await repairRunner(engine, { apply: false, logger: quiet })).run('planner-stats', scope);
      expect('llm_usd' in registered.cost).toBe(false);
      expect('llm_cap_remaining_usd' in registered.cost).toBe(false);
      expect(repairSpec('planner-stats').spends).toBeUndefined();
    });
  });

  test('an apply stops with budget_exhausted once its allowance is used up and the same command resumes it', async () => {
    await inHome(async () => {
      const stub = llmKind('llm-stub', { items: 3, perItemUsd: 0.25, estimate: 0.75, capRemaining: 2 });
      const scope = await resolveRepairScope(engine);
      const runner = await repairRunner(engine, { apply: true, logger: quiet, registry: [stub.spec] });
      const stopped = await runner.run(stub.spec.kind, scope, { maxLlmUsd: 0.5 });
      expect(stub.allowances).toEqual([0.5, 0.25]);
      expect(stopped).toMatchObject({ applied: 2, complete: false, stopped: { reason: 'budget_exhausted' },
        cost: { llm_usd: 0.5, llm_cap_remaining_usd: 0 } });
      expect(stopped.stopped!.message).toContain('$0.5000 spent of $0.5000');
      expect(stopped.stopped!.message).toContain(stopped.apply_command);

      const resumed = await runner.run(stub.spec.kind, scope, { maxLlmUsd: 0.5 });
      expect(resumed).toMatchObject({ applied: 1, complete: true, resumed_from: { phase: 0, id: 2 }, cost: { llm_usd: 0.25, llm_cap_remaining_usd: 0.25 } });
      expect(resumed.stopped).toBeUndefined();
    });
  });
});

describe('remediation plan and run with a spends:llm step', () => {
  test('the plan counts the model estimate in paid and est_usd_cost, and an unpriced model makes the estimate null', async () => {
    await inHome(async () => {
      const priced = llmKind('llm-a', { items: 1, perItemUsd: 0.25, estimate: 0.25 });
      const unpriced = llmKind('llm-b', { items: 1, perItemUsd: 0.25, estimate: null });
      const steps = await planRepairSteps(engine, { registry: [priced.spec, unpriced.spec] });
      expect(steps).toEqual([
        expect.objectContaining({ kind: 'llm-a', paid: true, llm_usd: 0.25, est_usd_cost: 0.25 }),
        expect.objectContaining({ kind: 'llm-b', paid: true, llm_usd: null, est_usd_cost: null }),
      ]);
      expect(repairStepFix(steps[0]!).why).toContain('may spend about $0.2500 on a paid chat model');
      expect(repairStepFix(steps[1]!).why).toContain('may call a paid chat model (price unknown)');

      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      try {
        const effect = llmKind('llm-effect', { items: 1, perItemUsd: 0.25, estimate: 0.25, embeds: 'effect', chars: 3_500_000 });
        const [step] = await planRepairSteps(engine, { registry: [effect.spec] });
        const embedding = (await (await repairRunner(engine, { apply: false, logger: quiet, registry: [effect.spec] })).run(effect.spec.kind, await resolveRepairScope(engine))).cost.embedding_usd!;
        expect(embedding).toBeGreaterThan(0);
        expect(step).toMatchObject({ paid: true, llm_usd: 0.25 });
        expect(step!.est_usd_cost).toBeCloseTo(embedding + 0.25, 12);
      } finally { resetGateway(); }
    });
  });

  test('a step whose estimate exceeds the remaining cap is refused before its kind runs (--max-usd 0.01)', async () => {
    await inHome(async () => {
      const stub = llmKind('llm-stub', { items: 1, perItemUsd: 0.25, estimate: 0.25 });
      const unpriced = llmKind('llm-unpriced', { items: 1, perItemUsd: 0.25, estimate: null });
      const registry = [stub.spec, unpriced.spec];
      const steps = await planRepairSteps(engine, { registry });
      const results = await runRepairSteps(engine, steps, { remote: false, remainingUsd: () => 0.01, registry });
      expect(results.map(r => r.status)).toEqual(['budget_refused', 'budget_refused']);
      expect(results[0]!.message).toContain('estimated $0.2500 exceeds the $0.0100 remaining');
      expect(results[1]!.message).toContain('paid-model cost cannot be estimated');
      expect(stub.allowances).toEqual([]);
      expect(unpriced.allowances).toEqual([]);
    });
  });

  test('an effect kind reserves only its embedding estimate up front and settles its actual model spend after the step', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    try {
      await inHome(async () => {
        const stub = llmKind('llm-effect', { items: 2, perItemUsd: 0.25, estimate: 0.25, embeds: 'effect', chars: 1_750_000 });
        const steps = await planRepairSteps(engine, { registry: [stub.spec] });
        const embedding = steps[0]!.est_usd_cost! - 0.25;
        const charges: number[] = [];
        const charged = () => charges.reduce((sum, usd) => sum + usd, 0);
        const [result] = await runRepairSteps(engine, steps, { remote: false, registry: [stub.spec],
          remainingUsd: () => 10 - charged(), charge: usd => { charges.push(usd); }, spentUsd: charged });
        expect(result).toMatchObject({ status: 'completed', applied: 2 });
        expect(charges).toHaveLength(2);
        expect(charges[0]).toBeCloseTo(embedding, 12);
        expect(charges[1]).toBe(0.5);
        // The allowance is what was left after the embedding reservation, not after the model estimate too.
        expect(stub.allowances[0]).toBeCloseTo(10 - embedding, 12);
      });
    } finally { resetGateway(); }
  });
});

describe('budget composition under doctor --remediate', () => {
  test('an inline spends:llm step gets the remaining cap as its allowance and never runs under a nested step tracker', async () => {
    await inHome(async () => {
      const stub = llmKind('llm-inline', { items: 1, perItemUsd: 0.25, estimate: 0.25, embeds: 'inline' });
      const steps = await planRepairSteps(engine, { registry: [stub.spec] });
      let budgeted = 0;
      const [result] = await runRepairSteps(engine, steps, { remote: false, registry: [stub.spec], remainingUsd: () => 3,
        stepBudget: async run => { budgeted++; return run(); } });
      expect(result).toMatchObject({ status: 'completed', applied: 1 });
      expect(budgeted).toBe(0);
      expect(stub.allowances).toEqual([3]);
    });
  });

  test('two individually affordable model steps whose actual spend exceeds the cap stop at the cap', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    try {
      await inHome(async () => {
        // A: embedding reservation plus 2 x $0.25 of model spend (above its $0.25 estimate). B: 3 x $0.25, estimate $0.25.
        const a = llmKind('llm-a', { items: 2, perItemUsd: 0.25, estimate: 0.25, embeds: 'effect', chars: 1_750_000 });
        const b = llmKind('llm-b', { items: 3, perItemUsd: 0.25, estimate: 0.25 });
        const registry = [a.spec, b.spec];
        const [planA, planB] = await planRepairSteps(engine, { registry });
        const embedding = planA!.est_usd_cost! - 0.25;
        expect(planA!.est_usd_cost).toBeLessThan(1);
        expect(planB!.est_usd_cost).toBe(0.25);

        const result = await runRemediation(engine, { targetScore: 0, maxUsd: 1, repairs: { include: true, remote: false, registry } });
        expect(result.repairs!.map(r => [r.kind as string, r.status, r.applied])).toEqual([['llm-a', 'completed', 2], ['llm-b', 'budget_exhausted', 2]]);
        expect(result.repairs![1]!.message).toContain('paid-model allowance is used up');
        // A ran with the cap minus its embedding reservation; B got exactly what A left.
        expect(a.allowances[0]).toBeCloseTo(1 - embedding, 12);
        expect(b.allowances[0]).toBeCloseTo(1 - embedding - 0.5, 12);
        expect(result.budget!.spent_usd).toBeLessThanOrEqual(1 + 1e-12);
        expect(result.budget!.spent_usd).toBeCloseTo(1, 12);
        expect(result.budget_exhausted).toMatchObject({ cap: 1, reason: 'max_usd' });
      });
    } finally { resetGateway(); }
  });

  test('model spend the run\'s tracker already metered is not counted twice; unmetered spend is still counted', async () => {
    await inHome(async () => {
      const metered = llmKind('llm-metered', { items: 1, perItemUsd: 0, estimate: 0.3, meter: true });
      const unmetered = llmKind('llm-unmetered', { items: 1, perItemUsd: 0.25, estimate: 0.25 });
      const result = await runRemediation(engine, { targetScore: 0, maxUsd: 5, repairs: { include: true, remote: false, registry: [metered.spec, unmetered.spec] } });
      expect(result.repairs!.map(r => r.status)).toEqual(['completed', 'completed']);
      // claude-sonnet-5 at $2 / $10 per MTok: 100k input + 10k output tokens is $0.30.
      expect(result.budget!.spent_usd).toBeCloseTo(0.3 + 0.25, 12);
      expect(unmetered.allowances[0]).toBeCloseTo(5 - 0.3, 12);
    });
  });
});
