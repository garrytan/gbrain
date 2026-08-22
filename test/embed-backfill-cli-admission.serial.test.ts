/**
 * Public CLI admission for embed-backfill on PGLite.
 *
 * A background submit has no persistent worker to drain it and must fail
 * without a row. `--follow` is the narrow exception because that process
 * immediately starts an inline worker and waits for the terminal result.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runJobs } from '../src/commands/jobs.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
let isolatedHome = '';

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    GBRAIN_HOME: isolatedHome,
  };
  for (const key of [
    'DATABASE_URL',
    'GBRAIN_DATABASE_URL',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'DEEP_SEEK_API_KEY',
  ]) delete env[key];
  return spawnSync('bun', [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-embed-admission-'));
  const init = run(['init', '--pglite', '--no-embedding', '--non-interactive']);
  expect(init.status, init.stderr).toBe(0);
});

afterEach(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

describe('jobs submit embed-backfill — PGLite worker surface', () => {
  test('background submit refuses with a direct drain remedy and writes no row', () => {
    const submit = run([
      'jobs',
      'submit',
      'embed-backfill',
      '--params',
      '{"sourceId":"default"}',
    ]);

    expect(submit.status).toBe(1);
    expect(submit.stderr).toContain('PGLite has no persistent worker');
    expect(submit.stderr).toContain('gbrain embed --stale --source default');

    const list = run(['jobs', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
  }, 30_000);

  test('--dry-run evaluates admission and refuses instead of claiming it would submit', () => {
    const submit = run([
      'jobs',
      'submit',
      'embed-backfill',
      '--params',
      '{"sourceId":"default"}',
      '--dry-run',
    ]);

    expect(submit.status).toBe(1);
    expect(submit.stdout).not.toContain('Would submit');
    expect(submit.stderr).toContain('PGLite has no persistent worker');
    expect(submit.stderr).toContain('gbrain embed --stale --source default');

    const list = run(['jobs', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
  }, 30_000);

  test('metacharacter source id is rejected without a paste-ready injected remedy', () => {
    const submit = run([
      'jobs',
      'submit',
      'embed-backfill',
      '--params',
      '{"sourceId":"default; printf injected"}',
    ]);

    expect(submit.status).toBe(1);
    expect(submit.stderr).toContain('Invalid source_id');
    expect(submit.stderr).not.toContain('gbrain embed --stale --source default;');

    const list = run(['jobs', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
  }, 30_000);

  test('after admission, stale schema still fails before shell payload validation', async () => {
    const staleEngine = new PGLiteEngine();
    await staleEngine.connect({});
    await staleEngine.initSchema();
    await staleEngine.setConfig('version', '0');
    const origExit = process.exit;
    const origError = console.error;
    const errors: string[] = [];
    process.exit = (() => { throw new Error('__exit__'); }) as typeof process.exit;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      await expect(runJobs(staleEngine, ['submit', 'shell', '--params', '{}'])).rejects.toThrow('__exit__');
    } finally {
      process.exit = origExit;
      console.error = origError;
      await staleEngine.disconnect();
    }

    const stderr = errors.join('\n');
    expect(stderr).toContain('minion_jobs table not found (schema version 0');
    expect(stderr).not.toContain('shell: specify exactly one of cmd or argv');
  }, 30_000);

  test('--follow normalizes a padded name before admission and drains inline', () => {
    const submit = run([
      'jobs',
      'submit',
      ' embed-backfill ',
      '--params',
      '{"sourceId":"default"}',
      '--follow',
    ]);

    expect(submit.status, submit.stderr).toBe(0);
    expect(submit.stdout).toContain('Executing inline');
    expect(submit.stdout).toContain('completed');

    const list = run(['jobs', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    const jobs = JSON.parse(list.stdout) as Array<{ name: string; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'embed-backfill', status: 'completed' });
  }, 30_000);
});
