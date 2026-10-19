/**
 * GBRA-133 PR 1: classic (unmanaged) sync's deterministic per-file refusals.
 * A path the commit names that is not a readable regular file inside the repo
 * (a symlink, a non-regular file, a permission error) or that is committed but
 * missing from the working tree (a sparse checkout, a local deletion) is held
 * in the classic hold store instead of failing the run: it never gates the
 * bookmark and is re-screened every run, so an out-of-band fix (the symlink
 * replaced by a file, chmod, git restore) imports it with no new commit.
 *
 * `classifyClassicFile` reads only metadata (lstat, realpath of the target,
 * an open of a regular file, and for a missing path two read-only Git
 * plumbing calls with optional locks off); it never reads or follows content.
 * Any other error returns null and keeps today's failure path.
 * `classicFileHoldFix` is the fix every hold surface renders for these codes.
 */
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from './spawn.ts';
import type { Action } from './agent-output.ts';
import { gitChildEnv } from './git-env.ts';
import { buildGitInvocation, isWithinRoot } from './sync-git.ts';
import type { GitHoldRecord } from './persistence/sync-holds.ts';

export type ClassicFileHoldCode = 'file_unreadable' | 'absent_from_worktree';
export type ClassicFileHoldReason = 'symlink_in_repo' | 'symlink_outside_root' | 'symlink_dangling' | 'symlink_loop' | 'permission_denied' | 'not_regular_file'
  | 'skip_worktree' | 'deleted_locally';
export interface ClassicFileHold { code: ClassicFileHoldCode; reason: ClassicFileHoldReason; message: string }

export const CLASSIC_FILE_HOLD_CODES: ReadonlySet<string> = new Set<ClassicFileHoldCode>(['file_unreadable', 'absent_from_worktree']);

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;
const DENIED = new Set(['EACCES', 'EPERM']);
const SYMLINK_WHAT: Record<string, string> = {
  symlink_in_repo: 'a symlink to another file in the repository',
  symlink_outside_root: 'a symlink to a path outside the repository',
  symlink_dangling: 'a symlink whose target does not exist',
  symlink_loop: 'a symlink that loops back on itself',
  not_regular_file: 'not a regular file (a FIFO, socket or device)',
};

function hold(code: ClassicFileHoldCode, reason: ClassicFileHoldReason, relPath: string): ClassicFileHold {
  const message = code === 'absent_from_worktree'
    ? `${relPath} is committed at HEAD but missing from the working tree (${reason === 'skip_worktree' ? 'the sparse checkout or a skip-worktree bit leaves it off disk' : 'it was deleted locally and the deletion is not committed'}), so sync did not import it.`
    : reason === 'permission_denied' ? `${relPath} cannot be read (permission denied), so sync did not import it.`
    : `${relPath} is ${SYMLINK_WHAT[reason]}; sync reads only regular files inside the repository and never follows a symlink.`;
  return { code, reason, message };
}

/** Read-only Git plumbing in the source root: optional locks off, literal pathspecs, null on any failure. */
function gitRead(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', buildGitInvocation(root, args), { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }),
      encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

/** A committed file missing on disk: skip_worktree when the index marks it so, deleted_locally otherwise; null when HEAD has no blob there. */
function absentFromWorktree(root: string, relPath: string): ClassicFileHold | null {
  const tree = gitRead(root, ['ls-tree', '-z', 'HEAD', '--', relPath]);
  if (!tree || !/^(100644|100755|120000) blob /.test(tree)) return null;
  const flag = gitRead(root, ['ls-files', '-z', '-v', '--', relPath])?.charAt(0);
  return hold('absent_from_worktree', flag === 'S' ? 'skip_worktree' : 'deleted_locally', relPath);
}

/**
 * The hold for `relPath` under `root` (the source root sync joins paths to), or null when it is a readable regular file or
 * fails some other way. `gitRoot` bounds a symlink target as in or out of the repository.
 */
export function classifyClassicFile(root: string, relPath: string, gitRoot: string = root): ClassicFileHold | null {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- relPath is a git path of the synced repo; only metadata is read (lstat, realpath, open+close) and a symlink is never followed for content
  const full = join(root, relPath);
  let stat;
  try { stat = lstatSync(full); } catch (e) {
    if (DENIED.has(errno(e) ?? '')) return hold('file_unreadable', 'permission_denied', relPath);
    return errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR' ? absentFromWorktree(root, relPath) : null;
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try { target = realpathSync(full); } catch (e) {
      if (errno(e) === 'ELOOP') return hold('file_unreadable', 'symlink_loop', relPath);
      if (errno(e) === 'ENOENT') return hold('file_unreadable', 'symlink_dangling', relPath);
      return DENIED.has(errno(e) ?? '') ? hold('file_unreadable', 'permission_denied', relPath) : null;
    }
    let rootReal: string;
    try { rootReal = realpathSync(gitRoot); } catch { return null; }
    return hold('file_unreadable', isWithinRoot(target, rootReal) ? 'symlink_in_repo' : 'symlink_outside_root', relPath);
  }
  if (stat.isDirectory()) return null;
  if (!stat.isFile()) return hold('file_unreadable', 'not_regular_file', relPath);
  try { closeSync(openSync(full, 'r')); } catch (e) {
    return DENIED.has(errno(e) ?? '') ? hold('file_unreadable', 'permission_denied', relPath) : null;
  }
  return null;
}

/** The fix for a classic file hold: the user's choice for a symlink or a permission, ask_user between restoring and deleting for an absent file. */
export function classicFileHoldFix(record: Pick<GitHoldRecord, 'source_id' | 'path' | 'code' | 'meta'>): Action {
  const source = record.source_id;
  const path = record.path;
  const reason = record.meta.reason as ClassicFileHoldReason | undefined;
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  const docs = `docs/guides/write-refusals.md#${record.code}${reason ? `-${reason}` : ''}`;
  const checkout = [{ name: 'checkout', how: `the source's checkout: local_path of ${source} in gbrain sources list --json` }];
  const sync: Action = { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `Re-screens ${path} (every sync re-screens it, no commit needed): a readable regular file imports and the hold clears.` };
  const rest = `the rest of source ${source} keeps syncing`;
  if (record.code === 'absent_from_worktree' && reason === 'skip_worktree') {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
    return { ask_user: true, argv: ['git', '-C', '<checkout>', 'sparse-checkout', 'add', dir], inputs: checkout, consent: [], actor: 'agent', requires_exclusive: false, docs,
      user_message: `${path} is committed but the sparse checkout (or a skip-worktree bit) keeps it off disk, so sync holds it and ${rest}. Choose: widen the sparse checkout to include it `
        + `(git -C <checkout> sparse-checkout add ${dir}; for a file whose skip-worktree bit was set by hand, clear the bit and restore the file as ${docs} shows), `
        + `and the next sync imports it; or leave it out of the brain with sync.exclude (gbrain config get sync.exclude, then gbrain config set sync.exclude '<current list>,${path}'). Keeping it held is also safe.`,
      why: 'Which files a sparse checkout leaves out is the user\'s choice; sync never imports a file it cannot read from the working tree.', then: sync, verify };
  }
  if (record.code === 'absent_from_worktree') {
    return { ask_user: true, argv: ['git', '-C', '<checkout>', 'restore', '--', path], inputs: checkout, consent: [], actor: 'agent', requires_exclusive: false, docs,
      user_message: `${path} is committed but was deleted from the checkout and the deletion is not committed, so sync holds it and ${rest}. Choose: restore it `
        + `(git -C <checkout> restore -- ${path}) and the next sync imports it; or commit the deletion (gbrain git commit-push --path <checkout> -m 'Delete ${path}' -- ${path}) and the next sync clears the hold.`,
      why: 'Whether the file was deleted on purpose is the user\'s call; restoring brings back the committed bytes, committing the deletion removes it from Git.', then: sync, verify };
  }
  if (reason === 'permission_denied') {
    return { argv: ['chmod', 'u+r', '--', `<checkout>/${path}`], inputs: checkout, consent: [], actor: 'user', requires_exclusive: false, docs,
      user_message: `gbrain cannot read ${path} (permission denied), so sync holds it and ${rest}. Make it readable to the account gbrain runs as (this chmod, or fix the file's owner or a parent directory's permissions); `
        + 'the next sync re-screens it and imports it with no commit needed.',
      why: 'File permissions on the host are the user\'s to change; sync never reads around them.', then: sync, verify };
  }
  const what = SYMLINK_WHAT[reason ?? ''] ?? 'not a readable regular file';
  return { argv: ['gbrain', 'config', 'get', 'sync.exclude'], consent: [], actor: 'user', requires_exclusive: false, docs,
    user_message: `${path} is ${what}, so sync holds it without following it and ${rest}. Replace it in the checkout with the regular file it stands for (or delete it), `
      + `or leave it out of the brain with sync.exclude: read the current list with this command, then gbrain config set sync.exclude '<current list>,${path}'. The next sync re-screens it with no commit needed.`,
    why: 'Sync reads only regular files inside the source root and never follows a symlink (a link can point anywhere on the host); which file belongs in the brain is the user\'s call.', then: sync, verify };
}
