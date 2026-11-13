/**
 * #6693: a page write refused because its canonical file differs from the
 * database is usually another agent's committed Git change that managed sync
 * has not imported yet, not a hand edit. That case is told apart here, from
 * Git alone and read-only: the file on disk is exactly the blob `HEAD` holds
 * for its path (nothing uncommitted), and that blob is not the one the
 * source's last imported commit (`sources.last_commit`) holds, or no import
 * is recorded yet. Any Git failure (no repository, a commit that no longer
 * exists, a path Git cannot resolve) answers false, so the write keeps the
 * ordinary drift refusal.
 *
 * The refusal stays `source_changed` / `file_database_drift` (every reader of
 * drift keeps working) and carries reason `pending_import`, which the
 * coordinator records as the receipt's `error_detail.origin`. A refused
 * `remember` gets one replay attempt from the first managed sync that
 * imports the file (`replayImportedRemembers`, repair/failed-writes.ts); any other write
 * is resubmitted by its caller after that sync.
 */
import { spawn } from '../spawn.ts';
import { statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { gitChildEnv } from '../git-env.ts';
import { HARDENED_GIT_ARGS, NO_LAZY_FETCH_ENV } from '../hardened-git.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { PENDING_IMPORT_MESSAGE, PENDING_IMPORT_OWNER } from './verb-errors.ts';

export const PENDING_IMPORT = 'pending_import';
/** #6693: the receipt origin of a write refused because sync holds the page's file (heldFileRefusal). */
export const SYNC_HELD = 'sync_held';

const GIT_TIMEOUT_MS = 30_000;
/** #7436: how long a Git child the check ended with SIGTERM gets before its process group is sent SIGKILL. */
export const GIT_KILL_GRACE_MS = 2_000;

/**
 * #7436: one Git command of the check, awaited (never a synchronous spawn, which stopped the whole write owner) and ended with
 * the preparation: when `signal` aborts (the consumer aborts it at the preparation deadline) or the command passes
 * GIT_TIMEOUT_MS, the call rejects at once and the command's process group gets SIGTERM, then SIGKILL after
 * GIT_KILL_GRACE_MS, so no Git process outlives the request that started it.
 */
function gitRead(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return gitBytes(root, args, signal).then(out => out.toString('utf8'));
}

/** #8826: gitRead's stdout as bytes, for an answer that must not be decoded lossily. GST-2331: a partial clone fetches nothing for it. */
function gitBytes(root: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const group = process.platform !== 'win32';
    const child = spawn('git', ['-c', 'core.quotepath=false', ...HARDENED_GIT_ARGS, '-C', root, ...args], { env: gitChildEnv(NO_LAZY_FETCH_ENV), stdio: ['ignore', 'pipe', 'ignore'], detached: group });
    const kill = (name: NodeJS.Signals) => { try { if (group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already gone */ } };
    const stdout: Buffer[] = [];
    let settled = false;
    const settle = (error: unknown, value = Buffer.alloc(0)) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) { resolve(value); return; }
      if (child.exitCode === null && child.signalCode === null) {
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), GIT_KILL_GRACE_MS).unref();
      }
      reject(error);
    };
    const onAbort = () => settle(signal!.reason);
    const timer = setTimeout(() => settle(new Error(`git ${args[0]} did not finish within ${GIT_TIMEOUT_MS} ms`)), GIT_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
    child.on('error', error => settle(error));
    child.on('close', code => settle(code === 0 ? undefined : new Error(`git ${args[0]} exited ${code}`), Buffer.concat(stdout)));
  });
}

/**
 * Whether the file at `path` (inside the source checkout `root`) is a committed change the source has not imported yet.
 * #7436: `signal` is the preparation's cancellation; when it aborts, the Git command in flight is killed and the check
 * rejects with its reason instead of answering, so the preparation stops.
 */
export async function committedPendingImport(engine: BrainEngine, sourceId: string, root: string, path: string, signal?: AbortSignal): Promise<boolean> {
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  const rel = `./${relative(root, path).split(sep).join('/')}`;
  try {
    const head = await committedBlob(root, path, signal);
    if (!head) return false;
    if (!source?.last_commit) return true;
    await gitRead(root, ['cat-file', '-e', `${source.last_commit}^{commit}`], signal);
    let imported = '';
    try { imported = (await gitRead(root, ['rev-parse', '--verify', '--quiet', `${source.last_commit}:${rel}`], signal)).trim(); } catch (error) {
      if (signal?.aborted) throw error;
      imported = '';
    }
    return imported !== head;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return false;
  }
}

/** The blob id HEAD holds at `path` (inside `root`), or null when HEAD has no entry there or Git cannot read it. Rejects only when `signal` aborts. */
export async function headBlob(root: string, path: string, signal?: AbortSignal): Promise<string | null> {
  return quiet(gitRead(root, ['rev-parse', '--verify', '--quiet', `HEAD:./${relative(root, path).split(sep).join('/')}`], signal), signal);
}

/** The bytes of blob `blob` in `root`'s repository as text, or null when Git cannot read it. */
export async function blobText(root: string, blob: string, signal?: AbortSignal): Promise<string | null> {
  return gitRead(root, ['cat-file', 'blob', blob], signal).then(out => out, error => { if (signal?.aborted) throw error; return null; });
}

/**
 * The blob id HEAD holds at `path` when the working-tree file there is exactly that blob (`hash-object` applies the
 * path's clean filters, as `git add` would); null when the file differs, is absent, or HEAD has no entry there.
 */
export async function committedBlob(root: string, path: string, signal?: AbortSignal): Promise<string | null> {
  const head = await headBlob(root, path, signal);
  if (!head) return null;
  return await quiet(gitRead(root, ['hash-object', '--', `./${relative(root, path).split(sep).join('/')}`], signal), signal) === head ? head : null;
}

/**
 * The newest commit after `from` (to HEAD) that touched `path`: the door commit of a strict publication that landed
 * before its row; null when no commit in that range touched it, or when Git cannot read it.
 */
export async function landedCommit(root: string, from: string | null, path: string): Promise<string | null> {
  return quiet(gitRead(root, ['rev-list', '-1', from ? `${from}..HEAD` : 'HEAD', '--', `:(literal)${relative(root, path).split(sep).join('/')}`]));
}

/** #8755: whether the index holds unmerged stages for `path` (a conflict); null when Git cannot read it. */
export async function unmergedPath(root: string, path: string, signal?: AbortSignal): Promise<boolean | null> {
  return gitRead(root, ['ls-files', '-u', '-z', '--', `:(literal)${relative(root, path).split(sep).join('/')}`], signal)
    .then(out => out.length > 0, error => { if (signal?.aborted) throw error; return null; });
}

/**
 * #8755: the absolute paths of the markers a merge, cherry-pick, revert or rebase in progress leaves in `root`'s git dir
 * (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, sequencer, rebase-merge, rebase-apply), and #8826 a bisect (BISECT_LOG) or a
 * squash merge not yet committed (SQUASH_MSG, the only marker it leaves); null when Git cannot name them. The caller checks
 * which exist. All of them live in the per-worktree git dir, which Git prints absolute and symlink-resolved, so a root
 * reached through a symlink still names the real markers. #8826: the answer is read as bytes; one that is not valid UTF-8,
 * or is not exactly one line (only its trailing newline is stripped) naming an absolute path that exists as a directory,
 * answers null. A `cherry-pick -n` leaves no marker; adoption commits only its own path (`git commit --only`).
 */
export async function operationMarkerPaths(root: string, signal?: AbortSignal): Promise<string[] | null> {
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'SQUASH_MSG'];
  let out: string;
  try { out = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await gitBytes(root, ['rev-parse', '--absolute-git-dir'], signal)); }
  catch (error) { if (signal?.aborted) throw error; return null; }
  const dir = out.endsWith('\n') ? out.slice(0, -1) : '';
  if (!dir || dir.includes('\n') || !isAbsolute(dir)) return null;
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  return markers.map(marker => join(dir, marker));
}

/** #8824: the full message of `commit` in `root`'s repository, or null when Git cannot read it. */
export async function commitMessage(root: string, commit: string): Promise<string | null> {
  return gitRead(root, ['log', '-1', '--format=%B', commit]).catch(() => null);
}

/** GST-2579: the newest commit (from HEAD) that touched `path`, with its author and author date; null when none did or Git cannot read it. */
export async function lastCommitOf(root: string, path: string): Promise<{ sha: string; author: string; date: string } | null> {
  const out = await quiet(gitRead(root, ['log', '-1', '--no-show-signature', '--format=%H%x00%an%x00%aI', 'HEAD', '--', `:(literal)${relative(root, path).split(sep).join('/')}`]));
  const [sha = '', author = '', date = ''] = (out ?? '').split('\0');
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? { sha, author, date } : null;
}

/** #8824: the first parent of `commit` in `root`'s repository, or null when it has none or Git cannot read it. */
export async function commitParent(root: string, commit: string): Promise<string | null> {
  return quiet(gitRead(root, ['rev-parse', '--verify', '--quiet', `${commit}^`]));
}

/** #8824: the blob id `rev` holds at `path` (inside `root`), or null when it has no entry there or Git cannot read it. */
export async function blobAt(root: string, rev: string, path: string): Promise<string | null> {
  return quiet(gitRead(root, ['rev-parse', '--verify', '--quiet', `${rev}:./${relative(root, path).split(sep).join('/')}`]));
}

/** #8759: the text of `path` as `commit` holds it, or null when Git cannot read it there. */
export async function fileAtCommit(root: string, commit: string, path: string): Promise<string | null> {
  return gitRead(root, ['show', `${commit}:./${relative(root, path).split(sep).join('/')}`]).catch(() => null);
}

/** The commit HEAD names in `root`, or null on an unborn branch or when Git cannot read it. */
export async function headCommit(root: string, signal?: AbortSignal): Promise<string | null> {
  return quiet(gitRead(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal), signal);
}

function quiet(read: Promise<string>, signal?: AbortSignal): Promise<string | null> {
  return read.then(out => out.trim() || null, error => { if (signal?.aborted) throw error; return null; });
}

/**
 * The refusal: nothing was overwritten; a remember waits for its replay, any other write is resubmitted after the next sync.
 * GBRA-133: neither fix starts a sync; both read the status, so no caller puts a second sync owner beside a running one.
 */
export function pendingImportRefusal(row: { source_id: string; slug: string; operation?: string }, remote: boolean, importFrom?: string,
  importFile?: { root: string; path: string }): OperationError {
  const status = ['gbrain', 'sync', 'status', '--source', row.source_id, '--json'];
  const remember = row.operation === 'remember';
  const fix: Action = remember
    ? { argv: status, consent: [], actor: 'provider', requires_exclusive: false, verify: { argv: status }, docs: 'docs/guides/write-refusals.md#pending_import',
      why: `The fact is kept in this request's receipt and queued for one automatic replay attempt by the first managed sync that imports the file; do not save it again. `
        + `This read-only status shows when the source has synced; until the replay commits, gbrain repair failed-writes --source ${row.source_id} lists the fact (a replay that is refused stays there for a person to replay).` }
    : { argv: status, consent: [], actor: remote ? 'host_admin' : 'agent', requires_exclusive: false,
      verify: { argv: status }, docs: 'docs/guides/write-refusals.md#pending_import',
      why: `${PENDING_IMPORT_OWNER.replace('<source>', row.source_id)} Once it has, read the page again and resubmit the intended write with a new request_id.` };
  const refusal = opError('source_changed', PENDING_IMPORT_MESSAGE,
    `Nothing was overwritten. The canonical file of ${row.slug} in source ${row.source_id} holds a change committed through Git that managed sync has not imported yet, `
    + (remember ? 'so this remember was refused and kept: the first sync that imports the file makes one replay attempt, with its original date and authority.'
      : 'so this write was refused rather than replacing those bytes: after the next sync imports them, read the page again and resubmit with a new request_id.'),
    { detail: 'file_database_drift', reason: PENDING_IMPORT, fix });
  // GST-1582: the last imported commit the check compared against, so a refresh-barrier consumer can hold the write for the import;
  // GST-1623: and the file it compared, so a write deferred behind a refresh is checked against that refresh before it is held.
  return importFrom === undefined ? refusal : Object.assign(refusal, { importFrom, ...(importFile ? { importFile } : {}) });
}
