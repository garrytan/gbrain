/**
 * scripts/ubicloud/typecheck-state.ts: the gate uploads the buildinfo that
 * `bun run typecheck` itself writes, built from the gate's own checkout, so
 * verify's typecheck on the VM runs incrementally instead of cold.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTypecheckState, typecheckBuildInfo } from '../../scripts/ubicloud/typecheck-state.ts';

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
