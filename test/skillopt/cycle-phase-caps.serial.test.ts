/**
 * H2 (test-gap wave) — runPhaseSkillopt's flag gate + cost caps: the only
 * brake on an unattended nightly LLM spender (`gbrain dream --phase skillopt`).
 *
 * Pins, exactly as coded in src/core/skillopt/cycle-phase.ts:
 *   1. `cycle.skillopt.enabled` unset / non-'true' → status 'skipped',
 *      details.reason 'feature_flag_off', ZERO runner invocations.
 *   2. `once: true` bypasses the flag for that call only — the flag key is
 *      never written (per-skill `last_run` state IS still banked; that is
 *      re-entry bookkeeping, not the feature flag).
 *   3. Brain-wide cap boundary is `cumulativeCostUsd >= brainWideCap`,
 *      checked BEFORE each candidate runs: two $1.00 spends against a $2.00
 *      cap put cumulative exactly AT the cap, so the third candidate is
 *      skipped with reason 'brain_wide_cap_reached' (a strict `>` would have
 *      run it). Strictly below the cap ($1.99) the third still runs.
 *   4. Effective per-skill cap = Math.min(perSkillCap, brainWideCap −
 *      cumulative) — the runner receives the min, not the raw per-skill cap.
 *   5. An aborted signal breaks the loop between candidates: no further
 *      runner calls, no synthetic 'skipped' rows for the unvisited tail.
 *
 * Serial lane (isolation rule R2): cycle-phase.ts imports runSkillOpt
 * STATICALLY from ./orchestrator.ts (no injected-runner seam), so mock.module
 * is the only stub. The stub is mandatory — an unmocked run would launch a
 * real LLM optimizer. autoDetectSkillsDirReadOnly is mocked to a temp
 * fixture tree so the phase never walks the repo's real skills/.
 * cycle-phase.ts is loaded via dynamic import AFTER mock registration so the
 * static bindings resolve to the mocks.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

// ─── Fixture skills trees (benchmark file existence is all the phase reads;
//     the stubbed runner never opens them) ─────────────────────────────────
function makeSkillsDir(prefix: string, skillNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const name of skillNames) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'skillopt-benchmark.jsonl'), '{}\n');
  }
  return root;
}
const THREE_SKILLS = ['skill-a', 'skill-b', 'skill-c'];
const skills3Dir = makeSkillsDir('cycle-phase-caps-3-', THREE_SKILLS);
const skills2Dir = makeSkillsDir('cycle-phase-caps-2-', ['skill-a', 'skill-b']);
const skills1Dir = makeSkillsDir('cycle-phase-caps-1-', ['skill-a']);

// ─── Mocks (registered before cycle-phase.ts is loaded) ────────────────────
let currentSkillsDir: string = skills3Dir;
let runnerCalls: Array<Record<string, unknown>> = [];
/** Per-call reported spend, indexed by call order; missing → $0. */
let stubCosts: number[] = [];
/** Optional per-call hook (used by the abort tests). */
let onRunnerCall: ((opts: Record<string, unknown>, idx: number) => void) | null = null;

mock.module('../../src/core/skillopt/orchestrator.ts', () => ({
  runSkillOpt: async (opts: Record<string, unknown>) => {
    const idx = runnerCalls.length;
    runnerCalls.push(opts);
    onRunnerCall?.(opts, idx);
    return {
      outcome: 'accepted',
      receipt: { final_cost_usd: stubCosts[idx] ?? 0 },
      finalText: 'stub',
      mutatedSkillFile: false,
    };
  },
}));
mock.module('../../src/core/repo-root.ts', () => ({
  autoDetectSkillsDirReadOnly: () => ({ dir: currentSkillsDir, source: 'cwd_walk' }),
}));

const { runPhaseSkillopt } = await import('../../src/core/skillopt/cycle-phase.ts');

interface PhaseDetails {
  reason?: string;
  skills_scanned?: number;
  skipped_brain_wide_cap?: number;
  cumulative_cost_usd?: number;
  brain_wide_cap_usd?: number;
  per_skill_cap_usd?: number;
  results?: Array<{ skill: string; outcome: string; cost_usd: number; reason?: string }>;
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const dir of [skills3Dir, skills2Dir, skills1Dir]) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  currentSkillsDir = skills3Dir;
  runnerCalls = [];
  stubCosts = [];
  onRunnerCall = null;
});

async function enableFlag(): Promise<void> {
  await engine.setConfig('cycle.skillopt.enabled', 'true');
}

describe('runPhaseSkillopt feature-flag gate', () => {
  test('flag unset → skipped/feature_flag_off with zero runner invocations', async () => {
    const res = await runPhaseSkillopt({ engine });
    expect(res.phase).toBe('skillopt');
    expect(res.status).toBe('skipped');
    // Pin the real user-facing strings — the skip must tell the operator the
    // exact enable command.
    expect(res.summary).toBe(
      'feature flag off (gbrain config set cycle.skillopt.enabled true to enable)',
    );
    expect(res.details).toEqual({ reason: 'feature_flag_off' });
    expect(runnerCalls.length).toBe(0);
  });

  test("only the strict string 'true' enables — 'false', '1', 'TRUE' all stay off", async () => {
    for (const value of ['false', '1', 'TRUE']) {
      await engine.setConfig('cycle.skillopt.enabled', value);
      const res = await runPhaseSkillopt({ engine });
      expect(res.status).toBe('skipped');
      expect((res.details as PhaseDetails).reason).toBe('feature_flag_off');
    }
    expect(runnerCalls.length).toBe(0);
  });

  test('once: true runs with the flag unset, WITHOUT writing the flag key', async () => {
    currentSkillsDir = skills1Dir;
    stubCosts = [0.05];
    const res = await runPhaseSkillopt({ engine, once: true });
    expect(res.status).toBe('ok');
    expect(runnerCalls.length).toBe(1);
    // The bypass never persists: the stored flag is still unset afterwards,
    // so the NEXT plain cycle run skips again.
    expect(await engine.getConfig('cycle.skillopt.enabled')).toBeNull();
    const followUp = await runPhaseSkillopt({ engine });
    expect(followUp.status).toBe('skipped');
    expect(runnerCalls.length).toBe(1);
    // Re-entry bookkeeping (NOT the feature flag) is still banked: last_run
    // is written so nightly cycles stay cheap to re-enter.
    const lastRun = await engine.getConfig('cycle.skillopt.last_run.skill-a');
    expect(lastRun).not.toBeNull();
    expect(Number(lastRun)).toBeGreaterThan(0);
  });
});

describe('runPhaseSkillopt cost caps', () => {
  test('anti-vacuity control: ample caps run all three candidates with the default per-skill cap', async () => {
    await enableFlag();
    stubCosts = [0.10, 0.10, 0.10];
    const res = await runPhaseSkillopt({ engine });
    expect(res.status).toBe('ok');
    expect(runnerCalls.length).toBe(3);
    // Default caps: per-skill $0.50, brain-wide $2.00. Remaining never dips
    // below the per-skill cap here, so every call receives the full $0.50.
    for (const call of runnerCalls) {
      expect(call.maxCostUsd).toBe(0.50);
    }
    // Nightly-safety shape the runner is invoked with: one epoch, no-mutate.
    expect(runnerCalls[0]!.epochs).toBe(1);
    expect(runnerCalls[0]!.noMutate).toBe(true);
    expect(runnerCalls[0]!.allowMutateBundled).toBe(false);
    const d = res.details as PhaseDetails;
    expect(d.skipped_brain_wide_cap).toBe(0);
    expect(d.per_skill_cap_usd).toBe(0.50);
    expect(d.brain_wide_cap_usd).toBe(2.00);
    expect(d.cumulative_cost_usd).toBeCloseTo(0.30, 10);
    expect(res.summary).toBe(
      'optimized 3/3 skills (0 no-improvement, 0 errored, 0 skipped over brain-wide cap)',
    );
  });

  test('brain-wide cap boundary is >= (at-cap skips): 3 × $1.00 against $2.00 skips the third', async () => {
    await enableFlag();
    await engine.setConfig('cycle.skillopt.per_skill_cap_usd', '1');
    await engine.setConfig('cycle.skillopt.brain_wide_cap_usd', '2');
    stubCosts = [1.00, 1.00];
    const res = await runPhaseSkillopt({ engine });
    // After two $1.00 spends, cumulative === cap EXACTLY. The pre-run check
    // is `cumulativeCostUsd >= brainWideCap`, so the third candidate never
    // reaches the runner. Under a strict `>` it would have run.
    expect(runnerCalls.length).toBe(2);
    const d = res.details as PhaseDetails;
    expect(d.skipped_brain_wide_cap).toBe(1);
    expect(d.cumulative_cost_usd).toBe(2.00);
    const results = d.results!;
    expect(results.length).toBe(3);
    // The skipped row is the THIRD iteration (readdir order is arbitrary, so
    // match by position + shape, not by name), zero-cost, with the pinned reason.
    expect(results[2]).toEqual({
      skill: results[2]!.skill,
      outcome: 'skipped',
      cost_usd: 0,
      reason: 'brain_wide_cap_reached',
    });
    expect(results[0]!.outcome).toBe('accepted');
    expect(results[1]!.outcome).toBe('accepted');
    expect(results.map((r) => r.skill).sort()).toEqual(THREE_SKILLS);
    // A capped skip is NOT an error: status stays ok and the summary counts it.
    expect(res.status).toBe('ok');
    expect(res.summary).toBe(
      'optimized 2/3 skills (0 no-improvement, 0 errored, 1 skipped over brain-wide cap)',
    );
  });

  test('strictly below the cap still runs: cumulative $1.99 < $2.00 lets the third through at min-cap', async () => {
    await enableFlag();
    await engine.setConfig('cycle.skillopt.per_skill_cap_usd', '1');
    await engine.setConfig('cycle.skillopt.brain_wide_cap_usd', '2');
    stubCosts = [1.00, 0.99, 0.005];
    const res = await runPhaseSkillopt({ engine });
    // 1.99 >= 2.00 is false → the third candidate RUNS (the other side of
    // the >= boundary), capped to the remaining ~$0.01.
    expect(runnerCalls.length).toBe(3);
    expect(runnerCalls[2]!.maxCostUsd as number).toBeCloseTo(0.01, 10);
    expect((res.details as PhaseDetails).skipped_brain_wide_cap).toBe(0);
  });

  test('effective per-skill cap = min(perSkillCap, remaining): runner receives the min', async () => {
    await enableFlag();
    currentSkillsDir = skills2Dir;
    await engine.setConfig('cycle.skillopt.per_skill_cap_usd', '1.5');
    await engine.setConfig('cycle.skillopt.brain_wide_cap_usd', '2');
    stubCosts = [1.00, 0.25];
    await runPhaseSkillopt({ engine });
    expect(runnerCalls.length).toBe(2);
    // Call 1: remaining $2.00 > per-skill $1.50 → min is the per-skill cap.
    expect(runnerCalls[0]!.maxCostUsd).toBe(1.5);
    // Call 2: remaining $1.00 < per-skill $1.50 → min is the remaining budget.
    expect(runnerCalls[1]!.maxCostUsd).toBe(1.0);
  });
});

describe('runPhaseSkillopt abort signal', () => {
  test('abort during the first run stops the loop — no further runner calls, no skipped rows', async () => {
    await enableFlag();
    const controller = new AbortController();
    onRunnerCall = () => controller.abort();
    stubCosts = [0.10];
    const res = await runPhaseSkillopt({ engine, signal: controller.signal });
    expect(runnerCalls.length).toBe(1);
    const d = res.details as PhaseDetails;
    // break, not skip: the unvisited tail gets no synthetic result rows and
    // does not count against skipped_brain_wide_cap.
    expect(d.results!.length).toBe(1);
    expect(d.skipped_brain_wide_cap).toBe(0);
    expect(d.skills_scanned).toBe(3);
    expect(res.status).toBe('ok');
  });

  test('already-aborted signal → zero runner invocations', async () => {
    await enableFlag();
    const controller = new AbortController();
    controller.abort();
    const res = await runPhaseSkillopt({ engine, signal: controller.signal });
    expect(runnerCalls.length).toBe(0);
    expect((res.details as PhaseDetails).results!.length).toBe(0);
    expect(res.status).toBe('ok');
  });
});
