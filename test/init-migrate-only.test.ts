/**
 * Tests for `gbrain init --migrate-only` — the schema-only primitive used by
 * apply-migrations, the stopgap script, and the postinstall hook.
 *
 * The key contract: migrate-only MUST NOT call saveConfig. Running it on an
 * existing Postgres install must not flip it to PGLite. Running it against a
 * missing config must fail loudly with a clear "run gbrain init first" error.
 *
 * Uses child_process subprocess invocations (not in-proc) because runInit
 * calls process.exit(1) on error paths, which breaks test isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;
let origHome: string | undefined;

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  // Strip DATABASE_URL / GBRAIN_DATABASE_URL from the subprocess env. The
  // "no config" error-path tests need loadConfig() to return null, which it
  // won't if any env var fallback is set (src/core/config.ts:30). Tests
  // that seed their own config use freshHomeWithConfig() below.
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
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-init-migrate-only-test-'));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gbrain init --migrate-only — error paths', () => {
  test('errors with clear message when no config exists', () => {
    const result = run(['init', '--migrate-only']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No brain configured');
    // Config file must not have been created (no saveConfig silently)
    expect(existsSync(join(tmp, '.gbrain', 'config.json'))).toBe(false);
  });

  test('JSON output flag emits a structured error', () => {
    const result = run(['init', '--migrate-only', '--json']);
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
  test('applies schema against existing PGLite config; does NOT modify config.json', () => {
    // Seed an existing PGLite config + brain file.
    const gbrainDir = join(tmp, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const dbPath = join(gbrainDir, 'brain.pglite');
    const configPath = join(gbrainDir, 'config.json');
    const cfg = { engine: 'pglite', database_path: dbPath };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');

    // Capture the config's mtime + content to verify saveConfig was NOT called.
    const mtimeBefore = statSync(configPath).mtimeMs;
    const contentBefore = readFileSync(configPath, 'utf-8');

    // First run: should apply schema.
    const result = run(['init', '--migrate-only', '--json']);
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

  test('idempotent on rerun — second call succeeds without error', () => {
    const gbrainDir = join(tmp, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const dbPath = join(gbrainDir, 'brain.pglite');
    const configPath = join(gbrainDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ engine: 'pglite', database_path: dbPath }) + '\n');

    const first = run(['init', '--migrate-only', '--json']);
    expect(first.exitCode).toBe(0);

    const second = run(['init', '--migrate-only', '--json']);
    expect(second.exitCode).toBe(0);
  }, 60_000);
});
