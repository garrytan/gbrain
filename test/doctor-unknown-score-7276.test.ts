import { describe, expect, test } from 'bun:test';
import { computeDoctorReport, type Check } from '../src/commands/doctor.ts';
import { budgetUnknownCheck } from '../src/commands/doctor/budget.ts';
import { DOCTOR_CHECK_REGISTRY, CHEAP_INCIDENT_CHECKS } from '../src/commands/doctor/registry.ts';
import { connectionGateEntry } from '../src/commands/doctor/checks/db-connection.ts';

const ok = (name: string): Check => ({ name, status: 'ok', message: 'fine' });
const warn = (name: string): Check => ({ name, status: 'warn', message: 'a real finding' });
const fail = (name: string): Check => ({ name, status: 'fail', message: 'broken' });
const unknown = (name: string): Check => budgetUnknownCheck(name, 0, 90_000, 'overall');

describe('#7276: checks not finished within the budget are not scored as warnings', () => {
  test('the score counts only finished checks; unknowns are counted, not charged', () => {
    const report = computeDoctorReport([ok('connection'), warn('timeline_history'), unknown('derived_visibility'), unknown('orphan_ratio'), unknown('stale_mentions')]);
    expect(report.health_score).toBe(95);
    expect(report.category_scores.brain).toBe(95);
    expect(report.unknown_count).toBe(3);
    expect(report.status).toBe('warnings');
  });

  test('many unknowns no longer floor the score at 0', () => {
    const many = Array.from({ length: 160 }, () => unknown('orphan_ratio'));
    const report = computeDoctorReport([ok('connection'), ok('schema_version'), ...many]);
    expect(report.health_score).toBe(100);
    expect(report.unknown_count).toBe(160);
    expect(report.status).toBe('warnings');
  });

  test('unknowns alone never make a report healthy, and a real failure still makes it unhealthy', () => {
    expect(computeDoctorReport([ok('connection'), unknown('orphan_ratio')]).status).toBe('warnings');
    const failing = computeDoctorReport([ok('connection'), fail('resolver_health'), unknown('orphan_ratio')]);
    expect(failing.status).toBe('unhealthy');
    expect(failing.health_score).toBe(80);
  });

  test('a category whose every check is unknown has no score', () => {
    const report = computeDoctorReport([ok('connection'), ok('resolver_health'), unknown('schema_version')]);
    expect(report.unknown_scores).toEqual(['meta']);
    expect(computeDoctorReport([ok('connection'), ok('schema_version'), unknown('schema_version')]).unknown_scores).toBeUndefined();
  });

  test('a report with nothing unknown is unchanged', () => {
    const report = computeDoctorReport([ok('connection'), warn('timeline_history'), fail('resolver_health')]);
    expect(report.health_score).toBe(75);
    expect(report.unknown_count).toBeUndefined();
    expect(report.unknown_scores).toBeUndefined();
  });
});

describe('#7276: derived_visibility runs in its own entry before the full scans', () => {
  test('its entry emits only derived_visibility and no other entry emits it', () => {
    const owners = DOCTOR_CHECK_REGISTRY.filter((e) => e.emits.includes('derived_visibility'));
    expect(owners.map((e) => e.emits)).toEqual([['derived_visibility']]);
  });

  test('it is the first entry after the ops and cheap incident checks', () => {
    const after = DOCTOR_CHECK_REGISTRY.slice(DOCTOR_CHECK_REGISTRY.indexOf(connectionGateEntry) + 1);
    const firstScan = after.find((e) => e.tier !== 'ops' && !e.emits.some((n) => CHEAP_INCIDENT_CHECKS.has(n)));
    expect(firstScan?.name).toBe('derived_visibility');
  });
});
