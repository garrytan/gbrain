/**
 * Tests for `gbrain init --migrate-only` — the schema-only primitive used by
 * apply-migrations, the stopgap script, and the postinstall hook.
 *
 * The key contract: migrate-only MUST NOT call saveConfig. Running it on an
 * existing Postgres install must not flip it to PGLite. Running it against a
 * missing config must fail loudly with a clear "run gbrain init first" error.
 *
 * Uses subprocess invocations (not in-proc) because runInit calls
 * process.exit(1) on error paths, which breaks test isolation. Spawns route
 * through test/helpers/cli-spawn.ts (async Bun.spawn; DATABASE_URL /
 * GBRAIN_DATABASE_URL always stripped — the "no config" error paths need
 * loadConfig() to return null, which any env-var fallback would defeat, see
 * src/core/config.ts:30; opts.home pins BOTH HOME and GBRAIN_HOME so the
 * child never reads the operator's real ~/.gbrain). The four error paths are
 * flag/config validation that exits before any write, so they share one
 * empty home and run once through runCliBatch (width 2 — the machine-wide
 * cap, see cli-spawn.ts) in the describe's beforeAll; each test asserts on
 * its cached result, exit code included. The happy-path tests share one
 * home: the idempotence rerun reuses the brain the config-preservation test
 * already built (bun runs in-file tests in declaration order) instead of
 * cold-building a second PGLite schema from scratch.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli, runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

describe('gbrain init --migrate-only — error paths', () => {
  // Every argv here is a validation-failure path verified to exit before any
  // migrate-only side effects (no config write, no DB touch), so all four
  // share one empty home. That makes the config.json absence checks below
  // strictly stronger than the per-test homes they replaced: if ANY of the
  // four runs wrote a config, they fail. Do NOT add anything here that
  // writes config or state — batch order is not execution order.
  const ERROR_ARGVS: string[][] = [
    ['init', '--migrate-only', '--dry-run'],
    ['init', '--migrate-only', '--dry-run', '--json'],
    ['init', '--migrate-only'],
    ['init', '--migrate-only', '--json'],
  ];

  let errHome: string;
  const batched = new Map<string, CliResult>();

  beforeAll(async () => {
    errHome = mkdtempSync(join(tmpdir(), 'gbrain-init-migrate-only-test-'));
    const results = await runCliBatch(ERROR_ARGVS, { home: errHome });
    ERROR_ARGVS.forEach((argv, i) => batched.set(argv.join(' '), results[i]));
  }, 60_000);

  afterAll(() => {
    try { rmSync(errHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function cached(...argv: string[]): CliResult {
    const r = batched.get(argv.join(' '));
    if (!r) throw new Error(`not in ERROR_ARGVS batch: gbrain ${argv.join(' ')}`);
    return r;
  }

  test('rejects unknown flags before any migrate-only side effects', () => {
    const result = cached('init', '--migrate-only', '--dry-run');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag --dry-run');
    // Unknown safety flags must not fall through to the migration path.
    expect(result.stderr).not.toContain('No brain configured');
    expect(existsSync(join(errHome, '.gbrain', 'config.json'))).toBe(false);
  });

  test('unknown flags respect --json output', () => {
    const result = cached('init', '--migrate-only', '--dry-run', '--json');
    expect(result.exitCode).toBe(1);
    const lines = result.stdout.split('\n').filter((l: string) => l.trim().startsWith('{'));
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toBe('invalid_flag');
    expect(parsed.message).toContain('unknown flag --dry-run');
  });

  test('errors with clear message when no config exists', () => {
    const result = cached('init', '--migrate-only');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No brain configured');
    // Config file must not have been created (no saveConfig silently)
    expect(existsSync(join(errHome, '.gbrain', 'config.json'))).toBe(false);
  });

  test('JSON output flag emits a structured error', () => {
    const result = cached('init', '--migrate-only', '--json');
    expect(result.exitCode).toBe(1);
    // --json writes the structured error to stdout per the pattern in init.ts
    const lines = result.stdout.split('\n').filter((l: string) => l.trim().startsWith('{'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toBe('no_config');
  });
});

describe('gbrain init --migrate-only — happy path with PGLite config', () => {
  // One home for both tests: the config-preservation test builds the brain,
  // the idempotence test reruns against it. Declaration order IS execution
  // order within a bun test file, so the reuse never observes an unbuilt
  // brain in a full-file run.
  let home: string;
  let firstRun: CliResult | null = null;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-init-migrate-only-test-'));
  });

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('applies schema against existing PGLite config; does NOT modify config.json', async () => {
    // Seed an existing PGLite config + brain file.
    const gbrainDir = join(home, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const dbPath = join(gbrainDir, 'brain.pglite');
    const configPath = join(gbrainDir, 'config.json');
    const cfg = { engine: 'pglite', database_path: dbPath };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');

    // Capture the config's mtime + content to verify saveConfig was NOT called.
    const mtimeBefore = statSync(configPath).mtimeMs;
    const contentBefore = readFileSync(configPath, 'utf-8');

    // First run: should apply schema.
    const result = await runCli(['init', '--migrate-only', '--json'], { home });
    firstRun = result; // stash before asserting so the rerun test reuses it even on failure
    expect(result.exitCode).toBe(0);
    const jsonLines = result.stdout.split('\n').filter((l: string) => l.trim().startsWith('{'));
    const parsed = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(parsed.status).toBe('success');
    expect(parsed.engine).toBe('pglite');
    expect(parsed.mode).toBe('migrate-only');

    // Critical: config.json MUST NOT have been overwritten. Either the mtime
    // is unchanged (strictest) or at minimum the content is identical.
    const contentAfter = readFileSync(configPath, 'utf-8');
    expect(contentAfter).toBe(contentBefore);
    // mtime may or may not tick depending on OS resolution; content equality
    // is the real invariant we need.

    // Brain file should exist (schema applied).
    expect(existsSync(dbPath)).toBe(true);
  }, 30_000);

  test('idempotent on rerun — second call succeeds without error', async () => {
    // Normal path: `first` is the previous test's run against this home —
    // the second call below is the true rerun on an existing brain. Under a
    // `-t` filter that skipped the previous test, seed + run the first call
    // here (the original two-spawn shape).
    let first = firstRun;
    if (first === null) {
      const gbrainDir = join(home, '.gbrain');
      mkdirSync(gbrainDir, { recursive: true });
      const dbPath = join(gbrainDir, 'brain.pglite');
      writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }) + '\n');
      first = await runCli(['init', '--migrate-only', '--json'], { home });
    }
    expect(first.exitCode).toBe(0);

    const second = await runCli(['init', '--migrate-only', '--json'], { home });
    expect(second.exitCode).toBe(0);
  }, 60_000);
});
