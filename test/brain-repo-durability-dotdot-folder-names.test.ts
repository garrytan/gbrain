/**
 * A folder whose name merely starts with two dots (`..drafts`, `..x`) is a normal folder in a brain checkout. Three checks
 * in brain-repo-durability used `relative(a, b).startsWith('..')` for "outside", which also matches that folder:
 *   - resolveHooksDir called a `core.hooksPath` of `..hooks` (inside the working tree) "not tracked", so `gbrain sources
 *     harden` installed its hook there without adding it to .git/info/exclude (it then shows up as an untracked file);
 *   - commitWriteThroughFile returned false for a page file under `..drafts/`, so the write was never committed;
 *   - recordSourceRoot skipped a source folder named `..x`, so the checkout kept the whole repo as its source root.
 * Slug validation lets these through: validateSlug only refuses a whole `..` path component, not `..drafts`.
 * Protects: such a folder is handled like any other, while a hooks dir outside the checkout, a sibling sharing the checkout's
 * name prefix, a path that leaves the checkout and a symlinked parent that points outside stay refused or unrecorded.
 * Authoring gate: (1) where the harden hook is excluded, whether a write-through file is committed and which source root is
 * recorded; (2) a startsWith('..') check that is not component-aware; (3) the durability tests only use ordinary folder
 * names; (4) no seam, real temp git repositories through hardenBrainRepo and the exported helpers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWriteThroughFile, hardenBrainRepo, resolveHooksDir } from '../src/core/brain-repo-durability.ts';
import { validateSlug } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cfgAll = (cwd: string, key: string) => { try { return git(cwd, 'config', '--local', '--get-all', key).split('\n'); } catch { return []; } };

let root: string;
let work: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-dotdot-durable-')));
  home = join(root, 'home');
  mkdirSync(home);
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.name', 'Example Writer'); git(work, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'init');
  for (const sibling of ['work2', 'outside']) { mkdirSync(join(root, sibling)); writeFileSync(join(root, sibling, 'a.md'), `${sibling}\n`); }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Harden without the push-probe: no remote is needed and no scaffolding commit fires the new hook. HOME and GBRAIN_HOME stay under the temp dir. */
const harden = (repoPath: string) => withEnv({ HOME: home, GBRAIN_HOME: home }, () =>
  hardenBrainRepo({ repoPath, sourceId: 'wiki', installCron: false, verify: false }));
const status = (path: string) => git(work, 'status', '--porcelain', '--untracked-files=all', '--', path);

describe('resolveHooksDir and harden treat a hooks dir named ..hooks as inside the checkout', () => {
  test('core.hooksPath=..hooks is a tracked location, so the hook is excluded and stays out of git status', async () => {
    git(work, 'config', 'core.hooksPath', '..hooks');
    expect(resolveHooksDir(work)).toEqual({ dir: join(work, '..hooks'), tracked: true });
    await harden(work);
    expect(existsSync(join(work, '..hooks', 'post-commit'))).toBe(true);
    expect(readFileSync(join(work, '.git', 'info', 'exclude'), 'utf8')).toContain('..hooks/post-commit');
    expect(status('..hooks/post-commit')).toBe('');
  });

  test('a hooks dir outside the checkout, a name-prefix sibling, ../hooks and the git dir are not tracked locations', () => {
    for (const hooksPath of [join(root, 'outside'), join(root, 'work2', 'hooks'), '../outside', '../work2/hooks', '../work2', '.git/hooks']) {
      git(work, 'config', 'core.hooksPath', hooksPath);
      expect(`${hooksPath}: ${resolveHooksDir(work).tracked}`).toBe(`${hooksPath}: false`);
    }
  });
});

describe('commitWriteThroughFile commits a page file under a folder named ..drafts', () => {
  test('the slug passes validation and the file is committed by itself', () => {
    expect(validateSlug('..drafts/a')).toBe('..drafts/a');
    mkdirSync(join(work, '..drafts'));
    writeFileSync(join(work, '..drafts', 'a.md'), 'draft\n');
    writeFileSync(join(work, 'stray.md'), 'another writer\n');
    expect(commitWriteThroughFile(work, join(work, '..drafts', 'a.md'), '..drafts/a')).toBe(true);
    expect(git(work, 'show', '--name-only', '--format=', 'HEAD')).toBe('..drafts/a.md');
    expect(git(work, 'status', '--porcelain')).toBe('?? stray.md');
  });

  test('files that are not inside the checkout are refused: ../x, an outside directory, a name-prefix sibling, the checkout itself, a symlinked parent', () => {
    symlinkSync(join(root, 'outside'), join(work, 'linked'));
    const head = git(work, 'rev-parse', 'HEAD');
    for (const path of [join(work, '..', 'outside', 'a.md'), join(root, 'outside', 'a.md'), join(root, 'work2', 'a.md'), work, join(work, 'linked', 'a.md')]) {
      expect(`${path}: ${commitWriteThroughFile(work, path, 'x')}`).toBe(`${path}: false`);
    }
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(root, 'outside', 'a.md'), 'utf8')).toBe('outside\n');
  });
});

describe('hardenBrainRepo records a source folder named ..x as the checkout source root', () => {
  const SOURCE_ROOT = 'gbrain.sourceRoot';

  test('a source path of <checkout>/..x is recorded as gbrain.sourceRoot', async () => {
    mkdirSync(join(work, '..x'));
    writeFileSync(join(work, '..x', 'note.md'), '# note\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'source folder');
    const report = await harden(join(work, '..x'));
    expect(report.repo_path).toBe(work);
    expect(cfgAll(work, SOURCE_ROOT)).toEqual(['..x']);
  });

  test('an ordinary source folder is recorded and a source at the checkout root records nothing (control)', async () => {
    mkdirSync(join(work, 'brain'));
    writeFileSync(join(work, 'brain', 'note.md'), '# note\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'source folder');
    await harden(join(work, 'brain'));
    expect(cfgAll(work, SOURCE_ROOT)).toEqual(['brain']);
    const other = join(root, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    git(other, 'config', 'user.name', 'Example Writer'); git(other, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(other, 'README.md'), 'x\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'init');
    await harden(other);
    expect(cfgAll(other, SOURCE_ROOT)).toEqual([]);
  });

  test('a source path that is a symlink out of the checkout hardens the repo it points to and never records a ../ root', async () => {
    symlinkSync(join(root, 'outside'), join(work, 'linked'));
    execFileSync('git', ['init', '-q', '-b', 'main', join(root, 'outside')]);
    git(join(root, 'outside'), 'config', 'user.name', 'Example Writer'); git(join(root, 'outside'), 'config', 'user.email', 'writer@example.invalid');
    git(join(root, 'outside'), 'add', '.'); git(join(root, 'outside'), 'commit', '-qm', 'init');
    const report = await harden(join(work, 'linked'));
    expect(report.repo_path).toBe(join(root, 'outside'));
    expect(cfgAll(work, SOURCE_ROOT)).toEqual([]);
    expect(cfgAll(join(root, 'outside'), SOURCE_ROOT)).toEqual([]);
  });
});
