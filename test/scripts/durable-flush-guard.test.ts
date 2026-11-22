/**
 * #5595/#5475: scripts/check-durable-flush.ts fails on an fsyncSync of a
 * read-only descriptor (file or directory) anywhere in src/ outside
 * src/core/fs-durable.ts, and leaves flushes of write descriptors alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-durable-flush.ts');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(files: Record<string, string>, root?: string) {
  const tree = root ?? mkdtempSync(join(tmpdir(), 'gbrain-durable-flush-'));
  if (!root) dirs.push(tree);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(tree, rel, '..'), { recursive: true });
    writeFileSync(join(tree, rel), body);
  }
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: tree } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const IMPORTS = "import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';\nimport * as fs from 'node:fs';\n";

describe('check-durable-flush.ts', () => {
  test.each([
    ['a file opened with r', "export function f(p: string) {\n  const fd = openSync(p, 'r');\n  try { fsyncSync(fd); } finally { closeSync(fd); }\n}"],
    ['flags omitted', "export function f(p: string) {\n  const fd = openSync(p);\n  fsyncSync(fd); closeSync(fd);\n}"],
    ['an unguarded directory flush via O_RDONLY', "export function f(p: string) {\n  const dir = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY);\n  try { fsyncSync(dir); } finally { closeSync(dir); }\n}"],
    ['a let assigned inside try', "export function f(p: string) {\n  let fd: number | undefined;\n  try { fd = openSync(p, 'r'); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); }\n}"],
    ['the fs namespace form', "export function f(p: string) {\n  const fd = fs.openSync(p, 'r');\n  fs.fsyncSync(fd); fs.closeSync(fd);\n}"],
    ['an inline open', "export function f(p: string) { fsyncSync(openSync(p, 'r')); }"],
    ['flags the guard cannot read', "export function f(p: string, flags: string) {\n  const fd = openSync(p, flags);\n  fsyncSync(fd); closeSync(fd);\n}"],
  ])('%s fails with code, location, fix and docs anchor', (_label, body) => {
    const r = run({ 'src/core/persistence/writer.ts': IMPORTS + body + '\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [durable_flush_read_handle]: src/core/persistence/writer.ts:');
    expect(r.out).toContain('Fix: fsync the descriptor you wrote through before closing it, or call flushFile/flushDirectory from src/core/fs-durable.ts');
    expect(r.out).toContain('See:  docs/ci-guards.md#durable-flush-guard');
  });

  test('write-descriptor flushes, fs-durable itself and same-named descriptors in other functions pass', () => {
    const r = run({
      'src/core/fs-durable.ts': IMPORTS + "export function flushDirectory(p: string) { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }\n",
      'src/core/backup/archive.ts': IMPORTS + [
        "export function read(p: string) { const fd = openSync(p, 'r'); closeSync(fd); }",
        "export function write(p: string, b: Buffer) { const fd = openSync(p, 'wx', 0o600); writeSync(fd, b); fsyncSync(fd); closeSync(fd); }",
        "export function append(p: string) { const fd = openSync(p, 'r+'); fsyncSync(fd); closeSync(fd); }",
        "export function exclusive(p: string) { const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); fsyncSync(fd); closeSync(fd); }",
        "export function given(fd: number) { fsyncSync(fd); }",
      ].join('\n') + '\n',
    });
    expect(r.out).toContain('check-durable-flush: ok');
    expect(r.code).toBe(0);
  });

  test('the self-upgrade download is no longer allowlisted: a read-only flush there fails', () => {
    const r = run({ 'src/core/binary-self-update.ts': IMPORTS + "export function f(p: string) { const fd = openSync(p, 'r'); fsyncSync(fd); closeSync(fd); }\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [durable_flush_read_handle]: src/core/binary-self-update.ts');
  });

  test('the repository passes', () => {
    const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: REPO } });
    expect(`${r.stdout}${r.stderr}`).toContain('check-durable-flush: ok');
    expect(r.status).toBe(0);
  });
});
