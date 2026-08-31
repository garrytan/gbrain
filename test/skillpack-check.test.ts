/**
 * Tests for `gbrain skillpack-check` — the agent-readable health report.
 *
 * Covers:
 *   - Healthy fresh install → exit 0, healthy:true, actions:[], no DB needed.
 *   - Half-migrated (partial entry in completed.jsonl) → exit 1,
 *     healthy:false, actions includes `gbrain apply-migrations --yes`,
 *     summary mentions the action.
 *   - --quiet → no stdout, same exit code.
 *   - --help → prints usage, exits 0.
 *
 * Subprocess invocation via runCliBatch against two fixture $HOMEs (healthy
 * and half-migrated), spawned once in beforeAll; tests assert on the cached
 * results. Sharing a home within a batch is safe: skillpack-check is
 * read-only against $HOME (doctor --fast reads filesystem state;
 * apply-migrations --list early-returns when no brain is configured).
 * DATABASE_URL / GBRAIN_DATABASE_URL are stripped by the helper so the
 * report runs filesystem-only (the checks we care about live there).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCliBatch, type CliResult } from './helpers/cli-spawn.ts';
import { __testing } from '../src/commands/skillpack-check.ts';

let healthyHome: string;
let brokenHome: string;

// Cached batch results — spawned once in beforeAll, asserted per-test.
let healthy: CliResult; // skillpack-check           (healthy home)
let healthyQuiet: CliResult; // skillpack-check --quiet   (healthy home)
let help: CliResult; // skillpack-check --help    (healthy home)
let broken: CliResult; // skillpack-check           (half-migrated home)
let brokenQuiet: CliResult; // skillpack-check --quiet   (half-migrated home)

beforeAll(async () => {
  healthyHome = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-check-test-'));
  brokenHome = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-check-test-'));

  // Half-migrated fixture: a partial record in completed.jsonl trips the
  // minions_migration doctor check → apply-migrations action.
  const migrationsDir = join(brokenHome, '.gbrain', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, 'completed.jsonl'),
    JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
  );

  // Two sequential batches at the default width 2 — each run spawns doctor +
  // apply-migrations grandchildren, so machine-wide CLI children stay bounded.
  [healthy, healthyQuiet, help] = await runCliBatch(
    [['skillpack-check'], ['skillpack-check', '--quiet'], ['skillpack-check', '--help']],
    { home: healthyHome },
  );
  [broken, brokenQuiet] = await runCliBatch(
    [['skillpack-check'], ['skillpack-check', '--quiet']],
    { home: brokenHome },
  );
}, 120_000);

afterAll(() => {
  for (const dir of [healthyHome, brokenHome]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('gbrain skillpack-check', () => {
  test('healthy fresh install → exit 0, healthy:true, empty actions', () => {
    expect(healthy.exitCode).toBe(0);
    const report = JSON.parse(healthy.stdout);
    expect(report.healthy).toBe(true);
    expect(report.actions).toEqual([]);
    expect(report.summary).toBe('gbrain skillpack healthy');
    expect(report.version).toBeTruthy();
    expect(report.ts).toBeTruthy();
  });

  test('half-migrated (partial completed.jsonl) → exit 1, apply-migrations in actions', () => {
    expect(broken.exitCode).toBe(1);
    const report = JSON.parse(broken.stdout);
    expect(report.healthy).toBe(false);
    expect(report.actions).toContain('gbrain apply-migrations --yes');
    expect(report.summary).toContain('gbrain apply-migrations --yes');
    expect(report.summary).toContain('needs attention');
    // Doctor check surfaced the MINIONS HALF-INSTALLED line
    const doctorChecks = (report.doctor as { checks: Array<{ name: string; status: string }> }).checks;
    const minions = doctorChecks.find(c => c.name === 'minions_migration');
    expect(minions).toBeDefined();
    expect(minions!.status).toBe('fail');
  });

  test('--quiet → no stdout, same exit code', () => {
    // Healthy path quiet
    expect(healthyQuiet.exitCode).toBe(0);
    expect(healthyQuiet.stdout).toBe('');

    // Broken path quiet — the half-migrated fixture home
    expect(brokenQuiet.exitCode).toBe(1);
    expect(brokenQuiet.stdout).toBe('');
  });

  test('--help → exit 0, prints usage', () => {
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('skillpack-check');
    expect(help.stdout).toContain('healthy');
    expect(help.stdout).toContain('Exit codes');
  });

  test('summary includes top action when multiple present', () => {
    // Partial record creates apply-migrations action + the migrations count
    // action. Summary should reference the first (highest-priority) action.
    // Identical fixture + argv as the half-migrated test → shares its run.
    expect(broken.exitCode).toBe(1);
    const report = JSON.parse(broken.stdout);
    expect(report.summary).toMatch(/\d+ action\(s\)/);
    expect(report.summary).toContain(report.actions[0]);
  });
});

describe('gbrainSpawn — argv[1] vs execPath resolution (#4094)', () => {
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;

  afterEach(() => {
    process.argv[1] = originalArgv1;
    process.execPath = originalExecPath;
  });

  test('compiled-binary bunfs argv[1]: execPath (the real on-disk binary) wins, not the unusable virtual path', () => {
    // Bun single-file compiled binary: argv[1] is a virtual bunfs path that
    // ends in '/gbrain' but is not spawnable (ENOENT). execPath correctly
    // points at the real on-disk binary in this exact scenario.
    process.argv[1] = '/$bunfs/root/gbrain';
    process.execPath = '/usr/local/bin/gbrain';
    const { cmd, prefix } = __testing.gbrainSpawn();
    expect(cmd).toBe('/usr/local/bin/gbrain');
    expect(prefix).toEqual([]);
  });

  test('gbrain shim script on PATH: argv[1] is used when execPath is the bun runtime, not gbrain', () => {
    process.argv[1] = '/usr/local/bin/gbrain';
    process.execPath = '/opt/homebrew/Cellar/bun/1.2.15/bin/bun';
    const { cmd, prefix } = __testing.gbrainSpawn();
    expect(cmd).toBe('/usr/local/bin/gbrain');
    expect(prefix).toEqual([]);
  });

  test('dev mode: `bun run src/cli.ts` prefixes with `bun run`', () => {
    process.argv[1] = '/repo/src/cli.ts';
    process.execPath = '/opt/homebrew/Cellar/bun/1.2.15/bin/bun';
    const { cmd, prefix } = __testing.gbrainSpawn();
    expect(cmd).toBe('bun');
    expect(prefix).toEqual(['run', '/repo/src/cli.ts']);
  });

  test('neither argv[1] nor execPath resolves to gbrain: falls back to $PATH', () => {
    process.argv[1] = '/some/unrelated/entrypoint';
    process.execPath = '/opt/homebrew/Cellar/bun/1.2.15/bin/bun';
    const { cmd, prefix } = __testing.gbrainSpawn();
    expect(cmd).toBe('gbrain');
    expect(prefix).toEqual([]);
  });

  test('Windows compiled binary: execPath ending in gbrain.exe wins over bunfs argv[1]', () => {
    process.argv[1] = 'B:\\~BUN\\root\\gbrain.exe';
    process.execPath = 'C:\\Program Files\\gbrain\\gbrain.exe';
    const { cmd, prefix } = __testing.gbrainSpawn();
    expect(cmd).toBe('C:\\Program Files\\gbrain\\gbrain.exe');
    expect(prefix).toEqual([]);
  });
});
