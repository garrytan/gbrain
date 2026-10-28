/**
 * W4: DoctorReport.alert (src/commands/doctor/alert.ts) — what an agent cron pages on.
 *
 * Synthetic check lists pin the verdict rules per page-class check (act / unknown / none, act over unknown, a
 * warnings-only report staying none, remote redaction); real in-memory PGLite pins the alert tier end to end
 * (healthy repo-less brain: none; a double-encoded JSONB row: act); the golden fixtures pin health_score,
 * brain_checks_score, category_scores and status as unchanged by the alert.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDoctorReport, buildChecks, type Check } from '../src/commands/doctor.ts';
import { alertRanChecks, alertRunArgs, computeAlert } from '../src/commands/doctor/alert.ts';
import { budgetUnknownCheck } from '../src/commands/doctor/budget.ts';
import { PAGE_CHECK_LEVELS, PAGE_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRemoteDoctorTier } from '../src/commands/doctor/remote-tier.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const ok = (name: string): Check => ({ name, status: 'ok', message: `${name} ok` });
const healthy = (): Check[] => [...PAGE_CHECK_NAMES].map(ok);
const ALL = new Set(PAGE_CHECK_NAMES);

describe('alert verdict per page-class check', () => {
  test('every page-class check ok, run fresh: none', () => {
    const alert = computeDoctorReport(healthy(), { alertRan: ALL }).alert!;
    expect(alert.level).toBe('none');
    expect(alert.items).toEqual([]);
    expect(alert.unknown).toEqual([]);
  });

  for (const [name, level] of PAGE_CHECK_LEVELS) {
    test(`${name} fail pages (act) with its own fix`, () => {
      const fix = { argv: ['gbrain', 'doctor', '--only', name, '--json'], consent: [], actor: 'agent' as const, why: 'example', requires_exclusive: false };
      const checks = healthy().map((c) => c.name === name ? { ...c, status: 'fail' as const, message: `${name} broke`, fix } : c);
      const alert = computeDoctorReport(checks, { alertRan: ALL }).alert!;
      expect(alert.level).toBe('act');
      expect(alert.items.map((i) => i.check)).toEqual([name]);
      expect(alert.items[0]!.code).toBe(name);
      expect(alert.items[0]!.message).toBe(`${name} broke`);
      expect(alert.items[0]!.fix?.argv).toEqual(fix.argv);
      expect(alert.items[0]!.fix?.next).toBe('run');
      expect(alert.items[0]!.fix?.verify?.argv ?? null).toBeNull();
      expect(alert.items[0]!.docs).toContain('doctor-alert');
    });
    test(`${name} warn ${level === 'warn' ? 'pages' : 'does not page'}`, () => {
      const checks = healthy().map((c) => c.name === name ? { ...c, status: 'warn' as const, message: 'warned' } : c);
      expect(computeDoctorReport(checks, { alertRan: ALL }).alert!.level).toBe(level === 'warn' ? 'act' : 'none');
    });
  }

  test('a stable details.code is the item code, and details.docs its docs', () => {
    const checks = healthy().map((c) => c.name === 'global_maintenance_stalled'
      ? { ...c, status: 'fail' as const, details: { code: 'global_maintenance_stalled', docs: 'docs/guides/troubleshooting.md#global-maintenance-stalled' } } : c);
    const item = computeDoctorReport(checks, { alertRan: ALL }).alert!.items[0]!;
    expect(item.code).toBe('global_maintenance_stalled');
    expect(item.docs).toBe('docs/guides/troubleshooting.md#global-maintenance-stalled');
  });

  test('warnings-only report outside the page class stays none, whatever health_score says', () => {
    const noise: Check[] = [
      { name: 'resolver_health', status: 'fail', message: '60 issue(s): 1 error(s), 59 warning(s)' },
      ...['skill_currency', 'embed_staleness', 'backup_coverage', 'orphan_ratio', 'fence_integrity', 'derived_visibility', 'embedding_provider', 'sync_freshness', 'stale_locks', 'integrity']
        .map((name): Check => ({ name, status: 'warn', message: 'advisory' })),
    ];
    const report = computeDoctorReport([...healthy(), ...noise], { alertRan: ALL });
    expect(report.health_score).toBe(30);
    expect(report.status).toBe('unhealthy');
    expect(report.alert!.level).toBe('none');
  });

  test('a timed-out page-class check makes the verdict unknown, naming its budget and the rerun', () => {
    const timedOut = budgetUnknownCheck('jsonb_integrity', 30_000, 30_000, 'overall');
    const checks = healthy().map((c) => c.name === 'jsonb_integrity' ? timedOut : c);
    const alert = computeDoctorReport(checks, { alertRan: ALL }).alert!;
    expect(alert.level).toBe('unknown');
    expect(alert.items).toEqual([]);
    expect(alert.unknown).toHaveLength(1);
    const u = alert.unknown[0]!;
    expect(u).toMatchObject({ code: 'doctor_alert_unknown', check: 'jsonb_integrity', reason: 'budget', budget_ms: 30_000 });
    expect(u.fix.argv).toEqual((timedOut.fix as { argv: string[] }).argv);
    expect(u.fix.argv?.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'jsonb_integrity', '--budget-ms']);
    expect(u.message).toContain('--budget-ms');
    expect(u.message).toContain('--tier standard');
  });

  test('a page-class check reported from its last known result, errored, or not run is unknown', () => {
    const checks = healthy().map((c) =>
      c.name === 'schema_version' ? { ...c, details: { last_known: { age_ms: 1000 } } }
        : c.name === 'rls' ? { ...c, status: 'warn' as const, fix_unavailable_reason: 'check_errored' as const }
          : c);
    const withoutRuntime = checks.filter((c) => c.name !== 'runtime_build_skew');
    const alert = computeDoctorReport(withoutRuntime, { alertRan: new Set([...ALL].filter((n) => n !== 'runtime_build_skew')) }).alert!;
    expect(alert.level).toBe('unknown');
    expect(Object.fromEntries(alert.unknown.map((u) => [u.check, u.reason]))).toEqual({ schema_version: 'last_known', rls: 'errored', runtime_build_skew: 'not_run' });
  });

  test('a page-class check this run executed but did not emit did not apply', () => {
    const checks = healthy().filter((c) => c.name !== 'dream_paid_loop');
    expect(computeDoctorReport(checks, { alertRan: ALL }).alert!.level).toBe('none');
    expect(computeDoctorReport(checks).alert!.unknown.map((u) => u.check)).toEqual(['dream_paid_loop']);
  });

  test('act beats unknown, and both item lists are kept', () => {
    const checks = healthy().map((c) => c.name === 'connection' ? { ...c, status: 'fail' as const, message: 'refused' }
      : c.name === 'jsonb_integrity' ? budgetUnknownCheck('jsonb_integrity', 5, 5) : c);
    const alert = computeDoctorReport(checks, { alertRan: ALL }).alert!;
    expect(alert.level).toBe('act');
    expect(alert.items.map((i) => i.check)).toEqual(['connection']);
    expect(alert.unknown.map((u) => u.check)).toEqual(['jsonb_integrity']);
  });

  test('a connection that did not open is unknown for every database check', () => {
    const conn: Check = { name: 'connection', status: 'warn', readiness_state: 'unknown', message: 'held by a live serve. The database checks did not run.' };
    const alert = computeDoctorReport([conn], { alertRan: alertRanChecks([conn], 'standard') }).alert!;
    expect(alert.level).toBe('unknown');
    expect(alert.unknown.map((u) => u.check).sort()).toEqual([...PAGE_CHECK_NAMES].sort());
  });

  test('the ops and quick tiers leave the page checks they skip unknown', () => {
    const ran = alertRanChecks([ok('connection')], 'ops');
    expect(ran.has('persistence_terminal_failures')).toBe(true);
    expect(ran.has('jsonb_integrity')).toBe(false);
    expect(alertRanChecks([ok('connection')], 'standard')).toEqual(ALL);
  });
});

describe('remote alert items', () => {
  test('omit check messages and local paths; a CLI-only fix becomes a host-admin step', () => {
    const render = { transport: 'http' as const, isCallable: () => false, preapproved: () => false };
    const checks = healthy().map((c) => c.name === 'persistence_write_stall'
      ? { ...c, status: 'warn' as const, message: 'Request r1 on source source-a, root /home/alice-example/brain/notes, is stuck',
        fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'source-a', '--json'], consent: [], actor: 'agent' as const, why: 'read-only', requires_exclusive: false } }
      : c.name === 'rls' ? { ...c, status: 'fail' as const, message: 'exposed at /var/lib/example/brain' } : c);
    const alert = computeDoctorReport(checks, { alertRan: ALL, render }).alert!;
    expect(alert.level).toBe('act');
    const text = JSON.stringify(alert);
    expect(text).not.toContain('/home/alice-example');
    expect(text).not.toContain('/var/lib/example');
    for (const item of alert.items) {
      expect(item.message).toBeUndefined();
      expect(item.fix?.actor).toBe('host_admin');
      expect(item.fix?.next).toBe('tell_user_to_run');
    }
  });

  test('the focused remote report (no ran set) is unknown for the page checks it never runs', () => {
    const render = { transport: 'http' as const, isCallable: () => false, preapproved: () => false };
    const alert = computeAlert([ok('connection'), ok('schema_version')], { render });
    expect(alert.level).toBe('unknown');
    expect(alert.unknown.every((u) => u.fix.actor === 'host_admin')).toBe(true);
  });
});

describe('alert run arguments', () => {
  test('--alert runs the page class alone under its budget; --tier, --only and --budget-ms win', () => {
    const args = alertRunArgs(['--alert', '--json']);
    expect(args).toContain('--scope=brain');
    expect(args[args.indexOf('--only') + 1]!.split(',').sort()).toEqual([...PAGE_CHECK_NAMES].sort());
    expect(args[args.indexOf('--budget-ms') + 1]).toBe('30000');
    expect(alertRunArgs(['--alert', '--tier', 'standard'])).not.toContain('--only');
    expect(alertRunArgs(['--alert', '--budget-ms', '0']).filter((a) => a === '--budget-ms')).toHaveLength(1);
  });
});

describe('health_score, brain_checks_score, category_scores and status are unchanged by the alert (decision 4)', () => {
  const dir = join(import.meta.dir, 'fixtures', 'goldens', 'doctor');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const golden = JSON.parse(readFileSync(join(dir, file), 'utf-8')).golden;
    const reports = [golden?.report, ...Object.values(golden ?? {}).map((v: any) => v?.report)].filter((r: any) => r && Array.isArray(r.checks) && typeof r.health_score === 'number');
    if (!reports.length) continue;
    test(file, () => {
      for (const stored of reports as any[]) {
        const again = computeDoctorReport(stored.checks.map(({ category: _c, ...c }: any) => c));
        expect({ health_score: again.health_score, brain_checks_score: again.brain_checks_score, category_scores: again.category_scores, status: again.status })
          .toEqual({ health_score: stored.health_score, brain_checks_score: stored.brain_checks_score, category_scores: stored.category_scores, status: stored.status });
      }
    });
  }
});

describe('alert tier on a real repo-less PGLite brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/alpha-example', { title: 'Alpha Example', type: 'concept' as const, compiled_truth: 'A note.\n' });
  });
  afterAll(async () => { await engine.disconnect(); });

  const run = async () => {
    const args = alertRunArgs(['--alert', '--json']);
    const checks = await buildChecks(engine, args);
    return computeDoctorReport(checks, { alertRan: alertRanChecks(checks, 'standard') });
  };

  test('healthy brain: every page-class check runs fresh and the verdict is none, on repeated runs', async () => {
    for (let i = 0; i < 3; i++) {
      const report = await run();
      expect(report.checks.map((c) => c.name).sort()).toEqual([...PAGE_CHECK_NAMES].sort());
      expect(report.alert!.unknown).toEqual([]);
      expect(report.alert!.level).toBe('none');
    }
  }, 60_000);

  test('MCP run_doctor with only = the page class runs them on the serve: a fresh, redacted verdict (remote=true)', async () => {
    const ctx = { engine, remote: true, transport: 'http', sourceId: 'default', config: {} as never,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const report = await runRemoteDoctorTier(ctx, { only: [...PAGE_CHECK_NAMES] });
    expect(report.checks.map((c) => c.name).sort()).toEqual([...PAGE_CHECK_NAMES].sort());
    expect(report.alert!.level).toBe('none');
    const partial = await runRemoteDoctorTier(ctx, { only: ['schema_version', 'brain_score'] });
    expect(partial.alert!.level).toBe('unknown');
    expect(partial.alert!.unknown.every((u) => u.fix.actor === 'host_admin')).toBe(true);
  }, 60_000);

  test('a double-encoded JSONB row (data integrity) pages with the repair command', async () => {
    await engine.executeRaw(`UPDATE pages SET frontmatter = to_jsonb(frontmatter::text) WHERE slug = 'notes/alpha-example'`);
    try {
      const report = await run();
      expect(report.alert!.level).toBe('act');
      expect(report.alert!.items.map((i) => i.check)).toEqual(['jsonb_integrity']);
      expect(report.alert!.items[0]!.message).toContain('gbrain repair-jsonb');
    } finally {
      await engine.executeRaw(`UPDATE pages SET frontmatter = (frontmatter #>> '{}')::jsonb WHERE slug = 'notes/alpha-example'`);
    }
  }, 60_000);
});
