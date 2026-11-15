/** GST-2116, GST-2767: which named paths a commit-push left out, and why, in words an operator can act on. */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { literalPathspecs } from '../git-env.ts';
import { canonicalFilesystemPath } from '../persistence/root-registry.ts';
import { git, gitOk } from './git-run.ts';

export interface SkippedPath { path: string; reason: 'assume_unchanged' | 'skip_worktree' | 'not_staged' | 'staged_for_removal'; why: string }

export const STAGED_FOR_REMOVAL_WHY = 'the index holds it as staged for removal from Git (as after git rm --cached) while the file stays on disk, and commit-push neither commits that removal nor adds the file back unasked';

/** The files under `rel` the index holds as staged for removal (HEAD has them, the index does not) whose bytes are still on disk. */
export function stagedRemovals(root: string, rel: string[]): string[] {
  if (!rel.length) return [];
  return gitOk(root, ['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=D', '-z', '--', ...literalPathspecs(rel)], 'diff --cached')
    .split('\0').filter(path => { try { return !!path && !lstatSync(join(root, path)).isDirectory(); } catch { return false; } });
}

/** The flagged index entries in `listed` (`ls-files -v`: lower case for assume-unchanged, S for skip-worktree) whose bytes on disk HEAD lacks. A skip-worktree entry absent from disk is a sparse checkout, not a change. */
export function flaggedChanges(root: string, listed: string[]): SkippedPath[] {
  const changed: SkippedPath[] = [];
  const flagged = listed.filter(entry => /^[a-zS] /.test(entry));
  const gitlinks = new Set(flagged.length
    ? gitOk(root, ['ls-files', '-s', '-z', '--', ...literalPathspecs(flagged.map(line => line.slice(2)))], 'ls-files -s')
      .split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1))
    : []);
  for (const line of flagged) {
    const path = line.slice(2);
    if (gitlinks.has(path)) continue;
    const abs = join(root, path);
    const reason = /^[sS]/.test(line) ? 'skip_worktree' as const : 'assume_unchanged' as const;
    const stat = (() => { try { return lstatSync(abs); } catch { return null; } })();
    if (!stat && reason === 'skip_worktree') continue;
    const hashed = !stat ? null : stat.isSymbolicLink()
      ? git(root, ['hash-object', '--stdin'], { input: readlinkSync(abs) })
      : git(root, ['hash-object', '--', path]);
    // An entry git cannot hash (a missing required filter, an unreadable file, a directory now) counts as changed, so it is reported, never dropped.
    const disk = hashed && (hashed.code === 0 ? hashed.stdout.trim() : undefined);
    const committed = git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]).stdout.trim() || null;
    if (disk !== committed) changed.push({ path, reason, why: reason === 'skip_worktree'
      ? 'the index entry carries the skip-worktree flag, so git add does not see the edit on disk'
      : 'the index entry carries the assume-unchanged flag, so git add does not see the edit on disk' });
  }
  return changed;
}

/**
 * GST-2116: the named paths whose bytes on disk HEAD still lacks once the commit step is done. `git add -A` stages
 * nothing and exits 0 for a modified entry flagged assume-unchanged or skip-worktree (`ls-files -v`: lower case, or S;
 * `commit --only` may still pick one up beside another path, so the check reads HEAD) and for a file inside an untracked
 * nested repository. A skip-worktree entry absent from disk is a sparse checkout, not a change, and a flagged gitlink
 * is left out (its commit lives in the nested repository, which hash-object cannot read). Ignored files under a named
 * directory are left out as git leaves them; a named ignored file is refused by `git add` itself.
 */
export function unstagedPaths(root: string, rel: string[], listed: string[], dirtyBefore: Map<string, string>, sha: string | null): SkippedPath[] {
  const skipped = new Map(flaggedChanges(root, listed).map(s => [s.path, s]));
  const notStaged = (path: string, why: string) => { if (!skipped.has(path)) skipped.set(path, { path, reason: 'not_staged', why }); };
  const removed = new Set(stagedRemovals(root, rel));
  for (const path of unindexedFiles(root, rel, listed)) {
    if (removed.has(path)) { skipped.set(path, { path, reason: 'staged_for_removal', why: STAGED_FOR_REMOVAL_WHY }); continue; }
    const nested = nestedRepositoryOf(root, path);
    notStaged(path, nested ? `it sits inside the nested Git repository ${nested}, so git add stages nothing for it` : 'git add left it out of the index');
  }
  // Only a named directory can hide an unstaged change from the two checks above (a nested repository inside it).
  const dirs = rel.filter(path => { try { return lstatSync(join(root, path)).isDirectory(); } catch { return false; } });
  // Status lists nothing under a directory that sits inside an untracked nested repository.
  for (const path of dirs) {
    const nested = nestedRepositoryOf(root, path);
    if (nested) notStaged(path, `it sits inside the nested Git repository ${nested}, so git add stages nothing under it`);
  }
  // GST-2128: an entry that was clean before the add, or a tracked one this commit carried, is another writer's later change, not a skip.
  const status = directoryStatus(root, dirs);
  const carried = sha && status.size ? committedModes(root, sha) : new Map<string, string>();
  for (const [path, xy] of status) {
    if (xy[1] === ' ' || skipped.has(path) || !dirtyBefore.has(path)) continue;
    if (xy !== '??' && carried.has(path) && carried.get(path) !== '160000') continue;
    notStaged(path, xy === '??' ? 'it is still untracked after the commit' : `it still differs from the last commit after the commit (git status ${xy.trim()})`);
  }
  return [...skipped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * GST-2767: the directory above `path` (repository-relative) that Git treats as a nested repository, or null. A `.git`
 * entry alone is not one: an empty or broken `.git` left under a source path is ignored by git, which stages and commits
 * the files beneath it, so only a directory that is its own work-tree top level counts.
 */
export function nestedRepositoryOf(root: string, path: string): string | null {
  const parts = path.split('/');
  const own = git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!existsSync(join(root, dir, '.git'))) continue;
    const top = git(join(root, dir), ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || canonicalFilesystemPath(top.stdout.trim()) !== canonicalFilesystemPath(join(root, dir))) continue;
    const gitDir = git(join(root, dir), ['rev-parse', '--absolute-git-dir']).stdout.trim();
    if (!own || canonicalFilesystemPath(gitDir) !== canonicalFilesystemPath(own)) return dir;
  }
  return null;
}

/** The `git status` entries under the named paths that are directories, as path (a nested repository keeps its trailing /) to XY code. */
export function directoryStatus(root: string, rel: string[]): Map<string, string> {
  const dirs = rel.filter(path => { try { return lstatSync(join(root, path)).isDirectory(); } catch { return false; } });
  const status = dirs.length ? gitOk(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...literalPathspecs(dirs)], 'status') : '';
  return new Map(status.split('\0').filter(Boolean).map(entry => [entry.slice(3), entry.slice(0, 2)]));
}

/** The paths commit `sha` changed, each with its new mode (160000 for a gitlink, 000000 for a removal). */
export function committedModes(root: string, sha: string): Map<string, string> {
  const fields = gitOk(root, ['diff-tree', '--root', '-r', '--no-renames', '--no-commit-id', '-z', sha], 'diff-tree').split('\0');
  const modes = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i]!.startsWith(':')) modes.set(fields[i + 1]!, fields[i]!.split(' ')[1]!);
  return modes;
}

/** Named paths that are files on disk yet absent from the index (`listed`: `ls-files -v` after `git add -A`), as a file inside a nested repository is. */
export function unindexedFiles(root: string, rel: string[], listed: string[]): string[] {
  const indexed = new Set(listed.map(line => line.slice(2)));
  return rel.filter(path => {
    if (indexed.has(path)) return false;
    try { return !lstatSync(join(root, path)).isDirectory(); } catch { return false; }
  });
}

/**
 * GST-2767: the checkout above `dir` when git refuses `dir` only because a `.git` file in it or above it points at no
 * repository (a leftover from a moved submodule or worktree), and that checkout already tracks files under `dir`; else
 * null. Git itself stages such a folder from the checkout above, so the folder is committed there instead of refused.
 */
export function checkoutBehindStrayGitfile(dir: string): string | null {
  for (let at = canonicalFilesystemPath(dir); dirname(at) !== at; at = dirname(at)) {
    try { if (!lstatSync(join(at, '.git')).isFile()) continue; } catch { continue; }
    const top = git(dirname(at), ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) continue;
    const root = top.stdout.trim();
    const rel = relative(canonicalFilesystemPath(root), canonicalFilesystemPath(dir));
    return git(root, ['ls-files', '--', ...literalPathspecs([rel])]).stdout.trim() ? root : null;
  }
  return null;
}

/**
 * GST-2767: the folder whose own `.git` is the repository `top` reached through a linked `.git` (repo-a/brain/.git ->
 * ../.git). Git then reports the linked folder as the top level and would commit its files at the wrong place in the
 * tree, so the real work tree is the folder that holds that git directory; any other `top` is returned unchanged.
 */
export function worktreeOfGitdir(top: string): string {
  const gitDir = git(top, ['rev-parse', '--absolute-git-dir']);
  if (gitDir.code !== 0) return top;
  const real = canonicalFilesystemPath(gitDir.stdout.trim());
  for (let at = dirname(canonicalFilesystemPath(top)); dirname(at) !== at; at = dirname(at)) {
    if (existsSync(join(at, '.git')) && canonicalFilesystemPath(join(at, '.git')) === real) return at;
  }
  return top;
}

