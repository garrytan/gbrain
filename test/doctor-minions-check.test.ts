/**
 * Tests for the half-migrated Minions detection checks added to
 * `gbrain doctor` in v0.11.1.
 *
 * Two branches:
 *   - Filesystem-only (check #3): `completed.jsonl` has a status:"partial"
 *     entry with no matching status:"complete" for the same version.
 *     Fires on every `doctor` invocation — even without a DB connection.
 *   - DB-path (check #6a): schema is v7+ but `preferences.json` is missing.
 *     Catches installs that never ran the stopgap at all.
 *
 * Invokes the CLI via subprocess against a temp $HOME so the checks see
 * clean fixture state per test.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;
let origHome: string | undefined;

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  // Strip DATABASE_URL so doctor runs filesystem-only for these tests.
  // Half-migrated checks run in the filesystem section; no DB needed.
  const env = { ...process.env, HOME: tmp } as Record<string, string | undefined>;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  try {
    const stdout = execFileSync('bun', ['run', CLI, ...args], {
      env: env as Record<string, string>,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-doctor-minions-test-'));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gbrain doctor — half-migrated Minions detection', () => {
  test('filesystem: partial completed.jsonl entry with no matching complete → FAIL', () => {
    // Seed ~/.gbrain/migrations/completed.jsonl with a single status:"partial"
    // entry — the classic signal the stopgap ran but apply-migrations didn't.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({
        version: '0.11.0',
        status: 'partial',
        apply_migrations_pending: true,
        mode: 'pain_triggered',
        source: 'fix-v0.11.0.sh',
        ts: new Date().toISOString(),
      }) + '\n',
    );

    // Use --fast so we skip the DB section entirely (no engine configured).
    const result = run(['doctor', '--fast', '--json']);
    // doctor exits 1 on any FAIL; that's expected here.
    expect(result.exitCode).toBe(1);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string; message: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions).toBeDefined();
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('MINIONS HALF-INSTALLED');
    expect(minions!.message).toContain('gbrain apply-migrations --yes');
    expect(minions!.message).toContain('0.11.0');
  });

  test('filesystem: partial followed by complete → NO warning', () => {
    // The stopgap wrote partial, then v0.11.1 apply-migrations wrote
    // complete. Doctor should stay quiet.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      [
        JSON.stringify({ version: '0.11.0', status: 'partial', apply_migrations_pending: true }),
        JSON.stringify({ version: '0.11.0', status: 'complete', mode: 'pain_triggered' }),
      ].join('\n') + '\n',
    );

    const result = run(['doctor', '--fast', '--json']);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    // No warn/fail — either the check isn't emitted at all (no issues) or
    // it emits an ok entry. Either is acceptable for a quiet state.
    if (minions) {
      expect(['ok']).toContain(minions.status);
    }
  });

  test('filesystem: no completed.jsonl at all → NO warning (fresh install path)', () => {
    // Doctor must NOT warn about half-migrated Minions just because a user
    // hasn't run any migration yet. The FS check only fires when there's
    // genuine partial-without-complete evidence.
    const result = run(['doctor', '--fast', '--json']);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    if (minions) {
      expect(['ok']).toContain(minions.status);
    }
  });

  test('regression: fresh install with schema-applied DB but no prefs must NOT fail', () => {
    // CI regression. `gbrain init` against Postgres applies schema v7 but
    // doesn't write preferences.json (the migration orchestrator does that
    // via apply-migrations). For that brief window, schema is v7 with no
    // prefs — a valid state that must NOT trigger a FAIL check.
    //
    // This pins the bug that broke Tier 1 CI (mechanical.test.ts
    // "gbrain doctor exits 0 on healthy DB"): the old "schema v7+ no
    // preferences.json → FAIL" rule was too aggressive. Only a concrete
    // "partial without complete" entry in completed.jsonl counts as
    // half-migrated.
    const result = run(['doctor', '--fast', '--json']);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string }>;
    // No check with `minions_config` or `minions_migration` should be in FAIL
    for (const check of checks) {
      if (check.name === 'minions_config' || check.name === 'minions_migration') {
        expect(check.status).not.toBe('fail');
      }
    }
  });

  test('filesystem: multiple versions each need their own complete entry', () => {
    // v0.10 is fully migrated but v0.11 is only partial. Doctor should
    // flag v0.11 by name. The forward-progress override only kicks in
    // when a NEWER version completed; v0.10 is older than v0.11 so the
    // partial still stands.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      [
        JSON.stringify({ version: '0.10.0', status: 'complete' }),
        JSON.stringify({ version: '0.11.0', status: 'partial' }),
      ].join('\n') + '\n',
    );

    const result = run(['doctor', '--fast', '--json']);
    expect(result.exitCode).toBe(1);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string; message: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('0.11.0');
    expect(minions!.message).not.toContain('0.10.0');
  });

  test('filesystem: stale partial superseded by newer complete → NO warning (forward-progress override)', () => {
    // v0.16.0 completed AFTER v0.11.0 went partial. The schema clearly
    // advanced past v0.11.0, so the partial record is stale historical
    // noise — not a real "MINIONS HALF-INSTALLED" condition.
    //
    // Without this override, every install that ever went through a
    // v0.11.0 stopgap and then upgraded carries the FAIL flag forever,
    // even on installs that have been at v0.22+ for months. Real cause:
    // long-running gbrain installs accumulate partial entries from
    // historical stopgap runs; a doctor flag with no time decay or
    // forward-progress detection becomes meaningless once you've
    // moved past those versions.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      [
        JSON.stringify({ version: '0.16.0', status: 'complete', ts: '2026-04-26T06:13:50.825Z' }),
        JSON.stringify({ version: '0.11.0', status: 'partial', ts: '2026-04-26T06:16:56.298Z' }),
        JSON.stringify({ version: '0.11.0', status: 'partial', ts: '2026-04-26T06:19:03.617Z' }),
      ].join('\n') + '\n',
    );

    const result = run(['doctor', '--fast', '--json']);
    // No FAIL on minions_migration — the v0.11.0 partials are stale
    // because v0.16.0 (a newer release) completed.
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    if (minions) {
      expect(minions.status).not.toBe('fail');
    }
    // Critically: the test fixture would have caused exit 1 under the old
    // (no-override) logic because of the stale partial flag. Under the new
    // logic, doctor exits 0 (or only warns about non-related checks).
    expect(result.exitCode).toBe(0);
  });

  test('filesystem: stale partial NOT superseded → still flagged', () => {
    // The override only fires when a >= partial version has completed.
    // Older completes (e.g. v0.10 complete + v0.16 partial) do NOT
    // supersede the partial; the partial still indicates a real problem.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      [
        JSON.stringify({ version: '0.10.0', status: 'complete' }),
        JSON.stringify({ version: '0.16.0', status: 'partial' }),
      ].join('\n') + '\n',
    );

    const result = run(['doctor', '--fast', '--json']);
    expect(result.exitCode).toBe(1);
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; status: string; message: string }>;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('0.16.0');
  });

  test('human output: prints MINIONS HALF-INSTALLED loud banner', () => {
    // Same fixture as the first test, but check the human-readable output
    // includes the exact banner phrase an OpenClaw host's cron script
    // can grep for.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
    );

    const result = run(['doctor', '--fast']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('MINIONS HALF-INSTALLED');
    expect(result.stdout).toContain('gbrain apply-migrations --yes');
  });
});
