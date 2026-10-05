/**
 * #5988: batched Git reads for managed sync hold checks and dry runs: blob ids
 * and sizes through chunked `ls-tree`, contents through `cat-file --batch`,
 * never one process per file and never an unbounded full-tree read.
 */
import { execFileSync } from '../spawn.ts';

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
      const [oid, , size] = output.subarray(offset, newline).toString('utf8').split(' ');
      const start = newline + 1, end = start + Number(size);
      out.set(oid!, output.subarray(start, end).toString('utf8'));
      offset = end + 1;
    }
  }
  return out;
}

