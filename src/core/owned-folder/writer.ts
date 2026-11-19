/**
 * One run, one commit (GST-3022): the owned-folder writer. Under one hold of the checkout's commit lock it proves the
 * folder is this source's (OWNER.json names its id and incarnation) and that each file it is about to rewrite or
 * remove still holds the blob it last wrote, in the worktree and the index, through no symlink; it then writes the
 * changed days, removes the emptied ones and commits them in one commit. A file it did not write, or one edited by
 * hand, is never overwritten, adopted or deleted: that day is held as owned_folder_conflict. Under
 * `secrets.on_push refuse` a day whose bytes the push scan names stays out of Git (held as owned_day_secret_held) and
 * its committed file, which passed the scan, is kept; with the default (redact) the publish redacts it (#9671).
 * Nothing is noted in the pending write-through ledger, so no other writer can commit part of a batch, and a commit
 * that fails restores every file it touched.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { acquireCommitLock, assertNoOperationInProgress, commitPaths } from '../git/commit-push.ts';
import { git } from '../git/git-run.ts';
import { onPushMode } from '../git/redact-unpushed.ts';
import { OperationError } from '../ops/contract.ts';
import { scanText } from '../secret-scan.ts';
import { OWNED_FOLDER_ROOT } from './paths.ts';

export const OWNER_FILE = 'OWNER.json';
export const README_FILE = 'README.md';

/** What the writer remembers between runs, kept in the source's connector state (the database). */
export interface OwnedFolderState {
  incarnation: string;
  /** The normalized push URLs recorded at the first write ([] for a checkout with no remote). */
  push_urls: string[];
  /** Folder-relative path -> the blob this writer last committed there. */
  files: Record<string, string>;
  last_batch?: string | null;
  last_batch_at?: string | null;
}

export interface OwnedHold { code: 'owned_folder_conflict' | 'owned_day_secret_held'; detail: string }

export interface OwnedBatchInput {
  root: string;
  /** Checkout-relative folder, `.gbrain-owned/<id>`. */
  rel: string;
  sourceId: string;
  kind: string;
  incarnation: string;
  pushUrls: string[];
  /** Folder-relative path -> content. */
  writes: Map<string, string>;
  removes: string[];
  message: string;
  lockWaitMs?: number;
}

export interface OwnedBatchResult {
  sha: string | null;
  /** Folder-relative paths now holding the blob given, and the ones removed. */
  written: Record<string, string>;
  removed: string[];
  held: Record<string, OwnedHold>;
  firstWrite: boolean;
}

const blobOf = (root: string, path: string): string | null => {
  const out = git(root, ['hash-object', '--', path]);
  return out.code === 0 ? out.stdout.trim() : null;
};
const indexBlob = (root: string, path: string): string | null => {
  const line = git(root, ['ls-files', '-s', '--', path]).stdout.trim();
  return line ? line.split(/\s+/)[1] ?? null : null;
};
const headBlob = (root: string, path: string): string | null => git(root, ['rev-parse', '--verify', '-q', `HEAD:${path}`]).stdout.trim() || null;

/** A symlink at the path or any directory between the checkout root and it. */
function symlinkOnPath(root: string, checkoutRel: string): boolean {
  let at = root;
  for (const seg of checkoutRel.split('/')) {
    at = join(at, seg);
    try { if (lstatSync(at).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

export function ownedConflict(path: string, why: string, sourceId: string): OperationError {
  return new OperationError('owned_folder_conflict', `${path} ${why}, so gbrain left it as it is and kept those pages in the database only.`,
    `Move the file out of ${OWNED_FOLDER_ROOT}/ (or restore what gbrain wrote: git checkout -- ${path}), then run gbrain sync --source ${sourceId}.`,
    'docs/guides/apple-setup.md#owned_folder_conflict');
}

function readme(input: OwnedBatchInput): string {
  const where = input.pushUrls.length ? `pushed with the rest of this repository to ${input.pushUrls.join(', ')}` : 'kept in this checkout only (the repository has no push remote)';
  return [
    `# ${input.rel}`,
    '',
    `gbrain keeps the pages of its \`${input.kind}\` source \`${input.sourceId}\` here, one file per chat per day. They are private: only the brain's owner reads them through gbrain, and they are ${where}.`,
    '',
    'gbrain writes this folder and nothing else should: a file edited or added by hand is left alone and its day stays in the database only.',
    `To stop it, run \`gbrain sources remove ${input.sourceId}\`, which removes the folder in one commit. The repository's history still holds what was pushed.`,
    '',
  ].join('\n');
}

/** Restores each touched path to HEAD (or removes it when HEAD has none) after a failed or partial commit. */
function restore(root: string, paths: string[]): void {
  for (const p of paths) {
    if (headBlob(root, p)) git(root, ['checkout', 'HEAD', '--', p]);
    else { git(root, ['rm', '-q', '--cached', '--ignore-unmatch', '--', p]); rmSync(join(root, p), { force: true }); }
  }
}

export function commitOwnedBatch(input: OwnedBatchInput, state: OwnedFolderState | null): OwnedBatchResult {
  const { root, rel, sourceId } = input;
  const folder = join(root, rel);
  const result: OwnedBatchResult = { sha: null, written: {}, removed: [], held: {}, firstWrite: false };
  if (!input.writes.size && !input.removes.length) return result;
  assertNoOperationInProgress(root);
  const lock = acquireCommitLock(root, input.lockWaitMs ?? 30_000);
  const touched: string[] = [];
  try {
    if (symlinkOnPath(root, rel)) throw ownedConflict(`${rel}/`, 'is reached through a symlink', sourceId);
    const ownerPath = join(folder, OWNER_FILE);
    const owner = { source_id: sourceId, kind: input.kind, incarnation: input.incarnation };
    if (existsSync(ownerPath)) {
      let found: Record<string, unknown> | null = null;
      try { found = JSON.parse(readFileSync(ownerPath, 'utf8')); } catch { /* unreadable reads as not ours */ }
      if (found?.source_id !== sourceId || found?.incarnation !== input.incarnation) throw ownedConflict(`${rel}/${OWNER_FILE}`, 'names another source or an earlier one with this id', sourceId);
    } else {
      if (existsSync(folder) && readdirSync(folder).length) throw ownedConflict(`${rel}/`, 'holds files and no OWNER.json', sourceId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      atomicWriteFileSync(join(folder, README_FILE), readme(input), { mode: 0o600 });
      touched.push(`${rel}/${OWNER_FILE}`, `${rel}/${README_FILE}`);
      result.firstWrite = true;
    }
    const recorded = state?.files ?? {};
    const refuse = onPushMode() === 'refuse';
    /** The file at `p` is the one this writer last committed (or absent and never written). */
    const ours = (p: string): string | null => {
      const path = `${rel}/${p}`;
      if (symlinkOnPath(root, path)) return 'is reached through a symlink';
      const exists = existsSync(join(root, path));
      const want = recorded[p];
      if (!want) return exists || indexBlob(root, path) ? 'is a file gbrain did not write' : null;
      if (!exists) return 'was removed by hand';
      if (!lstatSync(join(root, path)).isFile()) return 'is not a regular file';
      if (blobOf(root, path) !== want || indexBlob(root, path) !== want) return 'was changed by hand';
      return null;
    };
    for (const [p, content] of input.writes) {
      const why = ours(p);
      if (why) { result.held[p] = { code: 'owned_folder_conflict', detail: `${rel}/${p} ${why}` }; continue; }
      const findings = refuse ? scanText(content) : [];
      if (findings.length) {
        result.held[p] = { code: 'owned_day_secret_held', detail: `${rel}/${p} looks like it holds a secret (${[...new Set(findings.map(f => f.pattern))].join(', ')}), and secrets.on_push is refuse` };
        continue;
      }
      const path = join(folder, p);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(path, content, { mode: 0o600 });
      touched.push(`${rel}/${p}`);
    }
    for (const p of input.removes) {
      const why = ours(p);
      if (why) { result.held[p] = { code: 'owned_folder_conflict', detail: `${rel}/${p} ${why}` }; continue; }
      if (!recorded[p]) continue;
      rmSync(join(folder, p), { force: true });
      touched.push(`${rel}/${p}`);
    }
    if (!touched.length) return result;
    let commit: ReturnType<typeof commitPaths>;
    try {
      commit = commitPaths(root, touched, input.message, { roots: [''], lockPath: lock.lockPath, markHeld: false, owned: true });
    } catch (error) {
      restore(root, touched);
      throw error;
    }
    const skipped = new Set(commit.skipped.map(s => s.path));
    if (skipped.size) restore(root, [...skipped]);
    result.sha = commit.sha;
    for (const path of touched) {
      const p = relative(rel, path).split('\\').join('/');
      if (skipped.has(path)) { result.held[p] = { code: 'owned_folder_conflict', detail: `git left ${path} out of the commit` }; continue; }
      if (input.removes.includes(p)) result.removed.push(p);
      else { const blob = headBlob(root, path); if (blob) result.written[p] = blob; }
    }
    return result;
  } finally {
    lock.release();
  }
}
