/**
 * #5988: batched Git reads for managed sync hold checks and dry runs: blob ids
 * and sizes through chunked `ls-tree`, contents through `cat-file --batch`,
 * never one process per file and never an unbounded full-tree read.
 * Managed sync's freeze reads its pinned blobs through `readPinnedBlob` /
 * `readPinnedContent`: one `ls-tree` per window of upcoming entries and one
 * `cat-file --batch` per bounded slice of it, instead of an `ls-tree` and a
 * `git show` per entry.
 */
import { execFileSync } from 'node:child_process';

/** The sync read bound (`readSyncFile`): bigger files are held without being read. */
export const SYNC_READ_BOUND = 10 * 1024 ** 2;

export interface TreeBlob { oid: string; size: number }

function git(gitRoot: string, args: string[], input?: string, maxBuffer = 32 * 1024 ** 2): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', '-C', gitRoot, ...args],
    { timeout: 60_000, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });
}

/** Blob id and size of Git paths at a commit, in chunked `ls-tree` calls (never one process per file). */
export function readTreeBlobs(gitRoot: string, target: string, gitPaths: string[]): Map<string, TreeBlob> {
  const out = new Map<string, TreeBlob>();
  for (let i = 0; i < gitPaths.length; i += 500) {
    const rows = git(gitRoot, ['ls-tree', '-l', '-z', target, '--', ...gitPaths.slice(i, i + 500)]).toString('utf8').split('\0');
    for (const row of rows) {
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, kind, oid, size] = row.slice(0, tab).split(/\s+/);
      if (kind === 'blob') out.set(row.slice(tab + 1), { oid: oid!, size: Number(size) });
    }
  }
  return out;
}

/** Decoded blob contents by id, read through `git cat-file --batch` in bounded chunks. */
export function readBlobContents(gitRoot: string, blobs: TreeBlob[]): Map<string, string> {
  const out = new Map<string, string>();
  const pending = [...new Map(blobs.filter(blob => blob.size <= SYNC_READ_BOUND).map(blob => [blob.oid, blob])).values()];
  while (pending.length) {
    const chunk: TreeBlob[] = [];
    let bytes = 0;
    while (pending.length && (chunk.length === 0 || bytes + pending[0]!.size <= 24 * 1024 ** 2)) { bytes += pending[0]!.size; chunk.push(pending.shift()!); }
    const output = git(gitRoot, ['cat-file', '--batch'], chunk.map(blob => blob.oid).join('\n') + '\n', bytes + chunk.length * 128 + 1024);
    let offset = 0;
    for (const blob of chunk) {
      const newline = output.indexOf(10, offset);
      const [oid, kind, size] = output.subarray(offset, newline).toString('utf8').split(' ');
      if (kind === 'missing' || size === undefined) { offset = newline + 1; continue; }
      const start = newline + 1, end = start + Number(size);
      out.set(oid!, output.subarray(start, end).toString('utf8'));
      offset = end + 1;
    }
  }
  return out;
}

/** Entries one pinned `ls-tree` covers, and the bytes one window's `cat-file --batch` loads at most. */
export const PINNED_WINDOW = 256;
const PINNED_WINDOW_BYTES = 8 * 1024 ** 2;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The pinned tree window of the run reading now. A full commit id names
 * immutable trees and blobs, so an answer read for a later entry of the window
 * is the answer that entry's own read would give; a different root or target
 * replaces the window.
 */
let pinned: { gitRoot: string; target: string; paths: string[]; blobs: Map<string, TreeBlob | null>; contents: Map<string, string> } | null = null;
let pinnedWindowSize = PINNED_WINDOW;
/** Test seam: replace the pinned window size (0 reads every entry alone, as before windows; null restores it); returns the restore function. */
export function __setPinnedWindowForTests(size: number | null): () => void {
  const previous = pinnedWindowSize;
  pinnedWindowSize = size ?? PINNED_WINDOW;
  pinned = null;
  return () => { pinnedWindowSize = previous; pinned = null; };
}

function pinnedWindow(gitRoot: string, target: string, gitPath: string, upcoming: () => string[]) {
  if (pinned?.gitRoot === gitRoot && pinned.target === target && pinned.blobs.has(gitPath)) return pinned;
  const paths = [gitPath, ...new Set(upcoming().filter(path => path !== gitPath))].slice(0, pinnedWindowSize);
  let found: Map<string, TreeBlob>;
  // A window that cannot be listed (one path git rejects) falls back to this entry alone, which reports its own error.
  try { found = readTreeBlobs(gitRoot, target, paths); } catch { return null; }
  pinned = { gitRoot, target, paths, blobs: new Map(paths.map(path => [path, found.get(path) ?? null])), contents: new Map() };
  return pinned;
}

/**
 * The blob of `gitPath` at the pinned `target`, or null when the commit has no
 * blob there: the answer of `readTreeBlobs` for that one path. `upcoming` lists
 * the Git paths the run reads next; a path outside the current window lists
 * itself and up to `PINNED_WINDOW` of them in one `ls-tree`.
 */
export function readPinnedBlob(gitRoot: string, target: string, gitPath: string, upcoming: () => string[]): TreeBlob | null {
  const window = pinnedWindowSize && COMMIT_ID.test(target) ? pinnedWindow(gitRoot, target, gitPath, upcoming) : null;
  return window ? window.blobs.get(gitPath)! : readTreeBlobs(gitRoot, target, [gitPath]).get(gitPath) ?? null;
}

/**
 * The decoded content of the blob at `gitPath` in the pinned `target`, or null
 * when the window cannot answer it (no blob there, over the sync read bound, or
 * unreadable); the caller then reads it as before. A miss loads this blob and
 * the window's later ones, up to `PINNED_WINDOW_BYTES`, in one `cat-file --batch`.
 */
export function readPinnedContent(gitRoot: string, target: string, gitPath: string, upcoming: () => string[]): string | null {
  if (!pinnedWindowSize || !COMMIT_ID.test(target)) return null;
  const window = pinnedWindow(gitRoot, target, gitPath, upcoming);
  const blob = window?.blobs.get(gitPath);
  if (!window || !blob || blob.size > SYNC_READ_BOUND) return null;
  if (!window.contents.has(blob.oid)) {
    const slice: TreeBlob[] = [];
    let bytes = 0;
    for (const path of window.paths.slice(window.paths.indexOf(gitPath))) {
      const next = window.blobs.get(path);
      if (!next || next.size > SYNC_READ_BOUND) continue;
      if (slice.length && bytes + next.size > PINNED_WINDOW_BYTES) break;
      bytes += next.size; slice.push(next);
    }
    try { window.contents = readBlobContents(gitRoot, slice); } catch { return null; }
  }
  return window.contents.get(blob.oid) ?? null;
}
