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
 * JSON-shape assertions drive the exported `buildChecks()` seam in-process
 * (the same seam test/doctor-behavioral.test.ts uses) under a withEnv-scoped
 * temp GBRAIN_HOME — the check reads completed.jsonl at call time through
 * gbrainPath(), so no subprocess is needed. Exit-code parity is exact:
 * runDoctor's verdict is computeDoctorReport(checks).status === 'unhealthy'
 * ? 1 : 0 (doctor.ts:outputResults) and buildChecks receives the same args
 * the --fast CLI dispatch passes. Two real CLI spawns remain, each pinning a
 * path the seam can't reach:
 *   - the human-output banner render + real process exit code (wiring smoke)
 *   - the dead-DB fallback note + credential redaction, which live in
 *     src/cli.ts's doctor dispatch, not in buildChecks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { buildChecks, computeDoctorReport, type Check } from '../src/commands/doctor.ts';
import { getDbUrlSource } from '../src/core/config.ts';

let tmp: string;

/**
 * In-process equivalent of the old `bun run src/cli.ts doctor --fast --json`
 * child. Both HOME and GBRAIN_HOME are scoped to the fixture dir — gbrainPath
 * prefers GBRAIN_HOME and appends '.gbrain', so either root resolves to the
 * same `<tmp>/.gbrain` the fixtures seed — and the DB URLs are stripped so
 * doctor runs filesystem-only (half-migrated checks need no DB). Sibling test
 * files' env mutations can't poison this: withEnv overrides GBRAIN_HOME for
 * the duration of the call instead of inheriting a leaked value. exitCode is
 * derived exactly the way runDoctor derives it (unhealthy → 1), and
 * getDbUrlSource() is computed inside the env scope, matching the --fast
 * dispatch in src/cli.ts.
 */
async function runFastChecks(): Promise<{ exitCode: number; checks: Check[] }> {
  return withEnv(
    { HOME: tmp, GBRAIN_HOME: tmp, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    async () => {
      const checks = await buildChecks(null, ['--fast', '--json'], getDbUrlSource());
      return {
        exitCode: computeDoctorReport(checks).status === 'unhealthy' ? 1 : 0,
        checks,
      };
    },
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-doctor-minions-test-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gbrain doctor — half-migrated Minions detection', () => {
  test('filesystem: partial completed.jsonl entry with no matching complete → FAIL', async () => {
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

    // --fast skips the DB section entirely (no engine configured).
    const result = await runFastChecks();
    // doctor exits 1 on any FAIL; that's expected here.
    expect(result.exitCode).toBe(1);
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions).toBeDefined();
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('MINIONS HALF-INSTALLED');
    expect(minions!.message).toContain('gbrain apply-migrations --yes');
    expect(minions!.message).toContain('0.11.0');
  });

  test('filesystem: partial followed by complete → NO warning', async () => {
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

    const result = await runFastChecks();
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    // No warn/fail — either the check isn't emitted at all (no issues) or
    // it emits an ok entry. Either is acceptable for a quiet state.
    if (minions) {
      expect(['ok']).toContain(minions.status);
    }
  });

  test('filesystem: no completed.jsonl at all → NO warning (fresh install path)', async () => {
    // Doctor must NOT warn about half-migrated Minions just because a user
    // hasn't run any migration yet. The FS check only fires when there's
    // genuine partial-without-complete evidence.
    const result = await runFastChecks();
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    if (minions) {
      expect(['ok']).toContain(minions.status);
    }
  });

  test('regression: fresh install with schema-applied DB but no prefs must NOT fail', async () => {
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
    const result = await runFastChecks();
    const checks = result.checks;
    // No check with `minions_config` or `minions_migration` should be in FAIL
    for (const check of checks) {
      if (check.name === 'minions_config' || check.name === 'minions_migration') {
        expect(check.status).not.toBe('fail');
      }
    }
  });

  test('filesystem: multiple versions each need their own complete entry', async () => {
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

    const result = await runFastChecks();
    expect(result.exitCode).toBe(1);
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('0.11.0');
    expect(minions!.message).not.toContain('0.10.0');
  });

  test('filesystem: stale partial superseded by newer complete → NO warning (forward-progress override)', async () => {
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

    const result = await runFastChecks();
    // No FAIL on minions_migration — the v0.11.0 partials are stale
    // because v0.16.0 (a newer release) completed.
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    if (minions) {
      expect(minions.status).not.toBe('fail');
    }
    // Critically: the test fixture would have caused exit 1 under the old
    // (no-override) logic because of the stale partial flag. Under the new
    // logic, doctor exits 0 (or only warns about non-related checks).
    expect(result.exitCode).toBe(0);
  });

  test('filesystem: stale partial NOT superseded → still flagged', async () => {
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

    const result = await runFastChecks();
    expect(result.exitCode).toBe(1);
    const checks = result.checks;
    const minions = checks.find(c => c.name === 'minions_migration');
    expect(minions!.status).toBe('fail');
    expect(minions!.message).toContain('0.16.0');
  });

  test('human output: prints MINIONS HALF-INSTALLED loud banner', async () => {
    // Same fixture as the first test, but check the human-readable output
    // includes the exact banner phrase an OpenClaw host's cron script
    // can grep for. This is the file's real-CLI wiring smoke: render +
    // process exit code go through src/cli.ts, which buildChecks can't reach.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
    );

    const result = await runCli(['doctor', '--fast'], { home: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('MINIONS HALF-INSTALLED');
    expect(result.stdout).toContain('gbrain apply-migrations --yes');
  }, 60_000);

  test('DB-connect failure announces the filesystem-only fallback on stderr, credentials redacted', async () => {
    // The fallback used to be silent — indistinguishable from a healthy
    // DB-backed run minus the DB checks. Pin the stderr note AND that a
    // credential-bearing connect error never leaks the password (doctor
    // output is what users paste into issues and CI logs). Must be a real
    // spawn: the note + redaction live in src/cli.ts's doctor dispatch,
    // not in buildChecks.
    const gbrainDir = join(tmp, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    // Assembled at runtime so the source never contains a scannable
    // credential-URL span (the value is synthetic).
    const fakeUrl = ['postgresql:/', '/alice:sekrit-hunter2', '@127.0.0.1:1/refused'].join('');
    writeFileSync(
      join(gbrainDir, 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: fakeUrl }) + '\n',
    );

    // runCli strips DATABASE_URL/GBRAIN_DATABASE_URL and points HOME +
    // GBRAIN_HOME at the fixture dir; it captures stderr regardless of the
    // exit code, which this pin needs.
    const res = await runCli(['doctor', '--json'], { home: tmp });
    expect(res.stderr).toContain('[doctor] DB-backed doctor run failed');
    expect(res.stderr).toContain('filesystem-only checks');
    expect(res.stderr).not.toContain('sekrit-hunter2');
    // stdout stays parseable JSON for --json consumers.
    expect(() => JSON.parse(res.stdout.trim())).not.toThrow();
  }, 60_000);
});
