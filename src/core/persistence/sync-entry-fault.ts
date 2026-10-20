/**
 * GBRA-133 (#6712 PR 4b): the per-entry faults of a managed sync freeze. One odd file never stops its source: a fault
 * that belongs to the entry is held on that file alone, and only run-scoped failures (the binding, the writer, the
 * schema, recovery, a lost connection, an abort) stop the run.
 *
 * - `nullBytesRefusal` (S-39/S-44/S-53): a Markdown file whose text holds U+0000 (a binary file named `.md`, a
 *   crash-padded file, a UTF-16 save) cannot be stored as text or carried in a write intent, so it is held
 *   `content_null_bytes` with the first NUL's line instead of failing the admission with 22P05 forever.
 * - `committedContentOrMissing` (S-33): a committed file whose Git blob is gone (an interrupted gc, a partial clone
 *   without its promisor, disk corruption) imports from the working tree when those bytes hash to the committed blob
 *   id; otherwise it is refused `git_object_missing`, which the freeze holds, naming `git fsck` / `git fetch`.
 * - `committedContentOrMissing` (S-7): a committed name that is not valid UTF-8 (Latin-1 bytes from an old system or a zip)
 *   reads back from Git with U+FFFD for its undecodable bytes, a name no Git read or file finds; it is refused
 *   `path_not_utf8`, which the freeze holds, naming the rename that fixes it.
 * - `freezeFaultHold` (S-63/S-64): any other unexpected throw while freezing one entry (a Git read, the in-process
 *   screen, a TypeError) is held `page_write_failed` (origin `freeze`) with the error class and message, re-screened
 *   by the next syncs until it has been held `HOLD_ATTEMPTS_NEEDS_HUMAN` times, so a transient fault clears on its own.
 *   Deliberate refusals (an `OperationError`) keep their own route; a run where most freezes fault is systemic and
 *   stops instead of holding every file.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError, opError } from '../ops/contract.ts';
import { classifyItemFailure, ITEM_BREAKER_MIN_ITEMS } from '../item-failure.ts';
import { isRetryableConnError, isStatementTimeoutError } from '../retry-matcher.ts';
import { LockStolenError } from '../db-lock.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { VERSION } from '../../version.ts';
import { isWriteCapacityWait } from './admission-retry.ts';
import { gitBlobOid } from './digest.ts';
import { readBlobBytes, type TreeBlob } from './sync-blobs.ts';
import { readSyncFile, type SyncEntry } from './sync-discovery.ts';
import type { GitHoldRecord } from './sync-holds.ts';

type HoldEntry = Pick<SyncEntry, 'path' | 'sourcePath' | 'working' | 'renameFrom' | 'renameHeld' | 'action'>;
type HeldFault = Pick<GitHoldRecord, 'path' | 'source_path' | 'slug' | 'page_id' | 'code' | 'message' | 'upstream_version' | 'meta'>;

/** S-39: the `content_null_bytes` refusal of a Markdown text holding U+0000 (the first one's 1-based line), or null. */
export function nullBytesRefusal(path: string, content: string): { code: 'content_null_bytes'; line: number; message: string } | null {
  const at = content.indexOf('\u0000');
  if (at < 0) return null;
  const line = content.slice(0, at).split('\n').length;
  // A UTF-16 byte order mark (FF FE or FE FF) reads as two replacement characters in UTF-8.
  const utf16 = content.startsWith('\uFFFD\uFFFD');
  return { code: 'content_null_bytes', line, message: `${path} holds a NUL byte (U+0000) on line ${line}${utf16 ? ' and starts with a UTF-16 byte order mark, so it is UTF-16 text, not UTF-8' : ''}; `
    + 'gbrain stores page text as UTF-8 without NUL bytes, so sync held this file and the rest of the source synced. '
    + `${utf16 ? 'Save it as UTF-8' : 'Remove the NUL bytes (or, for a binary file, remove it or exclude it with sync.exclude)'}, then commit and sync again.` };
}

/**
 * S-33: the content of a committed entry whose pinned read failed with `error`. When the commit names a blob for the path
 * that the repository no longer has, the working-tree bytes are used if they hash to that blob id (the same bytes);
 * otherwise `git_object_missing` is thrown. Any other failure (no blob at the path, the object present) is rethrown.
 */
export function committedContentOrMissing(cursor: { root: string; gitRoot: string; sourceId: string }, entry: Pick<SyncEntry, 'path'>, blob: TreeBlob | null, error: unknown): string {
  if (entry.path.includes('\uFFFD') && !existsAt(cursor.root, entry.path)) {
    throw opError('path_not_utf8', `The committed name of ${entry.path} is not valid UTF-8.`,
      `${entry.path} is shown with U+FFFD where its name has bytes that are not UTF-8 (a Latin-1 name from an older system, an archive or a network share), so sync cannot read it by name and imported nothing from it. `
        + `Rename it to a UTF-8 name (for example git mv with the name as git ls-files shows it, or convmv -f latin1 -t utf8), commit, then run gbrain sync --source ${cursor.sourceId} --no-pull.`,
      { fix: { argv: ['git', '-C', cursor.gitRoot, '-c', 'core.quotePath=true', 'ls-files', '--', entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/') + 1)) || '.'], consent: [], actor: 'user', requires_exclusive: false,
        why: 'Lists the names in that folder with their bytes escaped (read-only), so the one to rename can be typed exactly.', verify: { argv: ['gbrain', 'sources', 'status', cursor.sourceId, '--json'] } } });
  }
  if (!blob || readBlobBytes(cursor.gitRoot, [blob]).has(blob.oid)) throw error;
  let bytes: Buffer | null = null;
  try { bytes = readSyncFile(cursor.root, entry.path); } catch { bytes = null; }
  if (bytes && gitBlobOid(bytes, blob.oid.length === 64 ? 'sha256' : 'sha1') === blob.oid) return bytes.toString('utf8');
  throw opError('git_object_missing', `The Git object of ${entry.path} at the synced commit is missing from the repository.`,
    `${entry.path} is committed as blob ${blob.oid}, but the repository of source ${cursor.sourceId} no longer has that object${bytes ? ' and the working-tree file differs from it' : ' and the working tree has no copy of it'}, so nothing was imported from it. `
      + `Run git fsck in the checkout to see what is missing, restore it with git fetch (a partial or shallow clone) or from a backup, then run gbrain sync --source ${cursor.sourceId} --no-pull.`,
    { detail: blob.oid, fix: { argv: ['git', '-C', cursor.gitRoot, 'fsck', '--connectivity-only'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Lists the missing objects (read-only); git fetch, or a restore from a backup, brings them back.', verify: { argv: ['gbrain', 'sources', 'status', cursor.sourceId, '--json'] } } });
}

/** S-7: whether anything stands at `path` (a file, a folder, a link); nothing is read. */
function existsAt(root: string, path: string): boolean {
  try { lstatSync(join(root, path)); return true; } catch { return false; }
}

/** S-22: whether a directory stands where an entry's file was (a deleted file whose name became a folder); nothing is read from it. */
export function directoryAt(root: string, path: string): boolean {
  try { return lstatSync(join(root, path)).isDirectory(); } catch { return false; }
}

/** Freeze faults and successes of one run (keyed by its screen run), for the systemic breaker. */
const tallies = new WeakMap<object, { faults: number; frozen: number }>();
/** S-63: counts one entry frozen without a fault in `run`. */
export function noteFrozen(run: object | null | undefined): void {
  if (!run) return;
  const tally = tallies.get(run) ?? { faults: 0, frozen: 0 };
  tally.frozen++; tallies.set(run, tally);
}

/** Errors that are never one entry's: an abort, a lost connection or lock, back-pressure, or anything the item classifier scopes to the run. */
function runScoped(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError' || error instanceof LockStolenError || isWriteCapacityWait(error)
    || isRetryableConnError(error) || isStatementTimeoutError(error) || classifyItemFailure(error).scope !== 'item';
}

/**
 * S-63/S-64/S-33/S-7: the hold a throw while freezing one entry earns when holds are on, or null to rethrow it. A
 * `git_object_missing` or `path_not_utf8` refusal is held under its code; any other `OperationError` is a deliberate refusal and keeps
 * its route. An unexpected throw is held `page_write_failed` (origin `freeze`) unless it is run-scoped or the run
 * looks systemic (`ITEM_BREAKER_MIN_ITEMS` faults and at least as many faults as clean freezes).
 */
export function freezeFaultHold(run: object, entry: HoldEntry, slug: string, pageId: number | null, error: unknown, blob: () => TreeBlob | null): HeldFault | null {
  const missing = error instanceof OperationError && (error.code === 'git_object_missing' || error.code === 'path_not_utf8');
  if (!missing && (error instanceof OperationError || runScoped(error))) return null;
  if (!missing) {
    const tally = tallies.get(run) ?? { faults: 0, frozen: 0 };
    tally.faults++; tallies.set(run, tally);
    if (tally.faults >= ITEM_BREAKER_MIN_ITEMS && tally.faults >= tally.frozen) return null;
  }
  let pinned: TreeBlob | null = null;
  try { pinned = entry.working ? null : blob(); } catch { pinned = null; }
  const rename = entry.renameFrom ?? entry.renameHeld;
  const meta = { recovery_version: RECOVERY_VERSION, ...(pinned ? { blob_oid: pinned.oid } : {}), ...(entry.working ? { working: true as const } : {}),
    ...(rename ? { rename_from: rename } : {}), ...(entry.action === 'delete' ? { deleted: true as const } : {}) };
  if (missing) return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code: (error as OperationError).code as 'git_object_missing' | 'path_not_utf8',
    message: `${(error as OperationError).message} ${(error as OperationError).suggestion ?? ''}`.trim(), upstream_version: null, meta };
  const name = error instanceof Error ? error.name : typeof error;
  const errno = (error as { code?: unknown } | null)?.code;
  const text = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);
  return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code: 'page_write_failed',
    message: `${entry.path}: sync could not prepare its ${entry.action === 'delete' ? 'deletion' : 'import'} (${name}: ${text}), so it is held and the rest of the source synced. `
      + 'The next syncs re-test it; if it stays held, report it with the gbrain version or fix the file when the error names it, then gbrain sources retry-held.',
    upstream_version: null,
    meta: { ...meta, write_failure: { code: 'storage_error', origin: 'freeze', error_class: name, errno: typeof errno === 'string' ? errno.slice(0, 32) : null, request_id: null, attempts: 1, gbrain_version: VERSION } } };
}
