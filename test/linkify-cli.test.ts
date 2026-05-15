import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = ['run', 'src/cli.ts', 'linkify'];

function runCli(...args: string[]) {
  const res = spawnSync('bun', [...CLI, ...args], { encoding: 'utf8', cwd: process.cwd() });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

describe('gbrain linkify CLI', () => {
  test('abi-version emits 1', () => {
    const r = runCli('abi-version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  test('--help works without engine', () => {
    const r = runCli('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('linkify');
  });

  test('usage error: <file> and --dir mutually exclusive', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'linkify-cli-'));
    try {
      const f = join(tmp, 'x.md');
      writeFileSync(f, 'content');
      const r = runCli(f, '--dir', tmp, '--since', '2020-01-01T00:00:00Z', '--filename-prefix', 'x');
      expect(r.status).toBe(2);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('--since without --dir is a usage error', () => {
    const r = runCli('--since', '2020-01-01T00:00:00Z');
    expect(r.status).toBe(2);
  });
});
