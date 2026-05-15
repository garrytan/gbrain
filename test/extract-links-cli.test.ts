import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
function runCli(...args: string[]) {
  const res = spawnSync('bun', [CLI, 'extract-links', ...args], {
    cwd: resolve(import.meta.dir, '..'),
    encoding: 'utf8',
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

describe('gbrain extract-links CLI', () => {
  test('abi-version emits 1', () => {
    const r = runCli('abi-version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  test('--help works without engine', () => {
    const r = runCli('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('extract-links');
  });

  test('usage error: --path and --dir mutually exclusive', () => {
    const r = runCli('--path', '/tmp/foo.md', '--dir', '/tmp', '--since', '2020-01-01T00:00:00Z', '--filename-prefix', 'X');
    expect(r.status).toBe(2);
  });

  test('--since without --dir is a usage error', () => {
    const r = runCli('--since', '2020-01-01T00:00:00Z');
    expect(r.status).toBe(2);
  });
});
