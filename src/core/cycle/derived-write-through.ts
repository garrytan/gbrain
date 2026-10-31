/**
 * Opt-in markdown write-through for pages the dream cycle generates on an
 * unmanaged brain (#5041): atoms (`extract_atoms`) and concepts
 * (`synthesize_concepts`). Off by default, so the cycle never adds files to a
 * user's repository unasked; managed brains publish these pages through
 * maintenance publication instead and never reach this module.
 *
 * Enabled by `cycle.extract_atoms.write_through` /
 * `cycle.synthesize_concepts.write_through`. Each written page goes through
 * `writePageThrough` (honouring `sync.write_through=off`, source containment
 * and case collisions). A page whose target is ignored by git or sits in a
 * declared `storage.db_only` directory (which sync gitignores) stays
 * database-only. The first run after the key is enabled also writes the
 * generated pages that have no file yet, a bounded batch per run. A page the
 * phase retires has its file removed, so sync cannot bring it back.
 *
 * #8073: in a Git checkout those files are committed, one commit per batch
 * through the shared-checkout door (`commitPathsLocked`), and a refused commit
 * rolls the batch's files back (`commitDerivedChanges`), so the cycle never
 * leaves untracked or modified files that make the scheduled sync skip.
 *
 * #6982: a file is replaced or removed only when it holds nothing the
 * database lacks (`replaceableFile`: absent, or equal to the page or one of
 * its recent versions), and the write is bound to the bytes compared. A file
 * holding a hand edit or an unindexed file at the path is left as it is and
 * the page is reported in the hook's `held` list (`file_database_drift`).
 */
import { execFileSync } from '../spawn.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { Page } from '../types.ts';
import { throwIfAborted } from '../abort-check.ts';
import { validateSourceId } from '../utils.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { deletePageThrough, isWriteThroughDisabled, resolvePageWriteTarget, writePageThrough, type PageWriteTarget } from '../write-through.ts';
import { urlCloneReadOnly } from '../url-clone.ts';
import { gitChildEnv, literalPathspecs } from '../git-env.ts';
import { classifyGitCheckout, type GitCheckoutClass } from '../git-checkout.ts';
import { acquireCommitLockAsync, checkoutRoot, commitAndPush, commitPathsLocked, COMMIT_LOCK_ENV, notePending, scopePaths, settlePending } from '../git/commit-push.ts';
import { managedFilesystemRootFor, refreshManagedFilesystemRoots } from '../persistence/filesystem-guard.ts';
import { withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { fileDatabaseDriftToken, replaceableFile } from '../facts/file-body-guard.ts';

export const DERIVED_WRITE_THROUGH_KEYS = {
  extract_atoms: 'cycle.extract_atoms.write_through',
  synthesize_concepts: 'cycle.synthesize_concepts.write_through',
} as const;

/** Pages without a file written per run by the enable-time backfill. */
export const DERIVED_BACKFILL_LIMIT = 200;

const ON_VALUES = new Set(['true', '1', 'yes', 'on']);

export async function derivedWriteThroughEnabled(engine: BrainEngine, phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS): Promise<boolean> {
  const raw = await engine.getConfig(DERIVED_WRITE_THROUGH_KEYS[phase]).catch(() => null);
  return raw != null && ON_VALUES.has(raw.trim().toLowerCase());
}

function gitIgnores(root: string, filePath: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', relative(root, filePath)], { env: gitChildEnv(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout file a generated page publishes to, or why it has none this
 * module writes: write-through off (`disabled_by_config`), no resolvable
 * target, or a target ignored by git or inside a declared `storage.db_only`
 * directory (`not_canonical`). `includeDeleted` resolves a retired page's
 * recorded path.
 */
export async function derivedFileTarget(engine: BrainEngine, slug: string, sourceId: string,
  opts: { includeDeleted?: boolean } = {}): Promise<{ ok: true; target: Extract<PageWriteTarget, { ok: true }> } | { ok: false; skipped: string }> {
  if (await isWriteThroughDisabled(engine)) return { ok: false, skipped: 'disabled_by_config' };
  const target = await resolvePageWriteTarget(engine, slug, sourceId, opts);
  if (!target.ok) return { ok: false, skipped: target.skipped };
  let storage = null;
  try { storage = loadStorageConfig(target.writeRoot); } catch { /* unreadable gbrain.yml: sync reports it */ }
  if ((storage && isDbOnly(slug, storage)) || gitIgnores(target.writeRoot, target.filePath)) return { ok: false, skipped: 'not_canonical' };
  return { ok: true, target };
}

/** One file a derived write changed (#8073): its bytes before and after (null: absent) and the source_path the write bound. */
interface DerivedFileChange { slug: string; sourceId: string; filePath: string; writeRoot: string; prior: string | null; after: string | null; bound: string | null }

/** A batch commit the checkout refused: the door's code and message, the batch's files (root-relative) and those left as they were. */
export interface DerivedCommitFailure { code: string; message: string; root: string; paths: string[]; kept: string[] }

/**
 * Test seams. `beforeCommit` runs after a batch's files are written and before its commit; a throw stands in for a crash
 * (no rollback). `checkoutClass` replaces `classifyGitCheckout` for a write root (an `unknown` answer needs a failed lookup).
 */
export const derivedWriteSeams: { beforeCommit?: (root: string) => void; checkoutClass?: (root: string) => GitCheckoutClass } = {};

/** Whether `root` sits in a Git checkout this module commits into (`classifyGitCheckout`, or the test seam). */
function checkoutClassOf(root: string): GitCheckoutClass {
  return (derivedWriteSeams.checkoutClass ?? classifyGitCheckout)(root);
}

/** How long a batch waits, without blocking the event loop, for the checkout's commit lock before it rolls back. */
const DERIVED_COMMIT_LOCK_WAIT_MS = 30_000;
/** #8092: the synchronous take once the lock was seen free, and the rollback's wait for it (as the classic write-through's). */
const DERIVED_COMMIT_LOCK_TAKE_MS = 2_000;

/** #8092: op_checkpoints op naming a generated page whose file change a refused commit rolled back or left unwritten; the phase's next hook retries it. */
const RETRY_OP = 'derived-write-retry';
const retryKey = (sourceId: string, slug: string) => `${sourceId}:${slug}`;

async function markRetry(engine: BrainEngine, pages: ReadonlyArray<{ sourceId: string; slug: string }>): Promise<void> {
  for (const { sourceId, slug } of pages) {
    await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ($1, $2, $3::text::jsonb)
      ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at = now()`, [RETRY_OP, retryKey(sourceId, slug), JSON.stringify([{ source_id: sourceId, slug }])]);
  }
}

async function clearRetry(engine: BrainEngine, sourceId: string, slugs: readonly string[]): Promise<void> {
  if (slugs.length) await engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = ANY($2::text[])', [RETRY_OP, slugs.map(slug => retryKey(sourceId, slug))]);
}

/** The changes of `changes` a failure lists (rolled back, or left for the pending ledger). */
const failedChanges = (changes: readonly DerivedFileChange[], failures: readonly DerivedCommitFailure[]) =>
  changes.filter(c => failures.some(f => f.root === c.writeRoot && f.paths.includes(relative(c.writeRoot, c.filePath))));

/** The file write of `writeDerivedPageThrough`, uncommitted, with the change it made. */
async function writeDerivedFile(engine: BrainEngine, slug: string, sourceId: string,
  opts: { expectedFileBytes?: string | null }): Promise<{ written: boolean; skipped?: string; error?: string; change?: DerivedFileChange }> {
  const resolved = await derivedFileTarget(engine, slug, sourceId);
  if (!resolved.ok) return { written: false, skipped: resolved.skipped };
  let expectedFileBytes = opts.expectedFileBytes;
  if (expectedFileBytes === undefined) {
    const file = await replaceableFile(engine, sourceId, slug, resolved.target.filePath);
    if (!file.ok) return { written: false, skipped: 'file_database_drift' };
    expectedFileBytes = file.expectedFileBytes;
  }
  const [row] = await engine.executeRaw<{ source_path: string | null }>(
    'SELECT source_path FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
  const result = await writePageThrough(engine, slug, { sourceId, expectedFileBytes, deferCommit: true });
  if (result.error) console.error(`[write-through] ${slug}: ${result.error}`);
  if (!result.written || !result.path) return result;
  noteWritten(resolved.target.writeRoot, result.path);
  return { ...result, change: { slug, sourceId, filePath: result.path, writeRoot: resolved.target.writeRoot, prior: expectedFileBytes,
    after: result.content!, bound: row?.source_path === null ? resolved.target.sourcePathToBind : null } };
}

/**
 * Record a file this module just wrote or removed in the checkout's pending write-through ledger (`notePending`), so a
 * crash before its batch commits leaves it for the next locked commit there (`commitPathsLocked` sweeps the ledger's
 * paths that are inside the source root and still differ from HEAD). Only paths gbrain wrote are ever recorded.
 */
function noteWritten(root: string, filePath: string): void {
  try {
    if (checkoutClassOf(root) !== 'git') return;
    const top = checkoutRoot(root);
    notePending(top, scopePaths(top, [filePath], top));
  } catch { /* best-effort: the batch commit right after is the primary path */ }
}

/**
 * Write one generated page's markdown file and commit it (#8073). Never
 * throws; the result says whether a file was written, why not, or the write
 * error. Ignored and db_only targets are skipped on purpose
 * (`skipped: 'not_canonical'`). `expectedFileBytes` binds the write to the
 * file the caller read (and already compared); without it the file must pass
 * `replaceableFile` first, else nothing is written
 * (`skipped: 'file_database_drift'`). A commit the checkout refuses rolls the
 * file back and comes back as `error` (`<code>: <message>`).
 */
export async function writeDerivedPageThrough(engine: BrainEngine, slug: string, sourceId: string,
  opts: { expectedFileBytes?: string | null } = {}): Promise<{ written: boolean; skipped?: string; error?: string }> {
  const { change, ...result } = await writeDerivedFile(engine, slug, sourceId, opts);
  if (!change) return result;
  const [failure] = await commitDerivedChanges(engine, 'synthesize_concepts', [change]);
  if (!failure) {
    await clearRetry(engine, sourceId, [slug]);
    return result;
  }
  await markRetry(engine, [change]);
  return { written: false, error: `${failure.code}: ${failure.message}` };
}

/**
 * Remove a retired generated page's file, uncommitted, when the retired page
 * (or one of its versions) holds everything in it; the unlink is bound to the
 * bytes compared. Returns `file_database_drift` when the file holds an edit
 * the database lacks.
 */
async function deleteDerivedFile(engine: BrainEngine, slug: string, sourceId: string): Promise<{ removed: boolean; skipped?: string; change?: DerivedFileChange }> {
  const resolved = await derivedFileTarget(engine, slug, sourceId, { includeDeleted: true });
  if (!resolved.ok) return { removed: false, skipped: resolved.skipped };
  const file = await replaceableFile(engine, sourceId, slug, resolved.target.filePath);
  if (!file.ok) return { removed: false, skipped: 'file_database_drift' };
  if (file.expectedFileBytes === null) return { removed: false, skipped: 'file_not_present' };
  const result = await deletePageThrough(engine, slug, { sourceId, target: resolved.target, expectedFileBytes: file.expectedFileBytes, deferCommit: true });
  if (!result.removed) return result;
  noteWritten(resolved.target.writeRoot, resolved.target.filePath);
  return { ...result, change: { slug, sourceId, filePath: resolved.target.filePath, writeRoot: resolved.target.writeRoot, prior: file.expectedFileBytes, after: null, bound: null } };
}

/**
 * #8073: commit a batch of derived file changes through the shared-checkout commit door (`commitPathsLocked`: the commit
 * lock, `commit --only` of exactly the named paths), one commit per checkout, under the source filesystem lock. Only paths
 * that exist or are tracked are named (an untracked file the batch removed has nothing to commit). A directory that is not
 * a Git checkout, or whose checkout lookup fails (`unknown`), has nothing to commit: its files are the record. A refused
 * commit rolls the batch back (`rollBackDerived`) and comes back as a typed failure unless every file was committed meanwhile.
 */
async function commitDerivedChanges(engine: BrainEngine, label: string, changes: readonly DerivedFileChange[]): Promise<DerivedCommitFailure[]> {
  const failures: DerivedCommitFailure[] = [];
  for (const root of new Set(changes.map(c => c.writeRoot))) {
    const batch = changes.filter(c => c.writeRoot === root);
    if (checkoutClassOf(root) !== 'git') continue;
    derivedWriteSeams.beforeCommit?.(root);
    try {
      await refreshManagedFilesystemRoots(engine);
      const managed = managedFilesystemRootFor(root) !== null;
      const commit = async () => {
        const rels = batch.map(c => relative(root, c.filePath));
        const tracked = new Set(gitPaths(root, ['ls-files', '-z', '--', ...literalPathspecs(rels)]));
        const ignored = new Set(gitPaths(root, ['check-ignore', '-z', '--stdin', '--no-index'], rels.join('\0')));
        const paths = batch.filter((c, i) => !ignored.has(rels[i]!) && (existsSync(c.filePath) || tracked.has(rels[i]!))).map(c => c.filePath);
        if (!paths.length) return;
        const message = `gbrain: ${label} write-through (${paths.length} generated file(s))`;
        if (!process.env[COMMIT_LOCK_ENV]) await (await acquireCommitLockAsync(checkoutRoot(root), DERIVED_COMMIT_LOCK_WAIT_MS)).release();
        if (managed) commitAndPush({ repo: root, cwd: root, paths, message, lockWaitMs: DERIVED_COMMIT_LOCK_TAKE_MS });
        else commitPathsLocked(root, paths, message, { lockWaitMs: DERIVED_COMMIT_LOCK_TAKE_MS });
      };
      if (managed) await commit();
      else await withSourceFilesystemLock(engine, root, commit);
    } catch (error) {
      const failure = await rollBackDerived(engine, root, batch, error);
      if (failure) failures.push(failure);
    }
  }
  return failures;
}

/** NUL-separated paths a git listing command prints from `root` (exit 1, as `check-ignore` gives for none, is an empty list). */
function gitPaths(root: string, args: string[], input?: string): string[] {
  try {
    return execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', ...(input === undefined ? {} : { input }) }).split('\0').filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/**
 * Undo a batch whose commit was refused: each file still holding the bytes the batch wrote gets its prior bytes back (or is
 * removed when it had none), and the source_path the write bound is cleared so the next run's backfill writes the page
 * again. A file changed since (another writer's edit) is left as it is and listed in `kept`. A file whose change HEAD
 * already holds (another writer's locked commit swept it in from the pending ledger) is committed, not rolled back:
 * restoring it would leave an uncommitted revert of HEAD. Null when every file of the batch is committed.
 * #8092: it runs under the checkout's commit lock (a short wait), so no writer commits between the HEAD check and the
 * restore, and it settles the restored paths out of the pending ledger, so a later edit at one of them is never swept into
 * a gbrain commit. When the lock stays busy nothing is restored: every file stays in the ledger for that writer's commit.
 */
async function rollBackDerived(engine: BrainEngine, root: string, batch: readonly DerivedFileChange[], error: unknown): Promise<DerivedCommitFailure | null> {
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'git_unavailable';
  const message = error instanceof Error ? error.message : String(error);
  const top = checkoutRoot(root);
  const lock = await acquireCommitLockAsync(top, DERIVED_COMMIT_LOCK_TAKE_MS).catch(() => null);
  try {
    const pending = batch.filter(change => !headHolds(root, change));
    if (!pending.length) return null;
    const paths = pending.map(c => relative(root, c.filePath));
    if (!lock) {
      console.error(`[write-through] commit refused (${code}): the commit lock stayed busy, so ${pending.length} generated file(s) are left for the next locked commit`);
      return { code, message, root, paths, kept: paths };
    }
    const kept = await restoreDerived(engine, root, pending);
    settlePending(top);
    console.error(`[write-through] commit refused (${code}): ${pending.length - kept.length} generated file(s) rolled back, ${kept.length} left as they are`);
    return { code, message, root, paths, kept };
  } finally { await lock?.release(); }
}

/** Puts back the prior bytes of each change still holding the bytes it wrote and clears the source_path it bound; returns the root-relative paths left as they are. */
async function restoreDerived(engine: BrainEngine, root: string, pending: readonly DerivedFileChange[]): Promise<string[]> {
  const kept: string[] = [];
  for (const change of pending) {
    try {
      if ((existsSync(change.filePath) ? readFileSync(change.filePath, 'utf-8') : null) !== change.after) throw new Error('file_changed');
      if (change.prior === null) rmSync(change.filePath, { force: true });
      else {
        mkdirSync(dirname(change.filePath), { recursive: true });
        writeFileSync(`${change.filePath}.${process.pid}.tmp`, change.prior, 'utf-8');
        renameSync(`${change.filePath}.${process.pid}.tmp`, change.filePath);
      }
      if (change.bound) {
        await engine.executeRaw('UPDATE pages SET source_path = NULL WHERE source_id = $1 AND slug = $2 AND source_path = $3 AND deleted_at IS NULL',
          [change.sourceId, change.slug, change.bound]);
      }
    } catch {
      kept.push(relative(root, change.filePath));
    }
  }
  return kept;
}

/** Whether HEAD of `root`'s checkout already holds the change's resulting bytes (absent for a removal); false when HEAD is unreadable. */
function headHolds(root: string, change: DerivedFileChange): boolean {
  const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { run(['rev-parse', '--verify', '-q', 'HEAD']); } catch { return false; }
  try {
    return run(['show', `HEAD:./${relative(root, change.filePath).split('\\').join('/')}`]) === change.after;
  } catch {
    return change.after === null;
  }
}

/** `result` with its held page files reported: added to `details.file_holds`, a `warn` status unless it failed, and a summary note. */
export function reportFileHolds(result: PhaseResult, held: readonly string[] | undefined, noun: string): PhaseResult {
  if (!held?.length) return result;
  return { ...result, status: result.status === 'fail' ? 'fail' : 'warn',
    details: { ...result.details, file_holds: [...new Set([...((result.details.file_holds as string[] | undefined) ?? []), ...held])] },
    summary: `${result.summary} (${held.length} ${noun} file(s) held: ${[...new Set(held.map(h => /^\S+ \((\w+)/.exec(h)?.[1] ?? 'file_database_drift'))].join(', ')})` };
}

/** `result` with the hook's held files (`reportFileHolds`) and refused commits reported: `details.write_through_failed` and a `warn` status unless it failed. */
export function reportDerivedWriteThrough(result: PhaseResult, files: DerivedWriteThrough | null, noun: string): PhaseResult {
  const reported = reportFileHolds(result, files?.held, noun);
  if (!files?.failed.length) return reported;
  const kept = files.failed.reduce((n, f) => n + f.kept.length, 0);
  const count = files.failed.reduce((n, f) => n + f.paths.length, 0) - kept;
  return { ...reported, status: reported.status === 'fail' ? 'fail' : 'warn',
    details: { ...reported.details, write_through_failed: files.failed },
    summary: `${reported.summary} (${noun} file commit refused: ${files.failed[0]!.code}; ${count} file(s) rolled back${kept ? `, ${kept} left as they are` : ''}; the next run writes them again)` };
}

/**
 * The phase's write-through hook: `write` publishes pages and removes retired ones' files, one commit per call; `held`
 * reports each page left alone, `failed` each refused commit (after which the hook writes nothing more this run). #8092:
 * a page whose change was rolled back, or not written after a refusal, is marked for retry (`RETRY_OP`) and the next run's
 * hook writes or removes its file again, an update of an existing file included.
 */
export interface DerivedWriteThrough {
  write(slugs: readonly string[], retired?: readonly string[]): Promise<void>;
  held: string[];
  failed: DerivedCommitFailure[];
}

/**
 * The phase's write-through hook, or null when it does not apply (key off,
 * managed brain, dry run): writes the given pages and removes the files of
 * the retired ones, then commits the batch. Creating it writes the bounded
 * backfill of generated pages of the phase's type in the source that have no
 * file yet.
 */
export async function derivedWriteThrough(
  engine: BrainEngine,
  phase: keyof typeof DERIVED_WRITE_THROUGH_KEYS,
  sourceId: string,
  opts: { managed: boolean; dryRun: boolean },
): Promise<DerivedWriteThrough | null> {
  if (opts.managed || opts.dryRun || !await derivedWriteThroughEnabled(engine, phase)) return null;
  const held: string[] = [];
  const failed: DerivedCommitFailure[] = [];
  const kept = (skipped: string | undefined) => skipped === 'file_database_drift' || skipped === 'file_changed';
  const write = async (slugs: readonly string[], retired: readonly string[] = []) => {
    if (failed.length) return markRetry(engine, [...slugs, ...retired].map(slug => ({ sourceId, slug })));
    const changes: DerivedFileChange[] = [];
    for (const slug of slugs) {
      const result = await writeDerivedFile(engine, slug, sourceId, {});
      if (result.change) changes.push(result.change);
      if (kept(result.skipped)) held.push(fileDatabaseDriftToken(slug, sourceId, 'before', 'the generated page was not written to its file'));
    }
    for (const slug of retired) {
      const result = await deleteDerivedFile(engine, slug, sourceId);
      if (result.change) changes.push(result.change);
      if (kept(result.skipped)) held.push(fileDatabaseDriftToken(slug, sourceId, 'before', 'the retired page\'s file was not removed'));
    }
    const failures = await commitDerivedChanges(engine, phase, changes);
    failed.push(...failures);
    const unsettled = failedChanges(changes, failures);
    await markRetry(engine, unsettled);
    await clearRetry(engine, sourceId, [...slugs, ...retired].filter(slug => !unsettled.some(c => c.slug === slug)));
  };
  const rows = await engine.executeRaw<{ slug: string; retired: boolean }>(
    `SELECT slug, deleted_at IS NOT NULL AS retired FROM pages p
      WHERE source_id = $1
        AND ((deleted_at IS NULL AND source_path IS NULL)
          OR EXISTS (SELECT 1 FROM op_checkpoints c WHERE c.op = $4 AND c.fingerprint = p.source_id || ':' || p.slug))
        AND type = $2 AND ($2 <> 'concept' OR frontmatter->>'synthesized_by' LIKE 'synthesize_concepts%')
        AND COALESCE(frontmatter->>'source_hash', '') NOT LIKE 'pending:%'
      ORDER BY id LIMIT $3`,
    [sourceId, phase === 'extract_atoms' ? 'atom' : 'concept', DERIVED_BACKFILL_LIMIT, RETRY_OP],
  );
  await write(rows.filter(r => !r.retired).map(r => r.slug), rows.filter(r => r.retired).map(r => r.slug));
  return { write, held, failed };
}

/** What a dream reverse-write did with one page's file. `held` is its `file_database_drift` entry. */
export type DreamPageFileWrite = { written: true; path: string } | { written: false; held?: string; skipped?: string; error?: string };

/** The file of a dream page: its record target (`resolvePageWriteTarget`), else the caller's brainDir layout; null when it has none. */
async function dreamFileTarget(engine: BrainEngine, brainDir: string, slug: string, sourceId: string, nativeSourceId: string):
  Promise<{ filePath: string; root: string } | { skipped: string }> {
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok && (!brainDir || (target.skipped !== 'no_repo_configured' && target.skipped !== 'repo_not_found'))) return { skipped: target.skipped };
  if (target.ok) return { filePath: target.filePath, root: target.writeRoot };
  return { filePath: sourceId === nativeSourceId ? join(brainDir, `${slug}.md`) : join(brainDir, '.sources', sourceId, `${slug}.md`), root: brainDir };
}

/**
 * #6982: write the file of a page the dream cycle wrote in the database (a synthesis or patterns output, the cycle
 * summary) without replacing an edit only the file holds, then commit it (#8073: `commitDerivedChanges`; a refused
 * commit rolls the file back and returns its `write_through_failed` hold). Nothing is written with `sync.write_through`
 * off, for a clone gbrain owns, or for a declared `storage.db_only` slug: the database is the copy of record. The file is
 * the page's file of record (`resolvePageWriteTarget`: recorded source_path, own-local_path roots); a source with no
 * usable checkout (no root configured, or the root is missing) keeps the caller's brainDir layout (`<brainDir>/<slug>.md`,
 * foreign sources under `.sources/<id>/`). The file is replaced only when `replaceableFile` finds nothing in it the
 * database lacks, and is re-read after the replacement is staged, right before the rename, so an edit that lands in
 * between is kept as well.
 *
 * This is the reverse-write's own direct write (a staged sibling renamed over the file), as before, not
 * `writePageThrough` or `atomicWriteFileSync`: once a subagent's tool write has gone through the coordinator, the
 * checkout carries an owner marker and both refuse `writer_coordinator_required`, which would leave the file behind the
 * database for the next coordinated write to refuse as drift. Such a checkout commits through commit-push's named-paths
 * path instead of the classic door.
 */
export async function writeDreamPageFile(engine: BrainEngine, brainDir: string, slug: string, sourceId: string,
  opts: { nativeSourceId: string; markdown: string }): Promise<DreamPageFileWrite> {
  const file = await writeDreamFile(engine, brainDir, slug, sourceId, opts);
  if (!file.change) return file.result;
  const [failure] = await commitDerivedChanges(engine, 'dream', [file.change]);
  return failure ? { written: false, held: dreamCommitFailedToken(slug, failure) } : file.result;
}

/** The file write of `writeDreamPageFile`, uncommitted, with the change it made. */
async function writeDreamFile(engine: BrainEngine, brainDir: string, slug: string, sourceId: string,
  opts: { nativeSourceId: string; markdown: string }): Promise<{ result: DreamPageFileWrite; change?: DerivedFileChange }> {
  if (await isWriteThroughDisabled(engine)) return { result: { written: false, skipped: 'disabled_by_config' } };
  if (await urlCloneReadOnly(engine, sourceId)) return { result: { written: false, skipped: 'url_clone' } };
  const target = await dreamFileTarget(engine, brainDir, slug, sourceId, opts.nativeSourceId);
  if ('skipped' in target) return { result: { written: false, skipped: target.skipped } };
  try {
    const storage = loadStorageConfig(target.root);
    if (storage && isDbOnly(slug, storage)) return { result: { written: false, skipped: 'db_only' } };
  } catch { /* unreadable gbrain.yml: sync reports it */ }
  const { filePath } = target;
  const check = await replaceableFile(engine, sourceId, slug, filePath);
  if (!check.ok) return { result: { written: false, held: dreamFileDriftToken(slug, sourceId, 'before') } };
  mkdirSync(dirname(filePath), { recursive: true });
  const staged = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staged, opts.markdown, 'utf-8');
  if ((existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null) !== check.expectedFileBytes) {
    rmSync(staged, { force: true });
    return { result: { written: false, held: dreamFileDriftToken(slug, sourceId, 'during') } };
  }
  renameSync(staged, filePath);
  noteWritten(target.root, filePath);
  return { result: { written: true, path: filePath },
    change: { slug, sourceId, filePath, writeRoot: target.root, prior: check.expectedFileBytes, after: opts.markdown, bound: null } };
}

/**
 * GBRA-161 PR 4: remove the file of a dream page a generation retired, resolved the way `writeDreamPageFile` wrote it, only
 * when the retired page (or one of its versions) holds everything in it; re-read right before the unlink. A file holding
 * an edit the database lacks stays, with its `file_database_drift` entry returned as `held`. The removal commits
 * (#8073); a refused commit puts the file back and returns its `write_through_failed` hold.
 */
export async function removeDreamPageFile(engine: BrainEngine, brainDir: string, slug: string, sourceId: string,
  nativeSourceId: string): Promise<{ removed: boolean; held?: string }> {
  if (await isWriteThroughDisabled(engine) || await urlCloneReadOnly(engine, sourceId)) return { removed: false };
  const target = await dreamFileTarget(engine, brainDir, slug, sourceId, nativeSourceId);
  if ('skipped' in target) return { removed: false };
  const { filePath } = target;
  if (!existsSync(filePath)) return { removed: false };
  const check = await replaceableFile(engine, sourceId, slug, filePath);
  if (!check.ok || readFileSync(filePath, 'utf-8') !== check.expectedFileBytes) {
    return { removed: false, held: fileDatabaseDriftToken(slug, sourceId, 'before', "the retired dream page's file was not removed") };
  }
  rmSync(filePath, { force: true });
  noteWritten(target.root, filePath);
  const [failure] = await commitDerivedChanges(engine, 'dream retirement',
    [{ slug, sourceId, filePath, writeRoot: target.root, prior: check.expectedFileBytes, after: null, bound: null }]);
  return failure ? { removed: false, held: dreamCommitFailedToken(slug, failure) } : { removed: true };
}

/** #6982: the hold entry for a dream page whose file holds an edit the database lacks. */
function dreamFileDriftToken(slug: string, sourceId: string, when: 'before' | 'during'): string {
  return fileDatabaseDriftToken(slug, sourceId, when, 'the dream output stays in the database only', 'the dream reverse-write');
}

/** #8073: the hold entry for a dream page whose file commit the checkout refused (the file was rolled back). */
function dreamCommitFailedToken(slug: string, failure: DerivedCommitFailure): string {
  return `${slug} (write_through_failed: ${failure.code}: the checkout refused the commit of this page's file, so the file was rolled back `
    + `and the dream output stays in the database only; ${failure.kept.length ? `${failure.kept.length} file(s) changed meanwhile were left as they are; ` : ''}`
    + 'fix the checkout (git status there), then the next write of the page commits its file)';
}

/**
 * The dream reverse-write loop (synthesize, patterns, #6982): each ref's page rendered by `render` and written through
 * `writeDreamFile`, then the files written commit as one batch (#8073), also when an abort or an error stops the loop. A
 * page whose file holds an edit the database lacks keeps that file and its `file_database_drift` entry is pushed to
 * `held`; a refused commit rolls the batch back and pushes each page's `write_through_failed` entry; an abort stops
 * before the next file; other per-page failures are logged and skipped. Returns the number of files written and committed.
 */
export async function reverseWriteDreamRefs<R extends { slug: string; source_id: string }>(engine: BrainEngine, brainDir: string, refs: R[],
  opts: { phase: string; nativeSourceId: string; render: (page: Page, tags: string[], ref: R) => string; signal?: AbortSignal; held?: string[] }): Promise<number> {
  const changes: DerivedFileChange[] = [];
  let rolledBack = 0;
  try {
    for (const ref of refs) {
      const { slug, source_id } = ref;
      throwIfAborted(opts.signal, `[dream] ${opts.phase} reverse-write`);
      // v0.32.8 F6: validate source_id is filesystem-safe before any join().
      validateSourceId(source_id);
      const page = await engine.getPage(slug, { sourceId: source_id });
      if (!page) continue;
      const tags = await engine.getTags(slug, { sourceId: source_id });
      // #4077: re-check after the row reads — an abort that lands during
      // getPage/getTags must not reach this ref's file write.
      throwIfAborted(opts.signal, `[dream] ${opts.phase} reverse-write`);
      try {
        const file = await writeDreamFile(engine, brainDir, slug, source_id, { nativeSourceId: opts.nativeSourceId, markdown: opts.render(page, tags, ref) });
        if (file.change) changes.push(file.change);
        else if (!file.result.written && file.result.held) opts.held?.push(file.result.held);
        else if (!file.result.written && file.result.error) process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${file.result.error}\n`);
      } catch (e) {
        // Per-slug failures are non-fatal — phase continues.
        process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  } finally {
    for (const failure of await commitDerivedChanges(engine, opts.phase, changes)) {
      for (const change of changes.filter(c => c.writeRoot === failure.root && failure.paths.includes(relative(c.writeRoot, c.filePath)))) {
        opts.held?.push(dreamCommitFailedToken(change.slug, failure));
        rolledBack++;
      }
    }
  }
  return changes.length - rolledBack;
}
