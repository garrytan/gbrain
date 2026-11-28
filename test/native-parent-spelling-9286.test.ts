/** #9286: new-page parent selection must not weaken recorded-path identity or
 * confinement. Real filesystem cases cover collisions and obstructions absent
 * from the existing native alias simulations; no mocks or new test seams.
 * Managed publication/origin persistence lives in put-page-parent-casing-9286.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFileTarget } from '../src/core/persistence/native-file-target.ts';

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'gbrain-parent-spelling-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const target = (root: string, path: string) => nativeFileTarget(root, join(root, path), undefined, true);

test('new parents reuse nested spelling, retain a missing suffix and never fold the leaf', () => {
  const root = fixture();
  mkdirSync(join(root, 'Projects/Research'), { recursive: true });
  writeFileSync(join(root, 'Projects/Research/Existing.md'), 'existing');
  expect(target(root, 'projects/research/new/sub.md')).toBe(join(root, 'Projects/Research/new/sub.md'));
  expect(target(root, 'projects/research/existing.md')).toBe(join(root, 'Projects/Research/existing.md'));
  expect(existsSync(join(root, 'Projects/Research/new'))).toBe(false);
  expect(readdirSync(root)).toEqual(['Projects']);
});

test('no parent and root-level pages keep their requested spelling', () => {
  const root = fixture();
  expect(target(root, 'unseen/child.md')).toBe(join(root, 'unseen/child.md'));
  expect(target(root, 'Page.md')).toBe(join(root, 'Page.md'));
});

test('recorded paths keep exact POSIX identity instead of opting into parent selection', () => {
  const root = fixture();
  mkdirSync(join(root, 'Projects'));
  const lower = join(root, 'projects');
  // A folding filesystem already aliases these names; its existing native path
  // resolver has separate coverage. Here both exact spellings must coexist.
  if (existsSync(lower)) return;
  mkdirSync(lower);
  expect(nativeFileTarget(root, join(root, 'Projects/one.md'))).toBe(join(root, 'Projects/one.md'));
  expect(nativeFileTarget(root, join(root, 'projects/two.md'))).toBe(join(root, 'projects/two.md'));
  expect(() => target(root, 'projects/new.md')).toThrow('unambiguous native identity');
  expect(() => target(root, 'PROJECTS/new.md')).toThrow('unambiguous native identity');
});

test('a same-fold file obstruction refuses rather than creating a parallel directory', () => {
  const root = fixture();
  writeFileSync(join(root, 'Projects'), 'not a directory');
  expect(() => target(root, 'projects/new.md')).toThrow('regular file');
  expect(readdirSync(root)).toEqual(['Projects']);
});

test('matching symlink parents refuse whether their destination is inside or outside', () => {
  if (process.platform === 'win32') return; // Symlink creation requires a Windows privilege.
  const root = fixture(), outside = fixture();
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'Projects'), 'dir');
  symlinkSync(outside, join(root, 'Outside'), 'dir');
  expect(() => target(root, 'projects/new.md')).toThrow('unambiguous native identity');
  expect(() => target(root, 'outside/new.md')).toThrow('unambiguous native identity');
  expect(readdirSync(outside)).toEqual([]);
});

test('selection cannot escape its source root', () => {
  const root = fixture();
  expect(() => target(root, '../outside.md')).toThrow('unambiguous native identity');
});
