/**
 * `gbrain migrate --discard-source` (engine graduation, PGLite -> Postgres):
 * after a verified move, delete what graduation kept on this computer: the
 * retained PGLite copy `<path>.graduated-<run_id>` (it still holds private
 * memory and access-token hashes), the tombstone at the old path and the
 * intent marker.
 *
 * It acts only on the recorded run, only in state `graduated`, and only after
 * the Postgres target confirms in a read-only session that it is
 * authoritative for that run (a rollback fences the target first, so a
 * pending one refuses here). The plan is read-only; its plan_hash binds the
 * run and the exact paths, and the delete re-checks both under the source's
 * kernel lock. `sourceDiscardedAt` is recorded in the manifest before the
 * first delete, and the copy is renamed to `discardingPath` before it is
 * removed, so `graduatedPath` holds the whole copy or nothing: a rollback,
 * which restores from that path, refuses from the first delete on. The
 * manifest itself stays, so `--status` keeps reporting the run.
 */
import { lstatSync, renameSync, rmSync, type Stats } from 'node:fs';
import { opError, OperationError } from '../ops/contract.ts';
import { acquireKernelLockOnly, PgliteBusyError, pgliteLockDirFor, releaseLock } from '../pglite-lock.ts';
import { measureDirSize } from '../pglite-leftovers-check.ts';
import {
  defaultGraduationDeps, existingRunError, graduationManifestPath, planHashOf, readGraduationManifest, writeGraduationManifest, type GraduationDeps,
} from './engine-graduation.ts';
import type { GraduationManifest, TargetRowState } from './engine-graduation.types.ts';
import {
  discardingPath, fsyncParent, graduatedPath, intentMarkerPath, readIntentMarker, readTombstone, removeIntentMarker, removeTombstone, TERMINAL_STATES,
} from './graduation-custody.ts';
import { discardArgv, inProgressError, statusArgv } from './graduation-errors.ts';
import { readGraduationRow } from './graduation-schema.ts';

export interface DiscardPath {
  kind: 'retained_copy' | 'tombstone' | 'intent_marker';
  path: string;
  /** A floor when `sizeIncomplete` (the same bounded walk doctor's pglite_leftovers uses). */
  bytes: number;
  sizeIncomplete: boolean;
}

export interface DiscardPlan {
  planHash: string;
  runId: string;
  dataDir: string;
  /** Redacted target URL. */
  target: string;
  /** What `--yes --expect <plan_hash>` deletes, retained copy first; empty once nothing is left. */
  paths: readonly DiscardPath[];
  sourceDiscardedAt: string | null;
}

export interface DiscardResult {
  runId: string;
  target: string;
  /** Null only when there was nothing to delete and no earlier discard is recorded. */
  sourceDiscardedAt: string | null;
  deleted: readonly DiscardPath[];
}

export interface DiscardOptions {
  yes?: boolean;
  /** `--expect <plan_hash>`: the discard plan the user approved. */
  expectPlanHash?: string;
  manifestPath?: string;
  deps?: Partial<Pick<GraduationDeps, 'connectTargets'>>;
  /** How long to wait for the source's kernel lock; a rollback or resume holding it refuses the discard. */
  lockTimeoutMs?: number;
}

const DOCS = 'docs/guides/move-to-postgres.md#discard-the-retained-copy';
const STATUS_VERIFY = { argv: statusArgv() };
const ROLLBACK_ROW_STATES: ReadonlySet<TargetRowState> = new Set(['rollback_fenced', 'rollback_approved', 'source_restoring']);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** The recorded run when it is `graduated`; every other state refuses without touching anything. */
function graduatedRun(path: string): GraduationManifest {
  const m = readGraduationManifest(path);
  if (!m) {
    throw opError('not_found', 'No engine graduation is recorded on this machine, so there is no retained PGLite copy to discard.',
      'Nothing to delete; `gbrain doctor` reports any PGLite store an older migration left behind.',
      { why: '--discard-source acts on the run recorded in the graduation manifest.', docs: DOCS,
        fix: { argv: ['gbrain', 'doctor', '--only', 'pglite_leftovers', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Lists the PGLite stores left on this computer.' } });
  }
  if (m.state === 'rolled_back' || m.state === 'abandoned') {
    const why = `Graduation run ${m.runId} was ${m.state === 'rolled_back' ? 'rolled back' : 'abandoned'}, so ${m.source.dataDir} is the live PGLite brain, not a retained copy.`;
    throw opError('not_found', `${why} Nothing was deleted.`, 'Nothing to delete; the brain runs on PGLite.',
      { why, docs: DOCS, fix: { consent: [], actor: 'agent', requires_exclusive: false, verify: STATUS_VERIFY, why } });
  }
  if (m.state !== 'graduated') throw existingRunError(m);
  return m;
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function localConflict(path: string, what: string): OperationError {
  const why = `${path} ${what}. --discard-source deletes only what the graduation run left there, so it refuses rather than guess.`;
  return opError('local_conflict', `${path} ${what}; nothing was deleted.`,
    'Ask the user what is at that path (fix); do not remove it for them.',
    { why, docs: DOCS, fix: { consent: [], actor: 'user', requires_exclusive: false, verify: STATUS_VERIFY, why,
      user_message: `gbrain found something unexpected at ${path} while cleaning up after the move to Postgres, so it deleted nothing. Do you know what it is?` } });
}

/** What the run left on this computer, retained copy first; anything else at those paths refuses. */
function leftovers(m: GraduationManifest): DiscardPath[] {
  const dataDir = m.source.dataDir;
  const out: DiscardPath[] = [];
  // A discard stopped mid-delete leaves the renamed copy; it is removed first so the intact copy can take its name.
  for (const path of [discardingPath(dataDir, m.runId), graduatedPath(dataDir, m.runId)]) {
    const st = lstatOrNull(path);
    if (!st) continue;
    if (!st.isDirectory()) throw localConflict(path, 'is not the directory graduation moved the brain to');
    const size = measureDirSize(path);
    out.push({ kind: 'retained_copy', path, bytes: size.bytes, sizeIncomplete: size.incomplete });
  }
  const old = lstatOrNull(dataDir);
  if (old) {
    if (readTombstone(dataDir)?.runId !== m.runId) throw localConflict(dataDir, `is not the tombstone of graduation run ${m.runId}`);
    out.push({ kind: 'tombstone', path: dataDir, bytes: old.size, sizeIncomplete: false });
  }
  let marker: ReturnType<typeof readIntentMarker>;
  try { marker = readIntentMarker(dataDir); } catch { throw localConflict(intentMarkerPath(dataDir), 'is not a readable graduation intent marker'); }
  if (marker) {
    if (marker.runId !== m.runId) throw localConflict(intentMarkerPath(dataDir), `belongs to graduation run ${marker.runId}, not ${m.runId}`);
    if (!TERMINAL_STATES.has(marker.state)) throw existingRunError({ ...m, state: marker.state });
    out.push({ kind: 'intent_marker', path: intentMarkerPath(dataDir), bytes: lstatSync(intentMarkerPath(dataDir)).size, sizeIncomplete: false });
  }
  return out;
}

function unconfirmed(m: GraduationManifest, detail: string): OperationError {
  const why = 'The retained copy is the only other copy of this brain, so it is deleted only after the target confirms, in a read-only session, that it is authoritative for this run.';
  return opError('database_error', `The Postgres brain at ${m.routes.main} ${detail}, so it is not confirmed as this brain's authoritative copy; nothing was deleted.`,
    'Check the target (fix), then run the command again; keep the retained copy until it confirms.',
    { why, docs: DOCS, fix: { argv: statusArgv(), consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows whether the target is reachable and its graduation state.' } });
}

/** Read-only: the target must hold this run's row in state `authoritative`. */
async function confirmAuthoritative(m: GraduationManifest, opts: DiscardOptions): Promise<void> {
  const connect = opts.deps?.connectTargets ?? defaultGraduationDeps().connectTargets;
  if (!m.targetUrls) throw unconfirmed(m, 'has no URL recorded in the graduation manifest');
  let row: Awaited<ReturnType<typeof readGraduationRow>>;
  try {
    const targets = await connect({ ...m.routes, mainUrl: m.targetUrls.main, ddlUrl: m.targetUrls.ddl });
    try { row = await targets.main.transaction(async tx => { await tx.executeRaw('SET TRANSACTION READ ONLY'); return readGraduationRow(tx); }); }
    finally { await targets.close(); }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    const code = (error as { code?: unknown }).code;
    throw unconfirmed(m, `could not be reached${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  if (row?.role === 'target' && row.run_id === m.runId) {
    if (row.state === 'authoritative') return;
    if (ROLLBACK_ROW_STATES.has(row.state as TargetRowState)) throw inProgressError({ runId: m.runId, state: row.state, dataDir: m.source.dataDir });
  }
  throw unconfirmed(m, row ? `records graduation run ${row.run_id} as ${row.state}` : 'has no graduation record');
}

/**
 * The read-only discard plan: zero mutations on either side. Refuses unless
 * the recorded run is `graduated`, only its own files sit at its paths, and
 * (when anything is left to delete) the target confirms it is authoritative.
 */
export async function planDiscardSource(opts: DiscardOptions = {}): Promise<DiscardPlan> {
  const m = graduatedRun(opts.manifestPath ?? graduationManifestPath());
  const paths = leftovers(m);
  if (paths.length) await confirmAuthoritative(m, opts);
  return {
    planHash: planHashOf({ runId: m.runId, discard: paths.map(p => `${p.kind}:${p.path}`) }),
    runId: m.runId, dataDir: m.source.dataDir, target: m.routes.main, paths, sourceDiscardedAt: m.sourceDiscardedAt ?? null,
  };
}

function previewChanged(plan: DiscardPlan): OperationError {
  return opError('preview_changed', `What --discard-source deletes changed since the approved plan (now ${plan.planHash}); nothing was deleted.`,
    'Show the user the fresh plan (fix) and run the discard with its plan_hash after they agree.',
    { why: 'The approval binds the run and the exact paths it deletes.',
      fix: { argv: discardArgv(['--dry-run']), consent: [], actor: 'agent', requires_exclusive: false, plan_hash: plan.planHash,
        why: 'Shows the fresh read-only plan and its plan_hash.' } });
}

function removeEntry(entry: DiscardPath, m: GraduationManifest): void {
  const dataDir = m.source.dataDir;
  if (entry.kind === 'tombstone') { removeTombstone(dataDir, m.runId); return; }
  if (entry.kind === 'intent_marker') { removeIntentMarker(dataDir); return; }
  const doomed = discardingPath(dataDir, m.runId);
  if (entry.path !== doomed) { renameSync(entry.path, doomed); fsyncParent(doomed); }
  rmSync(doomed, { recursive: true, force: true });
}

/**
 * Delete the recorded run's retained copy, tombstone and intent marker
 * against the approved plan_hash, under the source's kernel lock.
 */
export async function discardSource(opts: DiscardOptions = {}): Promise<DiscardResult> {
  const path = opts.manifestPath ?? graduationManifestPath();
  const plan = await planDiscardSource(opts);
  if (!(opts.yes && opts.expectPlanHash)) {
    throw opError('confirmation_required', 'Deleting the retained PGLite copy needs the user\'s approval of the plan; nothing was deleted.',
      'Show the user the plan and run the command in fix after they agree.',
      { why: 'The copy is what a rollback to PGLite restores; it is deleted only against an approved plan_hash.',
        fix: { argv: discardArgv(['--yes', '--expect', plan.planHash]), consent: ['destructive'], actor: 'agent', requires_exclusive: true,
          plan_hash: plan.planHash, preview_argv: discardArgv(['--dry-run']), why: 'Deletes exactly what the plan lists.', verify: STATUS_VERIFY } });
  }
  if (opts.expectPlanHash !== plan.planHash) throw previewChanged(plan);
  if (!plan.paths.length) return { runId: plan.runId, target: plan.target, sourceDiscardedAt: plan.sourceDiscardedAt, deleted: [] };
  let lock: Awaited<ReturnType<typeof acquireKernelLockOnly>>;
  try {
    lock = await acquireKernelLockOnly(plan.dataDir, { lockDir: pgliteLockDirFor(plan.dataDir), timeoutMs: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof PgliteBusyError)) throw error;
    throw opError('lock_busy', `Another gbrain process holds ${plan.dataDir} (a rollback or resume of graduation run ${plan.runId}); nothing was deleted.`,
      'Wait for it to finish, then run the command again.',
      { why: 'Deleting the copy while a rollback or resume works on it could leave neither engine usable.',
        fix: { argv: statusArgv(), consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows what the run is doing.' } });
  }
  try {
    // Under the lock nothing can restore or reopen the copy: re-check exactly what the approval covered.
    const fresh = await planDiscardSource(opts);
    if (fresh.planHash !== opts.expectPlanHash) throw previewChanged(fresh);
    const m = readGraduationManifest(path)!;
    const now = new Date().toISOString();
    m.sourceDiscardedAt ??= now;
    m.updatedAt = now;
    writeGraduationManifest(m, path);
    for (const entry of fresh.paths) removeEntry(entry, m);
    fsyncParent(m.source.dataDir);
    return { runId: m.runId, target: fresh.target, sourceDiscardedAt: m.sourceDiscardedAt, deleted: fresh.paths };
  } finally { await releaseLock(lock); }
}
