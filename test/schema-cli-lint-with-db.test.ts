import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-lint-with-db-'));
  const init = await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { home });
  expect(init.exitCode, init.stderr).toBe(0);
  const config = await runCli(['config', 'set', 'schema_pack', 'gbrain-base'], { home });
  expect(config.exitCode, config.stderr).toBe(0);
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema lint DB-plane arguments', () => {
  test.each([
    { args: ['--with-db'] },
    { args: ['--with-db', 'gbrain-base'] },
    { args: ['gbrain-base', '--with-db'] },
    { args: ['--source', 'example-source', '--with-db'] },
    { args: ['--with-db', '--source-id=example-source'] },
  ])('runs DB lint with %j', async ({ args }) => {
    const result = await runCli(['schema', 'lint', ...args, '--json'], { home });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.pack).toBe('gbrain-base');
    expect(report.ok).toBe(true);
    expect(report.warnings.some((warning: { rule: string }) => warning.rule === 'extractable_empty_corpus')).toBe(true);
  });

  test.each([
    { args: ['--with-db', 'missing-example-pack'] },
    { args: ['missing-example-pack', '--with-db'] },
  ])('reports the missing pack with %j', async ({ args }) => {
    const result = await runCli(['schema', 'lint', ...args], { home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Pack not found: missing-example-pack');
    expect(result.stderr).not.toContain('Pack not found: --with-db');
  });

  test('plain lint does not run DB-plane rules', async () => {
    const result = await runCli(['schema', 'lint', '--json'], { home });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.pack).toBe('gbrain-base');
    expect(report.warnings.some((warning: { rule: string }) => warning.rule === 'extractable_empty_corpus')).toBe(false);
  });

  test.each([
    { args: ['gbrain-base', '--pack', 'gbrain-recommended'] },
    { args: ['gbrain-base', '--force'] },
    { args: ['gbrain-base', 'gbrain-recommended'] },
    { args: ['--with-db=false'] },
  ])('rejects unsupported lint arguments %j', async ({ args }) => {
    const result = await runCli(['schema', 'lint', ...args], { home });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('lint clean');
  });
});
