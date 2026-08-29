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
import { __testing } from '../src/commands/skillpack-check.ts';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;
let origHome: string | undefined;

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  // Both HOME and GBRAIN_HOME must point at the fixture dir: config/path
  // resolution prefers GBRAIN_HOME (which the test preload sets to its own
  // scratch), so HOME alone leaves the child reading the wrong .gbrain.
  const env = { ...process.env, HOME: tmp, GBRAIN_HOME: tmp } as Record<string, string | undefined>;
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
