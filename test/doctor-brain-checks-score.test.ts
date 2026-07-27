/**
 * v0.41.19.0 brain_checks_score + category_scores invariants.
 *
 * Pinned contracts:
 *   - health_score math is byte-identical to pre-v0.41.19.0 for a fixed
 *     check set (back-compat invariant for MCP consumers, --remediate,
 *     remote doctor).
 *   - brain_checks_score is the same penalty math restricted to brain
 *     checks.
 *   - category_scores sum across the 4 categories is NOT the same as
 *     health_score (different math — each is 100-based). This is by
 *     design.
 *   - Renaming regression: no field called `brain_health_score` ships
 *     in the JSON envelope. The shipped name is `brain_checks_score`
 *     (codex MAJOR-8 — avoid collision with the existing weighted
 *     BrainHealth.brain_score).
 *   - Tags fall through to `categorizeCheck(name)` when not pre-tagged.
 *   - schema_version stays at 2 (additive fields are non-breaking).
 */

import { describe, test, expect } from 'bun:test';
import { computeDoctorReport, type Check } from '../src/commands/doctor.ts';

function check(name: string, status: Check['status'], message = ''): Check {
  return { name, status, message };
}

describe('computeDoctorReport — back-compat health_score invariant', () => {
  test('health_score = 100 on all-OK fixed check set', () => {
    const checks: Check[] = [
      check('brain_score', 'ok'),
      check('connection', 'ok'),
      check('resolver_health', 'ok'),
      check('schema_version', 'ok'),
    ];
    const r = computeDoctorReport(checks);
    expect(r.health_score).toBe(100);
    expect(r.status).toBe('healthy');
  });

  test('health_score = 100 − 20×fails − 5×warns, floor 0', () => {
    const checks: Check[] = [
      check('connection', 'fail'),       // -20
      check('brain_score', 'warn'),      // -5
      check('resolver_health', 'warn'),  // -5
      check('schema_version', 'ok'),
    ];
    const r = computeDoctorReport(checks);
    expect(r.health_score).toBe(70);
  });

  test('health_score floors at 0 even with many fails', () => {
    const checks: Check[] = Array.from({ length: 10 }, (_, i) =>
      check(`fail_${i}`, 'fail'),
    );
    const r = computeDoctorReport(checks);
    expect(r.health_score).toBe(0);
  });

  test('schema_version stays at 2', () => {
    const r = computeDoctorReport([check('connection', 'ok')]);
    expect(r.schema_version).toBe(2);
  });

  test('504 skill warns DO drag down health_score (this is the legacy behavior we are preserving)', () => {
    const checks: Check[] = [
      check('connection', 'ok'),
      check('brain_score', 'ok'),
      check('resolver_health', 'warn', '504 issues'),
    ];
    const r = computeDoctorReport(checks);
    // Just one check, warn = -5.
    expect(r.health_score).toBe(95);
  });
});

describe('computeDoctorReport — brain_checks_score', () => {
  test('brain_checks_score is 100 when all brain checks are OK, even if skill checks are failing', () => {
    const checks: Check[] = [
      check('brain_score', 'ok'),
      check('embedding_provider', 'ok'),
      check('sync_freshness', 'ok'),
      check('resolver_health', 'fail', '504 warnings'),  // skill, not counted
      check('skill_conformance', 'warn'),                // skill, not counted
    ];
    const r = computeDoctorReport(checks);
    expect(r.brain_checks_score).toBe(100);
  });

  test('brain_checks_score reflects ONLY brain-category failures', () => {
    const checks: Check[] = [
      check('embedding_provider', 'fail'),  // brain -20
      check('graph_coverage', 'warn'),      // brain -5
      check('connection', 'fail'),          // ops, not counted
      check('schema_version', 'warn'),      // meta, not counted
    ];
    const r = computeDoctorReport(checks);
    expect(r.brain_checks_score).toBe(75);
  });

  test('the OpenClaw 504-warning scenario: brain ~100, skill ~0, overall low', () => {
    const checks: Check[] = [
      check('brain_score', 'ok'),
      check('embedding_provider', 'ok'),
      check('sync_freshness', 'ok'),
    ];
    // 30 skill warnings (the canonical pollution scenario, scaled down for test brevity)
    for (let i = 0; i < 30; i++) checks.push(check(`resolver_health`, 'warn'));
    // Categorization re-tags each `resolver_health` push as skill, so all 30 warns sit in skill.
    const r = computeDoctorReport(checks);
    expect(r.brain_checks_score).toBe(100);
    expect(r.category_scores.skill).toBe(0);  // 30 * -5 = -150, floored at 0
    expect(r.health_score).toBe(0);            // overall is dragged to 0 (the problem!)
  });
});

describe('computeDoctorReport — category_scores', () => {
  test('every category gets its own 100-floor penalty score', () => {
    const checks: Check[] = [
      check('brain_score', 'warn'),
      check('resolver_health', 'fail'),
      check('connection', 'warn'),
      check('schema_version', 'fail'),
    ];
    const r = computeDoctorReport(checks);
    expect(r.category_scores.brain).toBe(95);  // 1 warn
    expect(r.category_scores.skill).toBe(80);  // 1 fail
    expect(r.category_scores.ops).toBe(95);    // 1 warn
    expect(r.category_scores.meta).toBe(80);   // 1 fail
  });

  test('empty category gets 100 (vacuous truth)', () => {
    const checks: Check[] = [check('brain_score', 'ok')];
    const r = computeDoctorReport(checks);
    expect(r.category_scores.brain).toBe(100);
    expect(r.category_scores.skill).toBe(100);  // no skill checks ran
    expect(r.category_scores.ops).toBe(100);
    expect(r.category_scores.meta).toBe(100);
  });
});

describe('computeDoctorReport — categorization fall-through', () => {
  test('checks without category get tagged via categorizeCheck(name)', () => {
    const r = computeDoctorReport([
      check('embedding_provider', 'ok'),
      check('resolver_health', 'ok'),
      check('connection', 'ok'),
      check('schema_version', 'ok'),
    ]);
    expect(r.checks.find((c) => c.name === 'embedding_provider')?.category).toBe('brain');
    expect(r.checks.find((c) => c.name === 'resolver_health')?.category).toBe('skill');
    expect(r.checks.find((c) => c.name === 'connection')?.category).toBe('ops');
    expect(r.checks.find((c) => c.name === 'schema_version')?.category).toBe('meta');
  });

  test('pre-tagged category survives compute (no override)', () => {
    const r = computeDoctorReport([
      { name: 'made_up_unknown_name', status: 'ok', message: '', category: 'brain' },
    ]);
    expect(r.checks[0].category).toBe('brain');
    expect(r.brain_checks_score).toBe(100);
  });
});

describe('computeDoctorReport — renaming regression (codex MAJOR-8)', () => {
  test('NO field named brain_health_score ships in the JSON envelope', () => {
    const r = computeDoctorReport([check('brain_score', 'ok')]);
    const jsonShape = JSON.parse(JSON.stringify(r));
    expect(jsonShape).not.toHaveProperty('brain_health_score');
    expect(jsonShape).toHaveProperty('brain_checks_score');
  });

  test('the existing weighted BrainHealth.brain_score is NOT replaced — it stays in the checks list', () => {
    // The brain_score check surfaces engine.getHealth().brain_score (weighted
    // 35/25/15/15/10). It's orthogonal to brain_checks_score. Make sure the
    // check name is still resolvable as a `brain` category entry.
    const r = computeDoctorReport([check('brain_score', 'ok', 'Brain score 92/100')]);
    expect(r.checks[0].category).toBe('brain');
    expect(r.checks[0].message).toContain('92');
  });
});
