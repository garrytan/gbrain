/**
 * Shared symlink-safe path-confinement + dotfile-trust helpers.
 *
 * Consolidates the realpath-containment idiom that previously lived only in
 * `sources-ops.ts` (`isPathContained`) and `validateUploadPath`
 * (`operations.ts`), and adds `isTrustedDotfile` — the multi-user-host trust
 * gate for walk-up routing dotfiles (`.gbrain-source` / `.gbrain-mount`).
 *
 * Threat model (POSIX multi-user host): an attacker who can write into a
 * shared ancestor directory of the victim's CWD (`/tmp`, `/var/tmp`,
 * `/dev/shm`, shared NFS/SMB, CI runner volumes, container bind-mounts) can
 * plant a routing dotfile that silently retargets the victim's reads/writes
 * to the attacker's source/brain. The walk-up resolvers must therefore refuse
 * a dotfile they can't prove the victim (or root) owns. (#418/#419)
 *
 * Fail-closed: any stat/realpath error → not trusted / not contained. The one
 * documented exception is platforms without numeric uid (Windows), where the
 * multi-user-POSIX threat model does not apply and `isTrustedDotfile` trusts
 * by default so existing single-user setups keep working.
 */

import { realpathSync, existsSync, type Stats } from 'fs';
import { realpath as realpathAsync } from 'fs/promises';
import { resolve as resolvePath, relative, isAbsolute, dirname, basename, join, sep } from 'path';

/**
 * Symlink-safe path confinement: realpath BOTH sides, then a separator-aware
 * prefix check. A plain `startsWith()` on un-resolved paths would let a
 * `parent/skills` symlink → `/etc` (or `$GBRAIN_HOME/clones/<id>` → `/etc`)
 * bypass the boundary; resolving first defeats that.
 *
 * Returns true iff `child` exists AND its realpath is `parent`'s realpath or a
 * real subtree of it. Returns false if either path is unresolvable (missing /
 * permission) or the resolved child escapes — fail-closed.
 */
export function isPathContained(child: string, parent: string): boolean {
  let resolvedChild: string;
  let resolvedParent: string;
  try {
    resolvedChild = realpathSync(child);
    resolvedParent = realpathSync(parent);
  } catch {
    return false; // missing / unresolvable path → not contained
  }
  return resolvedPrefixContained(resolvedChild, resolvedParent, sep);
}

/**
 * Pure separator-aware prefix check over ALREADY-RESOLVED paths — the exact
 * logic that regressed on Windows (#3643/#4103: a hardcoded '/' suffix made
 * every real backslash subdirectory fail the prefix test). Exported so the
 * win32 shapes (drive-letter roots, backslash subtrees, UNC shares) are
 * testable on POSIX CI, where realpathSync can never produce them
 * (gbrain#4103 review requirement — no Windows runner exists).
 */
export function resolvedPrefixContained(
  resolvedChild: string,
  resolvedParent: string,
  sepChar: string,
): boolean {
  // Append the OS separator so /foo doesn't match /foobar. `sep`, not a
  // hardcoded '/': realpathSync returns backslash paths on Windows, so a '/'
  // suffix would make the prefix test fail for every real subdirectory.
  const parentWithSep = resolvedParent.endsWith(sepChar) ? resolvedParent : resolvedParent + sepChar;
  return resolvedChild === resolvedParent || resolvedChild.startsWith(parentWithSep);
}

/**
 * Trust gate for a walk-up routing dotfile, given its `lstatSync` Stats.
 *
 * The caller MUST pass an `lstatSync` result, never `statSync` — `lstat` does
 * not follow symlinks, so a planted symlink redirect is visible here as
 * `isSymbolicLink()` instead of being followed-then-trusted.
 *
 * Rejects three classes of untrusted file:
 *   1. symlinks — an attacker-planted redirect to a file they control;
 *   2. foreign-owned — `uid` is neither the caller's nor root's (an attacker
 *      can't `chown` a file to the victim, so foreign ownership means planted;
 *      root-owned is trusted — root is the system admin and can write anywhere
 *      regardless);
 *   3. world-writable (`mode & 0o002`) — anyone can clobber it later, even when
 *      ownership is currently legitimate.
 *
 * On platforms without `process.getuid` (Windows) returns true: the
 * multi-user-POSIX threat model does not apply and ownership is unknowable.
 */
export function isTrustedDotfile(stats: Stats): boolean {
  // No numeric uid (Windows) → can't verify ownership; threat model N/A.
  if (typeof process.getuid !== 'function') return true;
  // A symlink is an attacker redirect — never trust. (Requires an lstat Stats.)
  if (stats.isSymbolicLink()) return false;
  const myUid = process.getuid();
  // Foreign-owned (not me, not root) → planted. Root-owned is trusted.
  if (stats.uid !== myUid && stats.uid !== 0) return false;
  // World-writable → anyone can clobber it later, even when ownership is legit.
  if ((stats.mode & 0o002) !== 0) return false;
  return true;
}

/**
 * Resolve a path through symlinks, falling back to lexical `resolve()` when the
 * path doesn't exist (stale registration). Used by the registered-path prefix
 * matchers so a symlinked CWD can't create a false prefix match against a
 * registered `local_path` / mount path while still tolerating a registered path
 * that no longer exists on disk.
 */
export function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/**
 * Convert a Git Bash / MSYS / Cygwin drive path to native Windows form
 * (gbrain#2955): `/c/Users/x` and `/cygdrive/c/Users/x` → `C:\Users\x`.
 *
 * On Windows, a `sources add --path` run from Git Bash records an msys-style
 * `local_path`. Every later `path.win32.resolve(cwd, '/c/Users/x')` joins it
 * as `<cwd-drive>:\c\Users\x` — a phantom path that never exists — so
 * write-through / sync silently target a directory nothing ever created.
 *
 * Pure and platform-parameterized (defaults to `process.platform`) so the
 * win32 branch is unit-testable on POSIX CI, mirroring
 * `resolvedPrefixContained` above. On non-win32 platforms it is identity —
 * `/c/…` is a legitimate directory name there. Anything that doesn't match
 * the drive shape (native paths, UNC shares, relative paths, non-drive
 * absolutes) passes through unchanged.
 */
export function msysToNativePath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !p) return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(p);
  if (!m) return p;
  const drive = m[1]!.toUpperCase();
  const rest = (m[2] ?? '').replace(/\//g, '\\');
  return `${drive}:${rest || '\\'}`;
}

/**
 * Async twin of `realpathOrResolve` — same fallback contract, but backed by
 * `fs.promises.realpath` instead of `realpathSync`. Exists so a caller
 * resolving N independent paths (e.g. every registered source's local_path)
 * can `Promise.all` them and let a slow/interrupted filesystem stall on ONE
 * path without serializing behind the others: `realpathSync` blocks the
 * event loop for its full duration no matter how many `Promise.all`-wrapped
 * calls surround it (#4091-class root-cause), so parallelizing the SYNC
 * function would still take sum-of-durations, not max-of-durations. Use this
 * version whenever more than one path is being resolved together.
 *
 * The lexical fallback below is the same shape as the sync version above
 * (unflagged there only because semgrep's diff-scoped CI scan doesn't
 * re-flag pre-existing lines): `p` is never raw untrusted input at this
 * call site — a registered source's local_path or the CLI's own cwd — and
 * this is the fallback for a path that already failed to realpath
 * (ENOENT/stale registration). The security boundary is the caller's
 * realpath-both-sides prefix/containment check afterward, not this
 * resolve() call.
 */
export async function realpathOrResolveAsync(p: string): Promise<string> {
  try {
    return await realpathAsync(p);
  } catch {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return resolvePath(p);
  }
}

/**
 * Containment check for a write TARGET that may not exist yet (a new page file).
 * `isPathContained` requires the child to already exist; this instead realpaths
 * the deepest EXISTING ancestor of `target` (catching a symlinked intermediate
 * directory that escapes the tree) and re-attaches the not-yet-created tail
 * lexically, then confirms the result stays within `root`.
 *
 * Defense-in-depth for the write-through FS sink (#1647-slug / codex #6):
 * `validateSlug` already rejects `..`/backslash/control/%2e in the slug, so this
 * guards a pre-existing hostile row or a symlinked source-tree subdirectory.
 */
export function isWriteTargetContained(target: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root);
  let existing = resolvePath(target);
  const tail: string[] = [];
  for (let i = 0; i < 4096 && !existsSync(existing); i++) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    existing = parent;
  }
  const base = realpathOrResolve(existing);
  const finalPath = tail.length ? join(base, ...tail) : base;
  const rel = relative(resolvedRoot, finalPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
