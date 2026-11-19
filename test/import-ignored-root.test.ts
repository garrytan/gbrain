/**
 * `foresights import <dir>` where the enclosing git repository ignores `dir`
 * itself (a scratch or cache folder inside a checkout, such as the scale
 * tier's `.context/scale-corpus`). `git ls-files --exclude-standard` lists
 * nothing there, so collection used to return zero files and the import
 * reported success with `total_files: 0`. The explicitly named directory is
 * now walked directly; files the repository merely ignores elsewhere keep
 * honoring `.gitignore`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { collectSyncableFiles } from '../src/commands/import.ts';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-ignored-root-'));
  execSync('git init -q', { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), '.context/\nscratch/\n');
  writeFileSync(join(repo, 'tracked.md'), '---\ntitle: Tracked\n---\nbody\n');
  for (const dir of ['.context/corpus/notes', 'scratch/corpus']) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'one.md'), '---\ntitle: One\n---\nbody\n');
    writeFileSync(join(repo, dir, 'two.md'), '---\ntitle: Two\n---\nbody\n');
  }
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

test('an ignored directory named explicitly is walked, including one under a dot-directory', () => {
  const corpus = join(repo, '.context/corpus');
  expect(collectSyncableFiles(corpus, { strategy: 'markdown' }).map(f => relative(corpus, f)).sort())
    .toEqual(['notes/one.md', 'notes/two.md']);
  const scratch = join(repo, 'scratch/corpus');
  expect(collectSyncableFiles(scratch, { strategy: 'markdown' }).map(f => relative(scratch, f)).sort())
    .toEqual(['one.md', 'two.md']);
});

test('importing the repository root still honors .gitignore', () => {
  expect(collectSyncableFiles(repo, { strategy: 'markdown' }).map(f => relative(repo, f))).toEqual(['tracked.md']);
});
