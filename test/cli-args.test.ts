import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  describe('positional/flag overwrite warning (#2822)', () => {
    const errors: string[] = [];
    const origError = console.error;
    const captureErrors = () => {
      console.error = (...args: unknown[]) => errors.push(args.join(' '));
    };
    afterEach(() => {
      console.error = origError;
      errors.length = 0;
    });

    test('a flag that overwrites a positional value warns to stderr', () => {
      captureErrors();
      const params = parseOpArgs(operationsByName.query, ['positional text', '--query', 'flag text']);
      expect(params.query).toBe('flag text');
      expect(errors.some(e => e.includes('Warning') && e.includes('--query'))).toBe(true);
    });

    test('a positional that overwrites an earlier flag value warns to stderr', () => {
      captureErrors();
      const params = parseOpArgs(operationsByName.query, ['--query', 'flag text', 'positional text']);
      expect(params.query).toBe('positional text');
      expect(errors.some(e => e.includes('Warning') && e.includes('<query>'))).toBe(true);
    });

    test('no warning when flag and positional agree', () => {
      captureErrors();
      parseOpArgs(operationsByName.query, ['same', '--query', 'same']);
      expect(errors).toEqual([]);
    });
  });
});

describe('gbrain put — empty non-TTY stdin rejects (#2822)', () => {
  const REPO = resolve(import.meta.dir, '..');
  const CLI = join(REPO, 'src', 'cli.ts');

  const runPut = (input: string) => {
    // Isolated HOME so a regression can never write into a real brain.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-put-empty-'));
    try {
      return spawnSync('bun', [CLI, 'put', 'inbox/empty-stdin-test'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        input,
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test('empty stdin exits 1 and names the missing content param', () => {
    const res = runPut('');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('content');
    expect(res.stderr).toContain('stdin');
  }, 90_000);

  test('whitespace-only stdin also exits 1', () => {
    const res = runPut('   \n\t\n');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('stdin');
  }, 90_000);
});
