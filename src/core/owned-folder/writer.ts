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
import { ledgerLocation, readLedger } from '../git/commit-ledger.ts';
import { git } from '../git/git-run.ts';
import { onPushMode } from '../git/redact-unpushed.ts';
import { OperationError } from '../ops/contract.ts';
import { scanText } from '../secret-scan.ts';
import type { BrainEngine } from '../engine.ts';
import { readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { connectorCheckpointKey, type ConnectorIdentity } from '../persistence/connector-identity.ts';
import { OWNED_FOLDER_ROOT } from './paths.ts';

export const OWNER_FILE = 'OWNER.json';
export const README_FILE = 'README.md';

/** What the writer remembers between runs, kept in the database in one row per source incarnation (readOwnedState). */
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

type Exec = Pick<BrainEngine, 'executeRaw'>;
type OwnedState = OwnedFolderState & { held?: Record<string, OwnedHold> };
/** The row keeps no config digest, so changing the source's timezone or day counts keeps the record of what it wrote. */
export const ownedStateKey = (sourceId: string, incarnation: string, kind: ConnectorIdentity['kind']) => connectorCheckpointKey(sourceId, incarnation, { kind, digest: 'owned-folder' });

export async function readOwnedState(engine: Exec, sourceId: string, incarnation: string, kind: ConnectorIdentity['kind']): Promise<OwnedState | undefined> {
  const owned = ((await readConnectorDbCursor(engine, ownedStateKey(sourceId, incarnation, kind))).state as { owned?: OwnedState } | null)?.owned;
  return owned?.incarnation === incarnation ? owned : undefined;
}

export async function writeOwnedState(engine: Exec, sourceId: string, kind: ConnectorIdentity['kind'], owned: OwnedState): Promise<void> {
  await writeConnectorDbCursor(engine, ownedStateKey(sourceId, owned.incarnation, kind), { owned });
}

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

/**
 * A publish redaction (GST-2988, the default `secrets.on_push redact`) rebuilds unpushed commits and moves the checkout's
 * files and index to the redacted blobs, ledgering each rebuilt commit as `redact_rebuild` superseding the old one. A
 * recorded blob that a rebuild replaced moves to its redacted successor, and `last_batch` to its rebuilt commit, so the
 * redacted file is still this writer's. Ledger records are read in order, so a rebuild of a rebuild follows the chain.
 * Records are written before the rebuild moves the branch, so a remapped blob is adopted only when it is the HEAD blob,
 * and `last_batch` only when the rebuilt commit is in HEAD. A superseded commit Git no longer has (its backup ref
 * expired) is skipped. Returns whether `state` changed.
 */
export function adoptRedactions(root: string, rel: string, state: OwnedFolderState): boolean {
  const loc = ledgerLocation(root);
  if (!loc) return false;
  let records: ReturnType<typeof readLedger>;
  try { records = readLedger(loc.common); } catch { return false; }
  const files = { ...state.files };
  let batch = state.last_batch;
  for (const record of records) {
    if (record.e !== 'commit' || record.writer !== 'redact_rebuild' || record.held) continue;
    for (const old of record.supersedes ?? []) {
      if (batch === old) batch = record.sha;
      const diff = git(root, ['diff-tree', '-r', '-z', '--no-renames', old, record.sha, '--', rel]);
      if (diff.code !== 0) continue;
      const parts = diff.stdout.split('\0');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const [, , from, to] = parts[i]!.split(' ');
        const p = relative(rel, parts[i + 1]!).split('\\').join('/');
        if (from && to && !/^0+$/.test(to) && files[p] === from) files[p] = to;
      }
    }
  }
  let changed = false;
  for (const [p, blob] of Object.entries(files)) {
    if (blob === state.files[p] || blob !== headBlob(root, `${rel}/${p}`)) continue;
    state.files[p] = blob;
    changed = true;
  }
  if (batch && batch !== state.last_batch && git(root, ['merge-base', '--is-ancestor', batch, 'HEAD']).code === 0) { state.last_batch = batch; changed = true; }
  return changed;
}

/** Whether `dir` holds anything but (nested) empty directories. */
function holdsFiles(dir: string): boolean {
  try { return readdirSync(dir, { withFileTypes: true }).some(e => !e.isDirectory() || holdsFiles(join(dir, e.name))); } catch { return false; }
}

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
    `Move the file out of ${OWNED_FOLDER_ROOT}/ (or restore the committed file: git checkout -- ${path}), then run gbrain sync --source ${sourceId}.`,
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
  let at = `${rel}/`;
  try {
    if (symlinkOnPath(root, rel)) throw ownedConflict(`${rel}/`, 'is reached through a symlink', sourceId);
    const ownerPath = join(folder, OWNER_FILE);
    const owner = { source_id: sourceId, kind: input.kind, incarnation: input.incarnation };
    if (existsSync(ownerPath)) {
      let found: Record<string, unknown> | null = null;
      try { found = JSON.parse(readFileSync(ownerPath, 'utf8')); } catch { /* unreadable reads as not ours */ }
      if (found?.source_id !== sourceId || found?.incarnation !== input.incarnation) throw ownedConflict(`${rel}/${OWNER_FILE}`, 'names another source or an earlier one with this id', sourceId);
      for (const p of [OWNER_FILE, README_FILE]) {
        const path = `${rel}/${p}`, blob = headBlob(root, path);
        if (!state?.files[p] && blob && blobOf(root, path) === blob && indexBlob(root, path) === blob) result.written[p] = blob;
      }
    } else {
      if (holdsFiles(folder)) throw ownedConflict(`${rel}/`, 'holds files and no OWNER.json', sourceId);
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
    const writePaths = [...input.writes.keys()].map(p => `${rel}/${p}`);
    const attrs = writePaths.length ? git(root, ['check-attr', '-z', 'filter', '--', ...writePaths]).stdout.split('\0') : [];
    const filtered = new Set<string>();
    for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] !== 'unspecified' && attrs[i + 2] !== 'unset') filtered.add(attrs[i]!);
    for (const [p, content] of input.writes) {
      at = `${rel}/${p}`;
      if (filtered.has(`${rel}/${p}`)) { result.held[p] = { code: 'owned_folder_conflict', detail: `${rel}/${p} has a Git filter` }; continue; }
      // A batch committed by a run that stopped before its record was saved: the same day, the same bytes, all committed.
      if (existsSync(join(folder, p))) {
        const blob = git(root, ['hash-object', '--stdin'], { input: content }).stdout.trim();
        const path = `${rel}/${p}`;
        if (!symlinkOnPath(root, path) && blobOf(root, path) === blob && indexBlob(root, path) === blob && headBlob(root, path) === blob) { result.written[p] = blob; continue; }
      }
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
      at = `${rel}/${p}`;
      // A removal committed by a run that stopped before its record was saved: gone from the worktree, the index and HEAD.
      if (recorded[p] && !existsSync(join(folder, p)) && !indexBlob(root, at) && !headBlob(root, at)) { result.removed.push(p); continue; }
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
  } catch (error) {
    if (error instanceof OperationError) throw error;
    // A failed write, mkdir or removal (a file where a folder goes, a full disk): undo the batch so far, so the run goes to the database.
    restore(root, touched);
    throw ownedConflict(at, `could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, sourceId);
  } finally {
    lock.release();
  }
}
