import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  jobs: { native: { steps: Step[]; strategy: { matrix: { target: string[]; bun: string[] } } } };
};
const suites = [
  'test/persistence-publication-native.serial.test.ts',
  'test/persistence-git-publication.test.ts',
  'test/persistence-sync-origin-native.serial.test.ts',
  'test/backup-portability-native.serial.test.ts',
];

describe('data-safety native CI coverage', () => {
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
