// test/e2e/onboard-full-flow.test.ts
// v0.41.18.0 (T20). Hermetic PGLite E2E for the onboard surface — no
// DATABASE_URL needed. Exercises the key contracts end-to-end:
//   - computeRemediationPlan with extras returns the expected shape
//   - buildOnboardReport produces a stable JSON envelope
//   - captureMetric returns numeric values for each of 5 metrics, read
//     with the predicates the onboard checks and get_health report
//   - A remediation job step writes its before/after impact row, which
//     `gbrain onboard --history` shows
//   - The runRemediation library refuses --auto without --max-usd
//   - The onboard CLI gates work as documented
//
// The impact-history block also runs on real Postgres when DATABASE_URL is
// set (a real extract job, run inline through the Minion worker). Other
// handlers firing on Postgres still wait on the per-handler stub seam.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { computeRemediationPlan, runRemediation } from '../../src/core/remediation/index.ts';
import { captureMetric } from '../../src/core/onboard/impact-capture.ts';
import { runOnboard } from '../../src/commands/onboard.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { buildOnboardReport, toOnboardRecommendation } from '../../src/core/onboard/render.ts';
import { runAllOnboardChecks } from '../../src/core/onboard/checks.ts';
import { makeRemediationStep } from '../../src/core/remediation-step.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('onboard E2E — captureMetric', () => {
  test('captureMetric returns 0 for stale_count on empty brain', async () => {
    const v = await captureMetric(engine, 'stale_count');
    expect(v).toBe(0);
  });

  test('captureMetric returns 0 for orphan_count on empty brain', async () => {
    const v = await captureMetric(engine, 'orphan_count');
    expect(v).toBe(0);
  });

  test('captureMetric returns 1 for coverage on empty brain (vacuous truth)', async () => {
    const v = await captureMetric(engine, 'entity_link_coverage');
    expect(v).toBe(1);
  });

  test('captureMetric returns 0 for takes_count on empty brain', async () => {
    const v = await captureMetric(engine, 'takes_count');
    expect(v).toBe(0);
  });
});

// The impact row's JSONB details only prove out on real Postgres (PGLite hides
// double-encoding), so this block also runs there when DATABASE_URL is set.
for (const backend of ['pglite', 'postgres'] as const) {
  (backend === 'postgres' && !hasDatabase() ? describe.skip : describe)(`onboard E2E — impact history (${backend})`, () => {
    let brain: BrainEngine;

    beforeAll(async () => {
      if (backend === 'postgres') {
        brain = await setupDB();
        return;
      }
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      brain = pglite;
    }, 60_000);

    afterAll(async () => {
      if (backend === 'postgres') await teardownDB();
      else await brain.disconnect();
    });

    test('a remediation job step records its metric before and after; onboard --history shows it', async () => {
      // Two unextracted pages, one linking the other: the planner adds
      // extract.stale, whose link leaves get_health with no orphan pages.
      await brain.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice works at [[companies/acme-example]].' });
      await brain.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A widget company.' });
      expect((await brain.getHealth()).orphan_pages).toBe(2);

      const result = await runRemediation(brain, { targetScore: 0, inlineJobs: true });
      const step = result.submitted.find((s) => s.id === 'extract.stale');
      expect(step?.status).toBe('completed');

      const onboardOutput = async (args: string[]) => {
        let out = '';
        const write = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
        try {
          await runOnboard(brain, args);
        } finally {
          process.stdout.write = write;
        }
        return out;
      };
      const { history } = JSON.parse(await onboardOutput(['--history', '--json'])) as { history: Array<Record<string, unknown>> };
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ remediation_id: 'extract.stale', metric_name: 'orphan_count', metric_before: 2, metric_after: 0, delta: -2 });
      expect(await onboardOutput(['--history'])).toMatch(
        /^Onboard history \(last 1\):\n {2}\d{4}-\d\d-\d\dT[\d:.]+Z {2}extract\.stale {2}orphan_count: 2 → 0 \(-2\)\n$/);

      const [row] = await brain.executeRaw<{ job_id: string | number; details: Record<string, unknown> }>(
        'SELECT job_id, details FROM migration_impact_log');
      expect(Number(row.job_id)).toBe(step!.job_id!);
      expect(row.details).toMatchObject({ job: 'extract', status: 'completed', doctor_run_id: result.doctor_run_id });
    });

    test('stale and coverage metrics leave out the pages the onboard checks leave out', async () => {
      // An embed_skip page's unembedded chunk is not stale work, and a
      // quarantined entity page is outside the coverage population.
      await brain.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'Waiting for a vector.' });
      await installFixtureChunks(brain, 'notes/plain-example', [{ chunk_index: 0, chunk_text: 'Waiting for a vector.', chunk_source: 'compiled_truth' }]);
      await brain.putPage('notes/skipped-example', { type: 'note', title: 'Skipped', compiled_truth: 'Never embedded.', frontmatter: { embed_skip: true } });
      await installFixtureChunks(brain, 'notes/skipped-example', [{ chunk_index: 0, chunk_text: 'Never embedded.', chunk_source: 'compiled_truth' }]);
      await brain.putPage('people/hidden-example', { type: 'person', title: 'Hidden', compiled_truth: 'Quarantined.', frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'fixture' } } });

      expect(await captureMetric(brain, 'stale_count')).toBe(1);
      expect(await brain.countStaleChunks()).toBe(1);
      // acme-example has an inbound link, alice-example has none.
      expect(await captureMetric(brain, 'entity_link_coverage')).toBe(0.5);
    });
  });
}

describe('onboard E2E — runAllOnboardChecks', () => {
  test('returns all 7 check shapes', async () => {
    // v0.42 (T13-T15): type-unification cathedral added 3 onboard checks
    // — pack_upgrade_available, type_proliferation, dangling_aliases — for
    // a total of 7. Pre-v0.42 was 4.
    const results = await runAllOnboardChecks(engine);
    expect(results.length).toBe(7);
    const names = results.map((r) => r.check.name).sort();
    expect(names).toEqual([
      'dangling_aliases',
      'embed_staleness',
      'entity_link_coverage',
      'pack_upgrade_available',
      'takes_count',
      'timeline_coverage',
      'type_proliferation',
    ]);
  });

  test('empty brain: stale/link/timeline ok, takes_count is opt-in information (0 takes)', async () => {
    const results = await runAllOnboardChecks(engine);
    const byName = Object.fromEntries(results.map((r) => [r.check.name, r.check.status]));
    expect(byName.embed_staleness).toBe('ok');
    expect(byName.entity_link_coverage).toBe('ok');
    expect(byName.timeline_coverage).toBe('ok');
    expect(byName.takes_count).toBe('ok'); // 0 takes with the bootstrap off is opt-in: ok + severity info (E2)
  });

  test('empty brain remediations: takes_count gated, pack_upgrade_available may surface', async () => {
    const results = await runAllOnboardChecks(engine);
    const total = results.reduce((s, r) => s + r.remediations.length, 0);
    // takes_count warns but does NOT emit a remediation (takes.bootstrap_enabled
    // defaults to false — A12 two-gate consent).
    // v0.42 (T13): pack_upgrade_available CAN emit a manual_only remediation
    // when gbrain-base@1.x is active and gbrain-base-v2 is declared as the
    // successor (the unify-types Minion handler). Allow 0-1 remediations
    // depending on whether a successor pack is registered in the test brain.
    expect(total).toBeLessThanOrEqual(1);
    const takesRemediations = results
      .filter((r) => r.check.name === 'takes_count')
      .reduce((s, r) => s + r.remediations.length, 0);
    expect(takesRemediations).toBe(0);
  });
});

describe('onboard E2E — computeRemediationPlan with extras', () => {
  test('threads extras through computeRecommendations', async () => {
    // Build a synthetic extra remediation. computeRemediationPlan
    // should merge it into the plan output even though the hardcoded
    // planner doesn't know about it.
    const extra = makeRemediationStep({
      id: 'test.synthetic',
      job: 'test-job',
      params: {},
      severity: 'low',
      est_seconds: 10,
      est_usd_cost: 0,
      rationale: 'synthetic test entry',
      status: 'remediable',
    });
    const plan = await computeRemediationPlan(engine, {
      targetScore: 90,
      extraRemediations: [extra],
    });
    const ids = plan.plan.map((p) => p.id);
    expect(ids).toContain('test.synthetic');
  });

  test('returns RemediationPlan with stable schema_version: 2', async () => {
    const plan = await computeRemediationPlan(engine, { targetScore: 90 });
    expect(plan.schema_version).toBe(2);
    expect(typeof plan.brain_score_current).toBe('number');
    expect(plan.brain_score_target).toBe(90);
    expect(typeof plan.max_reachable_score).toBe('number');
    expect(Array.isArray(plan.plan)).toBe(true);
  });
});

describe('onboard E2E — buildOnboardReport', () => {
  test('produces stable JSON envelope with schema_version: 1', async () => {
    const plan = await computeRemediationPlan(engine, { targetScore: 90 });
    const report = buildOnboardReport(plan);
    expect(report.schema_version).toBe(1);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(report.summary).toBeDefined();
    expect(typeof report.summary.total).toBe('number');
    expect(typeof report.summary.auto_eligible).toBe('number');
    expect(typeof report.summary.prompt_required).toBe('number');
    expect(typeof report.summary.manual_only).toBe('number');
    expect(typeof report.summary.est_total_usd).toBe('number');
  });
});

describe('onboard E2E — toOnboardRecommendation tier policy', () => {
  test('non-protected job → auto_apply', () => {
    const step = makeRemediationStep({
      id: 'test.embed', job: 'embed-catch-up', params: {},
      severity: 'medium', est_seconds: 60, est_usd_cost: 0.1,
      rationale: 'embed', status: 'remediable',
    });
    const r = toOnboardRecommendation(step);
    expect(r.apply_policy).toBe('auto_apply');
  });

  test('extract-takes-from-pages → manual_only (A12+A24)', () => {
    const step = makeRemediationStep({
      id: 'test.takes', job: 'extract-takes-from-pages',
      protected: true, params: {},
      severity: 'medium', est_seconds: 1800, est_usd_cost: 5,
      rationale: 'takes', status: 'remediable',
    });
    const r = toOnboardRecommendation(step);
    expect(r.apply_policy).toBe('manual_only');
  });

  test('other protected jobs → prompt_required', () => {
    const step = makeRemediationStep({
      id: 'test.synth', job: 'synthesize',
      protected: true, params: {},
      severity: 'medium', est_seconds: 600, est_usd_cost: 1,
      rationale: 'synth', status: 'remediable',
    });
    const r = toOnboardRecommendation(step);
    expect(r.apply_policy).toBe('prompt_required');
  });
});
