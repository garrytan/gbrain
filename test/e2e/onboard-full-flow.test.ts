// test/e2e/onboard-full-flow.test.ts
// v0.41.18.0 (T20). Hermetic PGLite E2E for the onboard surface — no
// DATABASE_URL needed. Exercises the key contracts end-to-end:
//   - computeRemediationPlan with extras returns the expected shape
//   - buildOnboardReport produces a stable JSON envelope
//   - captureMetric returns numeric values for each of 5 metrics
//   - The runRemediation library refuses --auto without --max-usd
//   - The onboard CLI gates work as documented
//
// Full DATABASE_URL-gated end-to-end (real Postgres, actual extractions
// firing through Minion handlers) is deferred to a v0.42.1 follow-up
// once the Minion worker test harness lands the per-handler stub seam.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { computeRemediationPlan, runRemediation } from '../../src/core/remediation/index.ts';
import { captureMetric } from '../../src/core/onboard/impact-capture.ts';
import { buildOnboardReport, toOnboardRecommendation } from '../../src/core/onboard/render.ts';
import { checkTimelineCoverage, runAllOnboardChecks } from '../../src/core/onboard/checks.ts';
import { makeRemediationStep } from '../../src/core/remediation-step.ts';
import { parseGlobalFlags, setCliOptions, _resetCliOptionsForTest } from '../../src/core/cli-options.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

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

  test('empty brain: stale/link/timeline ok, takes_count warns (0 takes)', async () => {
    const results = await runAllOnboardChecks(engine);
    const byName = Object.fromEntries(results.map((r) => [r.check.name, r.check.status]));
    expect(byName.embed_staleness).toBe('ok');
    expect(byName.entity_link_coverage).toBe('ok');
    expect(byName.timeline_coverage).toBe('ok');
    expect(byName.takes_count).toBe('warn'); // 0 takes is a warn
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

describe('onboard E2E — timeline coverage remediation routing', () => {
  function timelineEngine(opts: {
    totalEntities: number;
    entitiesWithTimeline: number;
    meetingPages: number;
  }): BrainEngine {
    return {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        if (sql.includes("type = 'meeting'")) {
          return [{ count: opts.meetingPages }];
        }
        if (sql.includes('EXISTS (SELECT 1 FROM timeline_entries')) {
          return [{ count: opts.entitiesWithTimeline }];
        }
        if (sql.includes("type IN ('person', 'company', 'organization', 'entity')")) {
          return [{ count: opts.totalEntities }];
        }
        return [{ count: 0 }];
      },
    } as unknown as BrainEngine;
  }

  test('low timeline coverage does not recommend meeting extraction when no meeting pages exist', async () => {
    const result = await checkTimelineCoverage(timelineEngine({
      totalEntities: 10,
      entitiesWithTimeline: 0,
      meetingPages: 0,
    }));
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('no typed meeting pages');
    expect(result.remediations).toHaveLength(0);
  });

  test('low timeline coverage recommends meeting extraction when meeting pages exist', async () => {
    const result = await checkTimelineCoverage(timelineEngine({
      totalEntities: 10,
      entitiesWithTimeline: 0,
      meetingPages: 2,
    }));
    expect(result.check.status).toBe('warn');
    expect(result.check.message).not.toContain('no typed meeting pages');
    expect(result.remediations).toHaveLength(1);
    expect(result.remediations[0].job).toBe('extract-timeline-from-meetings');
    expect(result.remediations[0].rationale).toContain('2 meeting page(s)');
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

describe('onboard E2E — runRemediation with extras', () => {
  test('dry-run execution plan includes caller-supplied onboard extras', async () => {
    const extra = makeRemediationStep({
      id: 'test.synthetic-runner-extra',
      job: 'test-job',
      params: {},
      severity: 'low',
      est_seconds: 10,
      est_usd_cost: 0,
      rationale: 'synthetic runner entry',
      status: 'remediable',
    });

    const result = await runRemediation(engine, {
      targetScore: 0,
      dryRun: true,
      extraRemediations: [extra],
    });

    expect(result.submitted.map((s) => s.id)).toContain('test.synthetic-runner-extra');
    expect(result.submitted.find((s) => s.id === 'test.synthetic-runner-extra')?.status).toBe('dry_run');
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

describe('onboard CLI — global --explain plumbing', () => {
  test('parseGlobalFlags strips --explain before onboard sees args', () => {
    const parsed = parseGlobalFlags(['onboard', '--check', '--explain']);
    expect(parsed.rest).toEqual(['onboard', '--check']);
    expect(parsed.cliOpts.explain).toBe(true);
  });

  test('runOnboard can observe the globally parsed --explain flag', async () => {
    const parsed = parseGlobalFlags(['onboard', '--check', '--explain']);
    setCliOptions(parsed.cliOpts);
    try {
      const originalWrite = process.stdout.write;
      let out = '';
      process.stdout.write = ((chunk: string | Uint8Array) => {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      try {
        const { runOnboard } = await import('../../src/commands/onboard.ts');
        await runOnboard(engine, parsed.rest);
      } finally {
        process.stdout.write = originalWrite;
      }
      if (out.includes('unify-types')) {
        expect(out).toContain('Pack upgrade plan');
      } else {
        expect(out).toContain('no pack_upgrade_available recommendation');
      }
    } finally {
      _resetCliOptionsForTest();
    }
  });
});
