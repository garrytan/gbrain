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
 * Subprocess invocation against temp $HOME so each test sees clean fixture
 * state. DATABASE_URL / GBRAIN_DATABASE_URL stripped so the report runs
 * filesystem-only (the checks we care about live there).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;
let origHome: string | undefined;

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
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
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-check-test-'));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gbrain skillpack-check', () => {
  test('healthy fresh install → exit 0, healthy:true, empty actions', () => {
    const result = run(['skillpack-check']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.healthy).toBe(true);
    expect(report.actions).toEqual([]);
    expect(report.summary).toBe('gbrain skillpack healthy');
    expect(report.version).toBeTruthy();
    expect(report.ts).toBeTruthy();
  });

  test('half-migrated (partial completed.jsonl) → exit 1, apply-migrations in actions', () => {
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
    );

    const result = run(['skillpack-check']);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
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
    const healthy = run(['skillpack-check', '--quiet']);
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stdout).toBe('');

    // Broken path quiet — need new tmp with fixture
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
    );
    const broken = run(['skillpack-check', '--quiet']);
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout).toBe('');
  });

  test('--help → exit 0, prints usage', () => {
    const result = run(['skillpack-check', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('skillpack-check');
    expect(result.stdout).toContain('healthy');
    expect(result.stdout).toContain('Exit codes');
  });

  test('summary includes top action when multiple present', () => {
    // Partial record creates apply-migrations action + the migrations count
    // action. Summary should reference the first (highest-priority) action.
    const migrationsDir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, 'completed.jsonl'),
      JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n',
    );
    const result = run(['skillpack-check']);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toMatch(/\d+ action\(s\)/);
    expect(report.summary).toContain(report.actions[0]);
  });
});
