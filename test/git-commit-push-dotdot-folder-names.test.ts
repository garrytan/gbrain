/**
 * A folder whose name merely starts with two dots (`..drafts`, `..x`) is a normal folder inside a checkout. The commit-push
 * path checks used `relative(root, path).startsWith('..')` for "outside the checkout", which also matches that folder, so
 * `gbrain git commit-push -- ..drafts/a.md` was refused as outside, a `gbrain.sourceRoot` of `..drafts` was dropped (the
 * whole checkout became the source root), an untrack under a managed root named `..x` read gbrain.yml from the wrong place,
 * and a write-through into a source root named `..x` lost its root scope and swept in other folders' pending files.
 * Protects: the folder is accepted and scoped like any other, while `../x`, a real outside directory, a sibling that shares
 * the checkout's name prefix and a symlinked parent that points outside are still refused or dropped.
 * Authoring gate: (1) which paths a commit may name and which folder it is confined to; (2) a startsWith('..') check that
 * is not component-aware; (3) the other commit-push tests only use ordinary folder names; (4) no seam, real temp git
 * repositories with a bare origin and the exported commit entry points.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitAndPush, commitPathsLocked, configuredSourceRoots, notePending, untrackAdmitted } from '../src/core/git/commit-push.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import type { UntrackPageVerdict } from '../src/core/git/untrack-admission.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
const scratch = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-dotdot-${name}-`))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/** A checkout `<dir>/work` on main with `files` committed and pushed to a bare origin; `<dir>/work2` and `<dir>/outside` are siblings. */
function checkout(files: Record<string, string>): { dir: string; root: string } {
  const dir = scratch('repo');
  const root = join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'core.hooksPath', join(dir, 'hooks'));
  for (const [path, body] of Object.entries({ 'seed.md': 'seed\n', ...files })) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
  git(root, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(root, 'push', '-q', '-u', 'origin', 'main');
  for (const sibling of ['work2', 'outside']) put(dir, `${sibling}/a.md`, `${sibling}\n`);
  return { dir, root };
}

const refusalOf = (fn: () => unknown): { code?: string; message?: string } => {
  try { fn(); } catch (e) { return e as { code?: string; message?: string }; }
  throw new Error('expected a refusal');
};
const committedFiles = (root: string, rev = 'HEAD') => git(root, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean).sort();
const SOURCE_ROOT = 'gbrain.sourceRoot';

describe('commit-push scopes a path inside a folder named ..drafts', () => {
  test('a file under ..drafts is committed, not refused as outside the checkout', () => {
    const { root } = checkout({});
    put(root, '..drafts/a.md', 'draft\n');
    const result = commitAndPush({ repo: root, cwd: root, paths: ['..drafts/a.md'], message: 'add a draft' });
    expect(result.outcome).toBe('pushed');
    expect(result.paths).toEqual(['..drafts/a.md']);
    expect(committedFiles(root)).toEqual(['..drafts/a.md']);
  });

  test('the same file named by absolute path and from a cwd inside ..drafts is committed', () => {
    const { root } = checkout({});
    put(root, '..drafts/a.md', 'draft\n');
    put(root, '..drafts/b.md', 'draft b\n');
    expect(commitAndPush({ repo: root, cwd: root, paths: [join(root, '..drafts', 'a.md')], message: 'abs' }).paths).toEqual(['..drafts/a.md']);
    expect(commitAndPush({ repo: root, cwd: join(root, '..drafts'), paths: ['b.md'], message: 'from inside' }).paths).toEqual(['..drafts/b.md']);
  });

  test('paths that really leave the checkout are still refused: ../x, an outside directory, a name-prefix sibling, a symlinked parent', () => {
    const { dir, root } = checkout({});
    symlinkSync(join(dir, 'outside'), join(root, 'linked'));
    const named = ['../outside/a.md', join(dir, 'outside', 'a.md'), join(dir, 'work2', 'a.md'), '../work2/a.md', 'linked/a.md', '..', '../'];
    for (const path of named) {
      const e = refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: [path], message: 'escape' }));
      expect(`${path}: ${e.code}`).toBe(`${path}: commit_paths_invalid`);
      expect(e.message).toMatch(/outside the checkout|whole checkout/);
    }
  });
});

describe('configuredSourceRoots keeps a source root folder named ..drafts', () => {
  test('a relative gbrain.sourceRoot of ..drafts stays the root, and a file elsewhere in the checkout is refused', () => {
    const { root } = checkout({ 'other/b.md': 'other\n' });
    git(root, 'config', SOURCE_ROOT, '..drafts');
    put(root, '..drafts/a.md', 'draft\n');
    expect(configuredSourceRoots(root)).toEqual(['..drafts']);
    put(root, 'other/b.md', 'changed\n');
    expect(refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: ['other/b.md'], message: 'm' })).code).toBe('commit_outside_source_root');
    expect(commitAndPush({ repo: root, cwd: root, paths: ['..drafts/a.md'], message: 'm' }).outcome).toBe('pushed');
  });

  test('an absolute gbrain.sourceRoot that names the ..drafts folder stays the root', () => {
    const { root } = checkout({});
    put(root, '..drafts/a.md', 'draft\n');
    git(root, 'config', SOURCE_ROOT, join(root, '..drafts'));
    expect(configuredSourceRoots(root)).toEqual(['..drafts']);
  });

  test('a source root that is outside the checkout is still dropped (the whole checkout stays the root): ../x, a real outside dir, a name-prefix sibling, ..', () => {
    const { dir, root } = checkout({});
    for (const outside of ['../outside', join(dir, 'outside'), join(dir, 'work2'), '../work2', '..', '../']) {
      git(root, 'config', '--replace-all', SOURCE_ROOT, outside);
      expect(`${outside}: ${JSON.stringify(configuredSourceRoots(root))}`).toBe(`${outside}: [""]`);
    }
  });
});

describe('untrack under a managed root folder named ..x', () => {
  const YML = 'storage:\n  db_only:\n    - arch/\n';
  /** GST-2964: every managed untrack takes its source root from the brain read; this is that read's answer for a source rooted at `sourceRoot`. */
  const rootedAt = (sourceRoot: string): UntrackPageVerdict => ({ sourceId: 'default', sourceRoot, slugRoot: 'source-root', checked: new Set(), live: new Set() });

  test('the db_only admission reads gbrain.yml from ..x at HEAD, not from the checkout root', () => {
    const { root } = checkout({ '..x/gbrain.yml': YML, '..x/arch/a.md': 'a\n' });
    put(root, '..x/.gitignore', 'arch/\n'); put(root, '.gitignore', 'arch/\n');
    const managed = { root: join(root, '..x'), evidence: 'test' };
    expect(untrackAdmitted(root, ['..x/arch/a.md'], managed, rootedAt(join(root, '..x')))).toEqual(['..x/arch/a.md']);
  });

  test('a file outside the managed root, and a managed root outside the checkout, still refuse untrack_not_db_only', () => {
    const { dir, root } = checkout({ '..x/gbrain.yml': YML, '..x/arch/a.md': 'a\n', 'arch/b.md': 'b\n' });
    put(root, '.gitignore', 'arch/\n');
    const managed = { root: join(root, '..x'), evidence: 'test' };
    expect(refusalOf(() => untrackAdmitted(root, ['arch/b.md'], managed, rootedAt(join(root, '..x')))).code).toBe('untrack_not_db_only');
    put(dir, 'outside/gbrain.yml', YML);
    expect(refusalOf(() => untrackAdmitted(root, ['arch/b.md'], { root: join(dir, 'outside'), evidence: 'test' }, rootedAt(join(dir, 'outside')))).code).toBe('untrack_not_db_only');
    expect(refusalOf(() => untrackAdmitted(root, ['arch/b.md'], { root: join(dir, 'work2'), evidence: 'test' }, rootedAt(join(dir, 'work2')))).code).toBe('untrack_not_db_only');
  });
});

describe('write-through commit into a source root folder named ..x', () => {
  /** The checkout holds a pending write-through file in `..x` (inside the source root) and one in `other` (outside it). */
  function pending(rootName: string): { root: string; repo: string } {
    const { root } = checkout({ [`${rootName}/seed.md`]: 'seed\n', 'other/seed.md': 'seed\n' });
    put(root, `${rootName}/a.md`, 'new\n'); put(root, `${rootName}/p.md`, 'pending in root\n'); put(root, 'other/p.md', 'pending outside the source root\n');
    notePending(root, [`${rootName}/p.md`, 'other/p.md']);
    return { root, repo: join(root, rootName) };
  }

  test('the commit keeps the ..x source-root scope: a pending file outside it is not swept in', () => {
    const { root, repo } = pending('..x');
    commitPathsLocked(repo, ['..x/a.md'], 'write-through', { lockWaitMs: 1000 });
    expect(committedFiles(root)).toEqual(['..x/a.md', '..x/p.md']);
    expect(git(root, 'status', '--porcelain', '--', 'other')).toBe('?? other/p.md');
  });

  test('an ordinary source-root folder behaves the same way (control)', () => {
    const { root, repo } = pending('notes');
    commitPathsLocked(repo, ['notes/a.md'], 'write-through', { lockWaitMs: 1000 });
    expect(committedFiles(root)).toEqual(['notes/a.md', 'notes/p.md']);
    expect(git(root, 'status', '--porcelain', '--', 'other')).toBe('?? other/p.md');
  });

  test('a path that leaves the source root checkout is still refused: ../x, an outside directory, a name-prefix sibling', () => {
    const { root, repo } = pending('..x');
    const base = dirname(root);
    for (const path of ['../outside/a.md', join(base, 'outside', 'a.md'), join(base, 'work2', 'a.md')]) {
      expect(refusalOf(() => commitPathsLocked(repo, [path], 'escape', { lockWaitMs: 1000 })).code).toBe('commit_paths_invalid');
    }
  });
});
