import type { BrainEngine } from '../engine.ts';
import { mirrorManagedSyncFailure, clearManagedSyncFailure } from '../sync-failure-ledger.ts';
import type { WriteRequest } from './model.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';
import { resolveManagedSyncContext, syncGit, syncGitPath } from './sync-discovery.ts';
import { pruneMirrorOnlyManagedFailures } from './managed-sync-orphans.ts';
import { publicFailureDetail } from './publication-failure.ts';
import { VERSION } from '../../version.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

export interface ManagedSyncFailure {
  source_id: string;
  source_incarnation: string;
  path: string;
  code: string;
  message: string;
  request_id: string | null;
  run_id: string;
  target: string | null;
  cursor_key: string;
  phase: 'discovery' | 'freeze' | 'admission' | 'receipt' | 'checkpoint' | 'resume';
  state: string;
  observation_id: string;
  first_seen: string;
  attempts: number;
  /**
   * GBRA-133 S-60: how many runs in a row stopped on this path with this code and message (1 on the first); a different
   * path, code or message starts over. Absent on failures recorded before it was kept.
   */
  repeats?: number;
  /** GBRA-133 S-60: the invocation that recorded it, so a resumed cursor's same observation still counts a new run. */
  invocation?: string;
  /** The cursor-selecting options of the failed run; absent on failures recorded before they were kept. */
  syncOptions?: SyncCursorOptions;
  processingOptions?: Partial<SyncProcessingOptions>;
  /** #6513: the receipt's public failure detail (`publicFailureDetail`: fixed identifiers and the closed `reason`), when the receipt stored one. */
  write_error_detail?: Record<string, unknown>;
  /**
   * #6643: the request whose failure this one is a knock-on of (or, for a checkpoint, the receipt that blocks it),
   * followed through recorded knock-on roots. `request_id` null with `unknown` true: the canceller recorded no root
   * (a receipt from before #6643); the victim is then the only request named.
   */
  root_cause?: ManagedSyncRootCause;
  /** #6712 PR 3 (L7): the gbrain version that recorded the failure; absent on failures recorded before it was kept. */
  gbrain_version?: string;
}
export interface ManagedSyncRootCause { request_id: string | null; slug: string | null; state: string | null; code: string | null; message: string | null;
  /** The cursor fence cause when the root is a cursor refusal (`outside_fence`, `run_replaced`, `window_dropped`). */
  cause?: string; unknown?: true }

export async function recordManagedSyncFailure(engine: BrainEngine, value: Omit<ManagedSyncFailure, 'first_seen' | 'attempts' | 'repeats'> & { first_seen?: string }): Promise<{ failure: ManagedSyncFailure; ledgerRecorded: boolean }> {
  const failure = { ...value, gbrain_version: VERSION, first_seen: value.first_seen ?? new Date().toISOString(), attempts: 1, repeats: 1 };
  const recorded = await engine.transaction(async tx => {
    await syncRows(tx, 'sync_commit_on');
    const [row] = await syncRows<{ completed_keys: [ManagedSyncFailure] }>(tx, 'failure_record', [value.cursor_key, JSON.stringify([failure])]);
    return row.completed_keys[0];
  });
  let ledgerRecorded = false;
  try {
    mirrorManagedSyncFailure({ ...recorded, message: formatManagedSyncFailure(recorded) });
    ledgerRecorded = true;
  } catch { }
  return { failure: recorded, ledgerRecorded };
}

export async function clearManagedSyncFailureAfterSuccess(engine: BrainEngine, key: string): Promise<void> {
  const removed = await syncRows(engine, 'failure_clear', [key]);
  if (removed.length) try { clearManagedSyncFailure(key); } catch { }
}

/** Where a successful managed sync of a source stands: its registered root, Git root and the commit it imported. */
export interface ManagedSyncImported { sourceId: string; incarnation: string; root: string; gitRoot: string; target: string }

/** The imported state of a managed source on its owner host; throws when this host does not own an active binding. */
export async function readManagedSyncImported(engine: BrainEngine, sourceId: string): Promise<ManagedSyncImported | null> {
  const context = await resolveManagedSyncContext(engine, { sourceId, noPull: true });
  const [source] = await syncRows<{ last_commit: string | null }>(engine, 'source_last_commit', [sourceId, context.incarnation]);
  if (!source?.last_commit) return null;
  return { sourceId, incarnation: context.incarnation, root: context.root, gitRoot: context.gitRoot, target: source.last_commit };
}

function blobAt(gitRoot: string, commit: string, path: string): string | null {
  try { return syncGit(gitRoot, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]).trim() || null; } catch { return null; }
}

/**
 * #6288: why a recorded managed failure is not settled by the imported state, or null when it is. The imported commit is
 * the source's last successful managed sync, which leaves every path it does not hold imported as of that commit; so a
 * failure is settled when its file exists there and the database holds a live page for it with no hold on the path, or
 * when the file is gone there and no live page claims it.
 */
export async function unsettledReason(engine: BrainEngine, run: ManagedSyncImported, failure: Pick<ManagedSyncFailure, 'source_id' | 'source_incarnation' | 'path'>): Promise<string | null> {
  if (failure.source_id !== run.sourceId || failure.source_incarnation !== run.incarnation) return 'source_changed';
  if (failure.path.startsWith('<')) return 'no_recorded_file';
  const gitPath = syncGitPath(run, failure.path);
  const present = blobAt(run.gitRoot, run.target, gitPath) !== null;
  const live = await engine.listLiveOriginPages(run.sourceId, [failure.path, gitPath]);
  if (!present) return live.length ? 'not_deleted' : null;
  if (!live.length) return 'not_imported';
  return await engine.readGitHoldRow(run.sourceId, run.incarnation, failure.path) ? 'held' : null;
}

async function deleteFailure(engine: BrainEngine, key: string, failure: ManagedSyncFailure): Promise<boolean> {
  const removed = await engine.deleteManagedSyncFailureObservation(key, failure.observation_id);
  if (removed) try { clearManagedSyncFailure(key); } catch { }
  return removed;
}

async function sourceFailureRows(engine: BrainEngine, sourceId: string): Promise<Array<{ key: string; failure: ManagedSyncFailure; unfinished: boolean }>> {
  return engine.listSourceManagedSyncFailures<ManagedSyncFailure>(sourceId);
}

/**
 * #6288: after a successful managed sync, clears this source's recorded failures under other cursor keys (a `--full` run's
 * key is never resumed by autopilot) whose cursor is finished or gone and whose file the imported commit already settles.
 * #6518: then prunes the source's local mirror rows whose durable failure row is already gone (`mirror_only`); a failed
 * durable read prunes nothing.
 */
export async function clearSettledManagedSyncFailures(engine: BrainEngine, run: ManagedSyncImported): Promise<number> {
  let cleared = 0;
  for (const row of await sourceFailureRows(engine, run.sourceId)) {
    if (row.unfinished || await unsettledReason(engine, run, row.failure)) continue;
    if (await deleteFailure(engine, row.key, row.failure)) cleared++;
  }
  await pruneMirrorOnlyManagedFailures(engine, run.sourceId);
  return cleared;
}

export interface ManagedFailureAcknowledgement { cleared: ManagedSyncFailure[]; refused: Array<{ failure: ManagedSyncFailure; reason: string }> }

/**
 * #6288: `gbrain sync --source <id> --acknowledge-managed <request_id|path>` (host CLI only). Removes the matching recorded
 * failures only when the imported state already settles them; anything else is refused by reason, so no content is skipped.
 */
export async function acknowledgeManagedSyncFailures(engine: BrainEngine, run: ManagedSyncImported, selector: string): Promise<ManagedFailureAcknowledgement> {
  const result: ManagedFailureAcknowledgement = { cleared: [], refused: [] };
  for (const row of await sourceFailureRows(engine, run.sourceId)) {
    if (row.failure.request_id !== selector && row.failure.path !== selector) continue;
    const reason = row.unfinished ? 'cursor_unfinished' : await unsettledReason(engine, run, row.failure);
    if (reason) result.refused.push({ failure: row.failure, reason });
    else if (await deleteFailure(engine, row.key, row.failure)) result.cleared.push(row.failure);
  }
  return result;
}

export async function readManagedSyncFailures(engine: BrainEngine, sourceIds?: string[]): Promise<ManagedSyncFailure[]> {
  const rows = await engine.readManagedSyncFailureRows<{ sourceId: string; incarnation: string; runId: string; index: number; target: string; pending?: { requestId: string };
      syncOptions: SyncCursorOptions | null; processingOptions: Partial<SyncProcessingOptions> | null },
    Pick<WriteRequest, 'state' | 'request_id' | 'error_code' | 'error_message' | 'error_detail'>, ManagedSyncFailure>(sourceIds ?? null);
  const failures: ManagedSyncFailure[] = rows.map(row => {
    const c = row.value, r = row.receipt;
    const options = { ...(c.syncOptions ? { syncOptions: c.syncOptions } : {}), ...(c.processingOptions ? { processingOptions: c.processingOptions } : {}) };
    // #6513: the pending receipt's bounded public detail rides the failure it belongs to (the row's own copy, when recorded, is the same projection).
    const detail = r?.error_detail ? publicFailureDetail(r.error_detail) : undefined;
    if (row.failure && (!r || !['failed', 'conflict', 'cancelled'].includes(r.state) || row.failure.request_id === r.request_id)) {
      return { ...options, ...(detail && row.failure.request_id === r?.request_id ? { write_error_detail: detail } : {}), ...row.failure };
    }
    return { ...options, ...(detail ? { write_error_detail: detail } : {}), source_id: c.sourceId, source_incarnation: c.incarnation, path: row.path ?? '<checkpoint>', code: r?.error_code ?? 'sync_incomplete',
      message: r?.error_message ?? 'The durable sync cursor is unfinished; resume the accepted run.', request_id: c.pending?.requestId ?? null,
      run_id: c.runId, target: c.target, cursor_key: row.cursor_key, phase: r ? 'receipt' : 'resume', state: r?.state ?? 'unfinished',
      observation_id: c.pending?.requestId ?? `${c.runId}:${c.index}`, first_seen: new Date(row.updated_at).toISOString(), attempts: 1 };
  });
  const orphaned = await engine.readOrphanedManagedSyncFailureRows<ManagedSyncFailure>(sourceIds ?? null);
  return [...failures, ...orphaned.map(row => row.failure)];
}

export function formatManagedSyncFailure(failure: ManagedSyncFailure): string {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
  return `source=${clean(failure.source_id)} path=${clean(failure.path)} code=${clean(failure.code)}: ${clean(failure.message)} request=${failure.request_id ?? '<not-admitted>'} run=${failure.run_id} target=${failure.target ?? '<undiscovered>'}${publicationDetailText(failure.write_error_detail)}${rootCauseText(failure.root_cause, clean)}`;
}
/** #6643: the root-cause clause of a failure line: the request, page and error that caused it, or that none was recorded. */
export function rootCauseText(root: ManagedSyncRootCause | undefined, clean: (value: string) => string = value => value): string {
  if (!root) return '';
  if (!root.request_id) return ' root_cause=<not recorded: this receipt predates root tracking>';
  return ` root_cause=request ${root.request_id}${root.slug ? ` (${clean(root.slug)})` : ''}: ${root.state ?? 'missing'}${root.code ? ` ${clean(root.code)}` : ''}${root.cause ? ` cause=${root.cause}` : ''}${root.message ? ` ${clean(root.message)}` : ''}`;
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/;
/** #6513: the fixed identifiers of a public failure detail (`raiser`, `table`) and its closed `reason`, as ` key=value` text; nothing else of it. */
export function publicationDetailText(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  return (['raiser', 'table', 'reason'] as const).map(key => typeof detail[key] === 'string' && IDENT.test(detail[key] as string) ? ` ${key}=${detail[key]}` : '').join('');
}

/** The retry for one managed failure: same source and recorded cursor-selecting options, or an honest note when they were not recorded. */
export function managedSyncRetryCommand(failure: ManagedSyncFailure, repoPath?: string | null): string {
  return checkpointRetryCommand({ sourceId: failure.source_id, processingOptions: failure.processingOptions, syncOptions: failure.syncOptions ?? null, repoPath });
}

export function syncFailureJsonFields(result: { failedFiles?: number; failureCodes?: Array<{ code: string; count: number }>; failures?: ManagedSyncFailure[]; runId?: string; fromCommit?: string | null; toCommit?: string; bankedFiles?: number }): Record<string, unknown> {
  return { ...(result.failedFiles !== undefined ? { failed_files: result.failedFiles } : {}),
    ...(result.failureCodes ? { failure_codes: result.failureCodes } : {}), ...(result.failures ? { failures: result.failures } : {}),
    ...(result.runId ? { run_id: result.runId, from_commit: result.fromCommit, target_commit: result.toCommit, banked_files: result.bankedFiles, counts_scope: 'run_cumulative' } : {}) };
}
