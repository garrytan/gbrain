import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

type Step = {
  name?: string;
  uses?: string;
  'timeout-minutes'?: number;
  if?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};
const workflow = load(readFileSync(join(import.meta.dir, '../../.github/workflows/native-locks.yml'), 'utf8')) as {
  jobs: {
    native: { steps: Step[]; strategy: { matrix: { target: string[]; bun: string[] } } };
    'windows-backup-console': { steps: Step[]; 'runs-on': string; 'timeout-minutes': number;
      strategy: { 'fail-fast': boolean; matrix: { runner: string[]; bun: string[]; exclude: string } } };
    'windows-backup-dotnet': { steps: Step[]; 'runs-on': string; 'timeout-minutes': number;
      strategy: { 'fail-fast': boolean; matrix: { runner: string[]; bun: string[]; exclude: string } } };
  };
};
const suites = [
  'test/persistence-publication-native.serial.test.ts',
  'test/persistence-git-publication.test.ts',
  'test/persistence-sync-origin-native.test.ts',
  'test/backup-portability-native.serial.test.ts',
  'test/export-publication-native.test.ts',
  'test/native-export-publication.test.ts',
];

describe('data-safety native CI coverage', () => {
  test('the darwin-x64 cell posts diag/native-heartbeat statuses from its first step to its last, never on a fork pull request', () => {
    const job = workflow.jobs.native as typeof workflow.jobs.native & { permissions?: Record<string, string> };
    expect(job.permissions).toEqual({ contents: 'read', statuses: 'write' });
    const names = job.steps.map(step => step.name ?? step.uses ?? '');
    const start = job.steps.findIndex(step => step.name === 'Start the diagnostic heartbeat');
    const stop = job.steps.findIndex(step => step.name === 'Stop the diagnostic heartbeat');
    expect(names[start - 1]).toStartWith('actions/checkout@');
    expect(stop).toBe(job.steps.length - 1);
    const env = {
      GH_TOKEN: '${{ github.token }}',
      GBRAIN_HEARTBEAT_ENABLED: "${{ (github.event.pull_request.head.repo.full_name || github.repository) == github.repository && '1' || '0' }}",
      GBRAIN_HEARTBEAT_SHA: '${{ github.event.pull_request.head.sha || github.sha }}',
      GBRAIN_HEARTBEAT_CELL: '${{ matrix.target }}/${{ matrix.bun }}',
    };
    expect(job.steps[start]).toEqual({ name: 'Start the diagnostic heartbeat', if: "matrix.target == 'darwin-x64'", env, run: 'bash scripts/native/heartbeat.sh start' });
    expect(job.steps[stop]).toEqual({ name: 'Stop the diagnostic heartbeat', if: "always() && matrix.target == 'darwin-x64'", env,
      run: 'bash scripts/native/heartbeat.sh stop "${{ job.status }}"' });
    for (const step of job.steps) if (step !== job.steps[start] && step !== job.steps[stop]) expect(JSON.stringify(step)).not.toContain('github.token');
    const safety = job.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    expect(safety.run).toContain('  GBRAIN_HEARTBEAT_ENABLED=1 bash scripts/native/heartbeat.sh mark "$1" || true\n  bun --no-env-file test --timeout=180000 "$1" &');
    const caller = (load(readFileSync(join(import.meta.dir, '../../.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, { uses?: string; permissions?: Record<string, string> }> }).jobs['native-locks']!;
    expect(caller.uses).toBe('./.github/workflows/native-locks.yml');
    expect(caller.permissions).toEqual({ actions: 'read', contents: 'read', statuses: 'write' });
  });

  test('a Linux job after every cell finalizes a darwin-x64 heartbeat its cell left pending, never on a fork pull request', () => {
    const finalize = (workflow.jobs as unknown as Record<string, { needs: string[]; if: string; 'runs-on': string; permissions: Record<string, string>; steps: Step[] }>)['heartbeat-finalize']!;
    expect(finalize.needs).toEqual(['native']);
    expect(finalize.if).toBe("${{ always() && inputs.scope != 'smoke' }}");
    expect(finalize['runs-on']).toBe('ubicloud-standard-2-ubuntu-2404');
    expect(finalize.permissions).toEqual({ actions: 'read', contents: 'read', statuses: 'write' });
    const step = finalize.steps.at(-1)!;
    expect(step).toEqual({ name: 'Finalize darwin-x64 heartbeats left pending', run: 'bun scripts/native/heartbeat-finalize.ts', env: {
      GH_TOKEN: '${{ github.token }}',
      GBRAIN_HEARTBEAT_ENABLED: "${{ (github.event.pull_request.head.repo.full_name || github.repository) == github.repository && '1' || '0' }}",
      GBRAIN_HEARTBEAT_SHA: '${{ github.event.pull_request.head.sha || github.sha }}',
    } });
    for (const other of finalize.steps.slice(0, -1)) expect(JSON.stringify(other)).not.toContain('github.token');
  });

  test('the opt-in console diagnostic has an isolated Windows matrix without filtering the acceptance suites', () => {
    const job = workflow.jobs['windows-backup-console'];
    expect(job['runs-on']).toBe('${{ matrix.runner }}');
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.runner).toEqual(['windows-2022', 'windows-11-arm']);
    expect(job.strategy.matrix.bun).toEqual(['1.4.4']);
    expect(job.steps.some(entry => entry.run === 'bun scripts/native/verify.ts')).toBe(true);
    const step = job.steps.find(entry => entry.name === 'Compare native hidden-window launch behavior');
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!['continue-on-error']).toBeUndefined();
    expect(step!.shell).toBe('bash');
    expect(step!.env).toEqual({ GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_TEST_BACKUP_CONSOLE_PROBE: '1' });
    expect(step!.run!.trim().split('\n')).toEqual([
      "bun --no-env-file test --timeout=180000 --test-name-pattern '^private ACL setup compares hidden and visible PowerShell windows$' test/backup-portability-native.serial.test.ts 2>&1 | tee \"$RUNNER_TEMP/backup-console.log\"",
      "grep -Fq 'Windows backup console controls:' \"$RUNNER_TEMP/backup-console.log\"",
    ]);
    const fixture = readFileSync(join(import.meta.dir, '../backup-portability-native.serial.test.ts'), 'utf8');
    expect(fixture).toContain("test.skipIf(process.platform !== 'win32' || process.env.GBRAIN_TEST_BACKUP_CONSOLE_PROBE !== '1')('private ACL setup compares hidden and visible PowerShell windows'");
    expect(workflow.jobs.native.steps.some(entry => entry.env?.GBRAIN_TEST_BACKUP_CONSOLE_PROBE !== undefined)).toBe(false);
  });

  for (const [exitCode, observation] of [[0, true], [1, true], [0, false]] as const) test(`console probe refuses failed or unexecuted diagnostics (${exitCode}, ${observation})`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'gbrain-console-workflow-'));
    try {
      const step = workflow.jobs['windows-backup-console'].steps.find(entry => entry.name === 'Compare native hidden-window launch behavior')!;
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
        bun() { if [[ "$GBRAIN_TEST_OBSERVATION" == 1 ]]; then printf '%s\\n' 'Windows backup console controls: synthetic'; fi; return "$GBRAIN_TEST_EXIT"; }
        ${step.run}
      `], { env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: temporary, GBRAIN_TEST_OBSERVATION: observation ? '1' : '0', GBRAIN_TEST_EXIT: String(exitCode) } });
      expect(result.exitCode).toBe(exitCode === 0 && observation ? 0 : 1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test('the direct dotnet program comparison has its own two-cell opt-in Windows job', () => {
    const job = workflow.jobs['windows-backup-dotnet'];
    expect(job['runs-on']).toBe('${{ matrix.runner }}');
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.runner).toEqual(['windows-2022', 'windows-11-arm']);
    expect(job.strategy.matrix.bun).toEqual(['1.4.4']);
    expect(job.steps.some(entry => entry.run === 'bun scripts/native/verify.ts')).toBe(true);
    const step = job.steps.find(entry => entry.name === 'Compare cmdlet and direct dotnet ACL programs');
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!['continue-on-error']).toBeUndefined();
    expect(step!.shell).toBe('bash');
    expect(step!.env).toEqual({ GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_TEST_BACKUP_DOTNET_PROBE: '1' });
    expect(step!.run!.trim().split('\n')).toEqual([
      "bun --no-env-file test --timeout=180000 --test-name-pattern '^private (directory|file) ACL setup compares cmdlet and direct dotnet calls$' test/backup-portability-native.serial.test.ts 2>&1 | tee \"$RUNNER_TEMP/backup-dotnet.log\"",
      "grep -Fq 'Windows backup dotnet controls: {\"kind\":\"directory\",' \"$RUNNER_TEMP/backup-dotnet.log\"",
      "grep -Fq 'Windows backup dotnet controls: {\"kind\":\"file\",' \"$RUNNER_TEMP/backup-dotnet.log\"",
    ]);
    const fixture = readFileSync(join(import.meta.dir, '../backup-portability-native.serial.test.ts'), 'utf8');
    expect(fixture).toContain("for (const kind of ['directory', 'file'] as const) test.skipIf(process.platform !== 'win32' || process.env.GBRAIN_TEST_BACKUP_DOTNET_PROBE !== '1')(`private ${kind} ACL setup compares cmdlet and direct dotnet calls`");
    expect(workflow.jobs.native.steps.some(entry => entry.env?.GBRAIN_TEST_BACKUP_DOTNET_PROBE !== undefined)).toBe(false);
    expect(workflow.jobs['windows-backup-console'].steps.some(entry => entry.env?.GBRAIN_TEST_BACKUP_DOTNET_PROBE !== undefined)).toBe(false);
  });

  // GitHub counts "Set up job" against timeout-minutes: one windows-11-arm job spent 218 s there and the old 5-minute
  // limit cancelled its passed probe. A stalled step must fail at its own bound, never as a job cancel after it passed.
  for (const [name, probe, tests] of [['windows-backup-console', 'Compare native hidden-window launch behavior', 1],
    ['windows-backup-dotnet', 'Compare cmdlet and direct dotnet ACL programs', 2]] as const) test(`${name}: every step is bounded, and the job limit is the step bounds plus 5 minutes of runner setup`, () => {
    const job = workflow.jobs[name];
    for (const step of job.steps) expect([step.name ?? step.uses ?? step.run, step['timeout-minutes']]).toEqual([step.name ?? step.uses ?? step.run, expect.any(Number)]);
    const bounds = job.steps.map(step => step['timeout-minutes']!);
    expect(job['timeout-minutes']).toBe(5 + bounds.reduce((sum, minutes) => sum + minutes, 0));
    // The probe step outlasts bun's own per-test timeout for each of its tests, so a stuck test is reported by bun first.
    const step = job.steps.find(entry => entry.name === probe)!;
    const perTest = Number(/--timeout=(\d+)/.exec(step.run!)![1]) / 1000;
    expect(step['timeout-minutes']! * 60).toBeGreaterThan(perTest * tests);
  });

  test('the cmdlet arm retains the exact original encoded protection program', () => {
    const program = readFileSync(join(import.meta.dir, '../fixtures/windows-backup-cmdlet-protect.ps1'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(Buffer.from(program, 'utf16le')).digest('hex'))
      .toBe('586ed48aa8f0ec1b6a37d0fe516d45fd98b3b3cc47587ef2c406a1e76521f2fc');
  });

  for (const [exitCode, observation] of [[0, true], [1, true], [0, false]] as const) test(`dotnet probe refuses failed or unexecuted diagnostics (${exitCode}, ${observation})`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'gbrain-dotnet-workflow-'));
    try {
      const step = workflow.jobs['windows-backup-dotnet'].steps.find(entry => entry.name === 'Compare cmdlet and direct dotnet ACL programs')!;
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
        bun() { if [[ "$GBRAIN_TEST_OBSERVATION" == 1 ]]; then printf '%s\\n' 'Windows backup dotnet controls: {"kind":"directory",' 'Windows backup dotnet controls: {"kind":"file",'; fi; return "$GBRAIN_TEST_EXIT"; }
        ${step.run}
      `], { env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: temporary, GBRAIN_TEST_OBSERVATION: observation ? '1' : '0', GBRAIN_TEST_EXIT: String(exitCode) } });
      expect(result.exitCode).toBe(exitCode === 0 && observation ? 0 : 1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  for (const kind of ['directory', 'file']) for (const copies of [1, 2]) test(`dotnet probe refuses execution of only ${kind}${copies === 2 ? ' twice' : ''}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'gbrain-dotnet-partial-'));
    try {
      const step = workflow.jobs['windows-backup-dotnet'].steps.find(entry => entry.name === 'Compare cmdlet and direct dotnet ACL programs')!;
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
        bun() { printf '%s\\n' ${Array(copies).fill(`'Windows backup dotnet controls: {"kind":"${kind}",'`).join(' ')}; }
        ${step.run}
      `], { env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: temporary } });
      expect(result.exitCode).toBe(1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  test('real publication, sync and backup contracts run on every native matrix target', () => {
    const job = workflow.jobs.native;
    expect(job.strategy.matrix.target).toContain('win32-x64');
    expect(job.strategy.matrix.target).toContain('win32-arm64');
    expect(job.strategy.matrix.target).toContain('darwin-arm64');
    expect(job.strategy.matrix.target).toContain('linux-x64-glibc');
    const step = job.steps.find(entry => entry.name === 'Verify native data-safety contracts');
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!['continue-on-error']).toBeUndefined();
    expect(step!.shell).toBe('bash');
    expect(step!.env).toEqual({
      GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1',
      GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE: "${{ runner.os != 'Linux' && '1' || '0' }}",
      GBRAIN_NATIVE_SUITE_BOUND_S: expect.stringContaining('[matrix.target]'),
    });
    const lines = step!.run!.trim().split('\n');
    expect(lines[0]).toBe('status=0');
    expect(lines).toContain('  bun --no-env-file test --timeout=180000 "$1" &');
    expect(lines.filter(line => line.startsWith('bounded '))).toEqual(suites.map(suite => `bounded ${suite} || status=1`));
    expect(lines.at(-1)).toBe('exit "$status"');
  });

  test('every native target has its own suite bound, above that target\'s slowest measured suite and inside the job timeout', () => {
    const job = workflow.jobs.native as unknown as { steps: Step[]; strategy: { matrix: { target: string[] } }; 'timeout-minutes': number };
    const step = job.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const mapping = /fromJSON\('(\{.*\})'\)\[matrix\.target\]/.exec(step.env!.GBRAIN_NATIVE_SUITE_BOUND_S!)![1]!;
    const bounds = JSON.parse(mapping) as Record<string, string>;
    expect(Object.keys(bounds).sort()).toEqual([...job.strategy.matrix.target].sort());
    // Slowest observed backup-portability-native durations (seconds) per target, 68-78 runs each, 2026-10-19.
    const measuredMax: Record<string, number> = { 'linux-x64-glibc': 94, 'linux-arm64-glibc': 75, 'darwin-arm64': 36, 'darwin-x64': 105, 'win32-arm64': 304, 'win32-x64': 463 };
    for (const [target, bound] of Object.entries(bounds)) {
      expect(Number(bound)).toBeGreaterThanOrEqual(measuredMax[target]! + 60);
      expect(Number(bound)).toBeLessThan(job['timeout-minutes'] * 60 - 300);
    }
  });

  test('a target with no bound fails the step before running any suite', () => {
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$4"; }
      ${step.run}
    `], { env: { PATH: process.env.PATH ?? '' } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('::error::GBRAIN_NATIVE_SUITE_BOUND_S is not set for this target');
    expect(result.stdout.toString()).not.toContain('test/');
  });

  test('a stuck native safety suite is named, sampled and killed inside the job timeout, and the step fails', () => {
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const stuck = suites[2]!;
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { if [[ "$4" == "$GBRAIN_TEST_STUCK_SUITE" ]]; then exec sleep 600; fi; printf '%s\\n' "$4"; }
      ${step.run}
    `], { env: { GBRAIN_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 3600), PATH: process.env.PATH ?? '', GBRAIN_TEST_STUCK_SUITE: stuck, GBRAIN_NATIVE_SUITE_BOUND_S: '2' }, timeout: 60_000 });
    expect(result.exitCode).toBe(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`::error::${stuck} was still running after 2 s, this target's bound`);
    expect(stdout.trim().split('\n').filter(line => line.startsWith('test/'))).toEqual(suites.filter(suite => suite !== stuck));
  });

  test('a stall in every suite still ends the step, with its diagnostics, before the job timeout cancels the log', () => {
    // Two darwin-x64 cells (#7303 on Bun 1.4.0, #7238 on Bun 1.4.3) ran this step into the 15-minute job timeout and kept
    // no log: six suites at a 180 s bound each outlast the job, so the bound's own process table and sample were lost.
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const started = performance.now();
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { exec sleep 600; }
      ${step.run}
    `], { env: { PATH: process.env.PATH ?? '', GBRAIN_NATIVE_SUITE_BOUND_S: '3', GBRAIN_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 90 + 5) }, timeout: 120_000 });
    const seconds = (performance.now() - started) / 1000;
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(1);
    expect(stdout).toContain(`::error::${suites[0]} was still running after 3 s, this target's bound`);
    expect(stdout).toContain(`::error::${suites.at(-1)} not run: the job timeout is near`);
    expect(seconds).toBeLessThan(40);
  }, 130_000);

  test('a suite that outlives SIGKILL is reported and does not hold the step', () => {
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const stuck = suites[1]!;
    const started = performance.now();
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { if [[ "$4" == "$GBRAIN_TEST_STUCK_SUITE" ]]; then exec sleep 40 >/dev/null 2>&1; fi; printf '%s\\n' "$4"; }
      kill() { case "$1" in -TERM|-KILL) return 0 ;; *) command kill "$@" ;; esac; }
      ${step.run}
    `], { env: { PATH: process.env.PATH ?? '', GBRAIN_TEST_STUCK_SUITE: stuck, GBRAIN_NATIVE_SUITE_BOUND_S: '2', GBRAIN_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 3600) }, timeout: 90_000 });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(1);
    expect(stdout).toContain(`::error::${stuck} is still running after SIGKILL`);
    expect((performance.now() - started) / 1000).toBeLessThan(35);
    expect(stdout.trim().split('\n').filter(line => line.startsWith('test/'))).toEqual(suites.filter(suite => suite !== stuck));
  }, 100_000);

  test('the native job records its deadline from its own timeout before any other step', () => {
    const job = workflow.jobs.native as unknown as { steps: Step[]; 'timeout-minutes': number };
    expect(job.steps[0]!.name).toBe('Record the job deadline');
    expect(job.steps[0]!.shell).toBe('bash');
    expect(job.steps[0]!.run!.trim()).toBe(`echo "GBRAIN_JOB_DEADLINE=$(( $(date +%s) + ${job['timeout-minutes']} * 60 ))" >> "$GITHUB_ENV"`);
  });

  for (const failed of ['', ...suites]) test(`every native safety suite runs and failures remain fatal (${failed || 'all pass'})`, () => {
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$4"; [[ "$4" != "$GBRAIN_TEST_FAILED_SUITE" ]]; }
      ${step.run}
    `], { env: { GBRAIN_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 3600), PATH: process.env.PATH ?? '', GBRAIN_TEST_FAILED_SUITE: failed, GBRAIN_NATIVE_SUITE_BOUND_S: '60' } });
    expect(result.exitCode).toBe(failed ? 1 : 0);
    expect(result.stdout.toString().trim().split('\n')).toEqual(suites);
  });

  for (const exitCode of [0, 1]) test(`read diagnostics run with PostgreSQL and retain test failure (${exitCode})`, () => {
    const persistence = load(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
      jobs: { 'deployment-matrix': { steps: Step[] } };
    };
    const step = persistence.jobs['deployment-matrix'].steps.find(entry => entry.name === 'Require PostgreSQL lifecycle, projection and recovery contracts');
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!['continue-on-error']).toBeUndefined();
    expect(step!.env?.GBRAIN_TEST_ALLOW_DATABASE_URL).toBe('1');
    expect(step!.env?.DATABASE_URL).toMatch(/^postgres:\/\/.+\/gbrain_test$/);
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$@"; return ${exitCode}; }
      ${step!.run}
    `], { env: { PATH: process.env.PATH ?? '', ...step!.env } });
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout.toString().trim().split('\n').filter(arg => arg === 'test/persistence-read-diagnostics.test.ts')).toHaveLength(1);
  });

  for (const exitCode of [0, 1]) test(`read latency is advisory without swallowing invalid workloads (${exitCode})`, () => {
    const persistence = load(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
      jobs: { 'read-performance': { steps: Step[]; 'continue-on-error'?: boolean } };
    };
    const job = persistence.jobs['read-performance'];
    const step = job.steps.find(entry => entry.run?.includes('scripts/persistence/performance.ts'))!;
    expect(job['continue-on-error']).toBeUndefined();
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$@"; return ${exitCode}; }
      ${step.run!.replaceAll('${{ matrix.engine }}', 'postgres')}
    `], { env: { PATH: process.env.PATH ?? '', ...step.env } });
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout.toString().trim().split('\n')).toEqual([
      '--no-env-file', 'scripts/persistence/performance.ts', '--engine=postgres',
      '--informational', '--manifest=.context/persistence-read-latency.json',
    ]);
  });

  test('publication and sync safety suites run in separate PostgreSQL-bearing CI processes', () => {
    const persistence = load(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
      jobs: { 'deployment-matrix': { steps: Step[] } };
    };
    const step = persistence.jobs['deployment-matrix'].steps.find(entry => entry.name === 'Require data-safety on PostgreSQL');
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    expect(step!['continue-on-error']).toBeUndefined();
    expect(step!.env?.GBRAIN_TEST_ALLOW_DATABASE_URL).toBe('1');
    expect(step!.env?.DATABASE_URL).toMatch(/^postgres:\/\/.+\/gbrain_test$/);
    expect(step!.run!.trim().split('\n')).toEqual([
      ': "${DATABASE_URL:?Data-safety tests require the explicit test database}"',
      'bun --no-env-file test --timeout=180000 test/persistence-publication-native.serial.test.ts',
      'bun --no-env-file test --timeout=180000 test/persistence-sync-origin-native.test.ts',
      'bun --no-env-file test --timeout=180000 test/persistence-sync-options.serial.test.ts',
      'bun --no-env-file test --timeout=180000 test/persistence-sync-company.serial.test.ts',
    ]);
  });

  test('pull requests and merge-queue runs run a 2,500-write persistence soak while master keeps the full 10,000-write gate', () => {
    const persistence = load(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
      jobs: { invariants: { steps: Step[] } };
    };
    const step = persistence.jobs.invariants.steps.find(entry => entry.run?.includes('scripts/persistence/validate.ts'));
    expect(step).toBeDefined();
    expect(step!.env?.SOAK_OPERATIONS).toBe("${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group') && '2500' || '10000' }}");
    for (const operations of ['2500', '10000']) {
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
        bun() { printf '%s\\n' "$@"; }
        ${step!.run!.replaceAll('${{ matrix.engine }}', 'pglite')}
      `], { env: { PATH: process.env.PATH ?? '', SOAK_OPERATIONS: operations } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().split('\n')).toEqual([
        '--no-env-file', 'scripts/persistence/validate.ts', '--engine=pglite',
        `--operations=${operations}`, '--robot-seconds=0', '--manifest=.context/persistence-manifest.json',
      ]);
    }
  });

  test('the crash robot runs a fixed list beside the soak: scope pr under 820/620 s on pull requests, full under 1200/880 s elsewhere, exploration nightly, Postgres through PgBouncer', () => {
    const persistence = load(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
      jobs: { 'crash-robot': { steps: Step[]; services: Record<string, { env?: Record<string, string> }> } };
    };
    const job = persistence.jobs['crash-robot'];
    expect(job.services.pgbouncer?.env?.POOL_MODE).toBe('transaction');
    const step = job.steps.find(entry => entry.run?.includes('scripts/persistence/validate.ts'));
    expect(step?.env?.ROBOT_SCOPE).toBe("${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group') && 'pr' || 'full' }}");
    expect(step?.env?.ROBOT_SECONDS).toBe("${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group') && (matrix.engine == 'postgres' && '620' || '820') || (matrix.engine == 'postgres' && '880' || '1200') }}");
    expect(step?.env?.ROBOT_EXPLORE).toBe("${{ github.event_name == 'schedule' && 'nightly' || '' }}");
    expect(step?.env?.GBRAIN_PGBOUNCER_URL).toContain(':55433/');
    const argv = (env: Record<string, string>) => Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$@"; }
      ${step!.run!.replaceAll('${{ matrix.engine }}', 'postgres')}
    `], { env: { PATH: process.env.PATH ?? '', ...env } }).stdout.toString().trim().split('\n');
    const head = ['--no-env-file', 'scripts/persistence/validate.ts', '--engine=postgres', '--schedules=0', '--operations=0', '--no-crashes'];
    expect(argv({ ROBOT_SCOPE: 'pr', ROBOT_SECONDS: '820', ROBOT_EXPLORE: '' })).toEqual([...head, '--robot-scope=pr', '--robot-seconds=820',
      '--manifest=.context/persistence-robot.json']);
    const nightly = argv({ ROBOT_SCOPE: 'full', ROBOT_SECONDS: '880', ROBOT_EXPLORE: 'nightly' });
    expect(nightly.slice(0, -2)).toEqual([...head, '--robot-scope=full', '--robot-seconds=880']);
    expect(nightly.at(-2)).toBe(`--explore-day=${Math.floor(Date.now() / 86_400_000)}`);
    expect(nightly.at(-1)).toBe('--manifest=.context/persistence-robot.json');
  });
});
