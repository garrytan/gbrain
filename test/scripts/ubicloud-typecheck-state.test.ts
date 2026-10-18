/**
 * scripts/ubicloud/typecheck-state.ts: the gate uploads the buildinfo that
 * `bun run typecheck` itself writes, built from the gate's own checkout, so
 * verify's typecheck on the VM runs incrementally instead of cold.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTypecheckState, portableBuildInfo, typecheckBuildInfo } from '../../scripts/ubicloud/typecheck-state.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (pkg: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-typecheck-state-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
};

test("the buildinfo is the one the repo's typecheck script writes", () => {
  const script = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.typecheck!;
  expect(script).toContain('--incremental');
  expect(typecheckBuildInfo(ROOT)).toBe('node_modules/.cache/gbrain-typecheck.tsbuildinfo');
  expect(typecheckBuildInfo(scratch({ scripts: { typecheck: 'tsc --noEmit' } }))).toBeNull();
  expect(typecheckBuildInfo(scratch({}))).toBeNull();
  expect(typecheckBuildInfo(join(tmpdir(), 'gbrain-no-such-checkout'))).toBeNull();
});

test('building the state runs the typecheck script and reports its exit code, even when it fails', async () => {
  const dir = scratch({ scripts: { typecheck: `echo checked > out.txt && exit 3` } });
  const spawned: number[] = [];
  const result = await buildTypecheckState(dir, join(dir, 'log.txt'), child => spawned.push(child.pid ?? -1));
  expect(result.code).toBe(3);
  expect(spawned).toHaveLength(1);
  expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('checked\n');
  expect(existsSync(join(dir, 'log.txt'))).toBe(true);
});

test('entries reached through a symlinked node_modules are re-rooted under the checkout, so they resolve on the VM', () => {
  const top = mkdtempSync(join(tmpdir(), 'gbrain-typecheck-portable-'));
  dirs.push(top);
  const shared = join(top, 'main', 'node_modules'), root = join(top, 'work', 'gate');
  mkdirSync(join(shared, '.cache'), { recursive: true });
  mkdirSync(root, { recursive: true });
  symlinkSync(shared, join(root, 'node_modules'));
  const climb = '../'.repeat(join(root, 'node_modules', '.cache').split('/').length - 1);
  // What tsc 5.9 wrote from such a worktree (#6673): sources relative to the buildinfo, node_modules files through their real path.
  writeFileSync(join(shared, '.cache', 'tc.tsbuildinfo'), JSON.stringify({
    fileNames: [`${climb}${shared.slice(1)}/typescript/lib/lib.es5.d.ts`, `${climb}${shared.slice(1)}/@types/bun/node_modules/bun-types/globals.d.ts`, '../../src/core/engine.ts', `${climb}${top.slice(1)}/elsewhere/x.ts`],
    fileInfos: [], version: '5.9.3',
  }));
  const out = join(top, 'portable.tsbuildinfo');
  expect(portableBuildInfo(root, 'node_modules/.cache/tc.tsbuildinfo', out)).toEqual({ moved: 2, outside: 1 });
  const written = JSON.parse(readFileSync(out, 'utf8')) as { fileNames: string[]; version: string };
  expect(written.fileNames.slice(0, 3)).toEqual(['../typescript/lib/lib.es5.d.ts', '../@types/bun/node_modules/bun-types/globals.d.ts', '../../src/core/engine.ts']);
  expect(written.version).toBe('5.9.3');

  const plain = join(top, 'plain');
  mkdirSync(join(plain, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(join(plain, 'node_modules', '.cache', 'tc.tsbuildinfo'), JSON.stringify({ fileNames: ['../typescript/lib/lib.es5.d.ts', '../../src/a.ts'] }));
  expect(portableBuildInfo(plain, 'node_modules/.cache/tc.tsbuildinfo', out)).toEqual({ moved: 0, outside: 0 });
  expect((JSON.parse(readFileSync(out, 'utf8')) as { fileNames: string[] }).fileNames).toEqual(['../typescript/lib/lib.es5.d.ts', '../../src/a.ts']);
  writeFileSync(join(plain, 'node_modules', '.cache', 'tc.tsbuildinfo'), '{}');
  expect(portableBuildInfo(plain, 'node_modules/.cache/tc.tsbuildinfo', out)).toBeNull();
});
