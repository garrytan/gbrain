import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { family, GLIBC } from 'detect-libc';

const supported = process.platform === 'linux' && await family() === GLIBC;
const roots: string[] = [];
let interposer: string;
function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-export-fault-')));
  roots.push(path);
  return path;
}

describe.skipIf(!supported)('native export OS fault injection (Linux glibc)', () => {
  beforeAll(() => {
    interposer = join(temporary(), 'faults.so');
    const compile = Bun.spawnSync(['cc', '-shared', '-fPIC', resolve(import.meta.dir, 'fixtures/native-export-faults.c'), '-ldl', '-o', interposer]);
    expect(compile.exitCode).toBe(0);
  });
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  test.each(['write', 'flush', 'directory-flush', 'complete-flush', 'crash'])('retains honest incomplete evidence after %s failure', async fault => {
    const root = temporary();
    const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'fixtures/native-export-process.ts'), root, 'publish'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, LD_PRELOAD: interposer, GBRAIN_EXPORT_TEST_FAULT: fault },
    });
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(join(root, '.gbrain-export-status'), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\n');
    const names = readdirSync(root);
    const staged = names.filter(name => /^\.gbrain-export-[0-9a-f]{32}\.tmp$/.test(name));
    if (fault === 'crash') {
      expect(staged).toHaveLength(1);
      expect(readFileSync(join(root, staged[0]!))).toEqual(Buffer.alloc(16, 42));
    } else expect(staged).toEqual([]);
    expect(names.includes('data')).toBe(fault === 'complete-flush' || fault === 'directory-flush');
  });

  test('retries interrupted and short OS writes until every byte is flushed', async () => {
    const root = temporary();
    const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'fixtures/native-export-process.ts'), root, 'publish'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, LD_PRELOAD: interposer, GBRAIN_EXPORT_TEST_FAULT: 'short-write' },
    });
    expect(await child.exited).toBe(0);
    expect(readFileSync(join(root, 'data'))).toEqual(Buffer.alloc(4096, 42));
    expect(readFileSync(join(root, '.gbrain-export-status'), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\nCOMPLETE\n');
  });
});
