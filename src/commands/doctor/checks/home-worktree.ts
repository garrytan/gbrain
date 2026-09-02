/**
 * home_dir_in_worktree check (v0.35.8.0) — peeled from src/commands/doctor.ts
 * (3e) so the walk is unit-testable against tmpdir trees.
 *
 * Walks up from the gbrain home looking for a `.git` directory OR file. If
 * found, warns: `~/.gbrain/` lives inside a git worktree, so an accidental
 * `git add` from the worktree root could stage the brain. Pairs with the
 * retroactive `~/.gbrain/.gitignore` (single-line `*`) laid down by
 * saveConfig + post-upgrade. Honest scope: the .gitignore covers casual
 * `git add` but NOT already-tracked files, screenshots, backups, or
 * `git add -f`.
 *
 * Walk termination: stops at $HOME (don't keep walking into / on a user who
 * set GBRAIN_HOME=/tmp/something). Handles `.git` as both a directory (main
 * repo) and a file (linked worktree pointing at parent's worktrees/).
 *
 * #4683: a candidate `.git` is VALIDATED before it is treated as an
 * enclosing worktree. Git itself rejects an empty `.git/` directory (no
 * HEAD) and a `.git` file that doesn't start with `gitdir:`, so doctor
 * accepting any stat-able `.git` produced a security-flavored false warning
 * naming a directory git doesn't consider a repository. Invalid candidates
 * continue the walk instead of breaking — a valid repo higher up still warns.
 */
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import type { Check } from '../../doctor.ts';

/**
 * Structural validation mirroring git's own repository discovery:
 * - a `.git` DIRECTORY must contain a HEAD file (git rejects an empty dir);
 * - a `.git` FILE must start with `gitdir:` (linked-worktree pointer).
 * Cheap (one stat + one exists/read), no subprocess — this runs on every
 * doctor invocation including --fast.
 */
export function isValidGitMarker(gitPath: string): boolean {
  try {
    const st = statSync(gitPath);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- gitPath is a `.git` marker under the operator's own $HOME walk; existence probe only
    if (st.isDirectory()) return existsSync(join(gitPath, 'HEAD'));
    if (st.isFile()) return readFileSync(gitPath, 'utf-8').trimStart().startsWith('gitdir:');
  } catch {
    // No .git at this level (or unreadable) — not a marker.
  }
  return false;
}

export function buildHomeDirInWorktreeCheck(
  rawGbrainHome: string,
  rawHome: string,
  gbrainHomeEnvSet: boolean,
): Check {
  // Normalize both anchors before comparing. `HOME=/home/user/` (trailing
  // slash — a common shell / launchd spelling) made the containment gate
  // compare against '/home/user//', which never matches, so a brain that WAS
  // inside a worktree silently graded ok. resolve() strips trailing
  // separators and collapses `.`/`..` without touching the filesystem.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- $GBRAIN_HOME from the operator's own environment; resolve() only normalizes the spelling for a containment comparison
  const gbrainHome = rawGbrainHome ? resolve(rawGbrainHome) : rawGbrainHome;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- $HOME from the operator's own environment; same normalization
  const home = rawHome ? resolve(rawHome) : rawHome;
  let worktreeRoot: string | null = null;
  if (gbrainHome && home && gbrainHome.startsWith(home + '/')) {
    // Walk up from gbrainHome's parent toward $HOME, stopping at $HOME.
    // We don't check gbrainHome itself: a `.git` directly inside ~/.gbrain
    // isn't a containing-worktree, it would be a brain repo cloned there.
    let cur = dirname(gbrainHome);
    while (cur && cur.length >= home.length) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- cur walks up from $GBRAIN_HOME and stops at $HOME (both operator env); read-only doctor probe
      if (isValidGitMarker(join(cur, '.git'))) {
        worktreeRoot = cur;
        break;
      }
      if (cur === home) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  if (worktreeRoot) {
    const homeEnvHint = gbrainHomeEnvSet
      ? `# Or move \`~/.gbrain\` outside the worktree by setting GBRAIN_HOME elsewhere.`
      : `# Fix: \`export GBRAIN_HOME=/some/path/outside/the/worktree\` (gbrain appends \`.gbrain\`).`;
    return {
      name: 'home_dir_in_worktree',
      status: 'warn',
      message:
        `~/.gbrain lives inside git worktree at ${worktreeRoot}. ` +
        `Config + brain DB could be committed by accident. ` +
        `A retroactive ~/.gbrain/.gitignore blocks casual \`git add\`, but does NOT cover ` +
        `already-tracked files, screenshots, backups, or \`git add -f\`. ${homeEnvHint}`,
    };
  }
  return {
    name: 'home_dir_in_worktree',
    status: 'ok',
    message: 'gbrain home is outside any enclosing git worktree.',
  };
}
