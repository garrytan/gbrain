import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeLoad } from 'js-yaml';

type Step = {
  name?: string;
  if?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};
const workflow = safeLoad(readFileSync(join(import.meta.dir, '../../.github/workflows/native-locks.yml'), 'utf8')) as {
  jobs: {
    native: { steps: Step[]; strategy: { matrix: { target: string[]; bun: string[] } } };
    'windows-backup-console': { steps: Step[]; 'runs-on': string; 'timeout-minutes': number;
      strategy: { 'fail-fast': boolean; matrix: { include: { runner: string; bun: string }[] } } };
    'windows-backup-dotnet': { steps: Step[]; 'runs-on': string; 'timeout-minutes': number;
      strategy: { 'fail-fast': boolean; matrix: { include: { runner: string; bun: string }[] } } };
  };
};
const suites = [
  'test/persistence-publication-native.serial.test.ts',
  'test/persistence-git-publication.test.ts',
  'test/persistence-sync-origin-native.serial.test.ts',
  'test/backup-portability-native.serial.test.ts',
];

describe('data-safety native CI coverage', () => {
  test('the opt-in console diagnostic has an isolated Windows matrix without filtering the acceptance suites', () => {
    const job = workflow.jobs['windows-backup-console'];
    expect(job['runs-on']).toBe('${{ matrix.runner }}');
    expect(job['timeout-minutes']).toBe(5);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include).toEqual(['windows-2022', 'windows-11-arm'].flatMap(runner =>
      ['1.3.11', '1.3.13', '1.4.2'].map(bun => ({ runner, bun }))));
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

  test('the direct dotnet program comparison has its own six-cell opt-in Windows job', () => {
    const job = workflow.jobs['windows-backup-dotnet'];
    expect(job['runs-on']).toBe('${{ matrix.runner }}');
    expect(job['timeout-minutes']).toBe(5);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include).toEqual(['windows-2022', 'windows-11-arm'].flatMap(runner =>
      ['1.3.11', '1.3.13', '1.4.2'].map(bun => ({ runner, bun }))));
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
    });
    expect(step!.run!.trim().split('\n')).toEqual([
      'status=0',
      ...suites.map(suite => `bun --no-env-file test --timeout=180000 ${suite} || status=1`),
      'exit "$status"',
    ]);
  });

  for (const failed of ['', ...suites]) test(`every native safety suite runs and failures remain fatal (${failed || 'all pass'})`, () => {
    const step = workflow.jobs.native.steps.find(entry => entry.name === 'Verify native data-safety contracts')!;
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', `
      bun() { printf '%s\\n' "$4"; [[ "$4" != "$GBRAIN_TEST_FAILED_SUITE" ]]; }
      ${step.run}
    `], { env: { PATH: process.env.PATH ?? '', GBRAIN_TEST_FAILED_SUITE: failed } });
    expect(result.exitCode).toBe(failed ? 1 : 0);
    expect(result.stdout.toString().trim().split('\n')).toEqual(suites);
  });

  for (const exitCode of [0, 1]) test(`read diagnostics run with PostgreSQL and retain test failure (${exitCode})`, () => {
    const persistence = safeLoad(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
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
    const persistence = safeLoad(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
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
    const persistence = safeLoad(readFileSync(join(import.meta.dir, '../../.github/workflows/persistence-validation.yml'), 'utf8')) as {
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
      'bun --no-env-file test --timeout=180000 test/persistence-sync-origin-native.serial.test.ts',
      'bun --no-env-file test --timeout=180000 test/persistence-sync-options.serial.test.ts',
      'bun --no-env-file test --timeout=180000 test/persistence-sync-company.serial.test.ts',
    ]);
  });
});
