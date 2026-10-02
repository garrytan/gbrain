/**
 * `gbrain jobs cancel --select <filter>` (DX-T2, ENG-O5): bulk cancellation
 * of the live rows the claim gate blocks on (SQL NULL or unsupported
 * authority), preview-bound like `authorize-legacy --select`.
 *
 * The preview hashes the complete cancellation closure `cancelJobs` would
 * produce: the selected rows, and the parents that return from
 * waiting-children to waiting once their last open child is cancelled. A
 * selection whose closure would also cancel a descendant outside the
 * selected set refuses (E-T4), naming those ids. The apply recomputes the
 * closure under a table lock, refuses with `preview_changed` if its hash
 * moved, and cancels through `cancelJobs` in the same transaction.
 */
import type { BrainEngine } from '../engine.ts';
import { catalogueError } from '../error-catalogue.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { MinionQueue } from './queue.ts';
import { LIVE_JOB_STATUSES, parseSubmissionAuthority } from './submission-authority.ts';
import type { MinionJobStatus } from './types.ts';
import {
  assertNoActiveJobs, formatSelection, selectCommand, selectedStatuses, summarizeSelection,
  type LegacyJobSelection, type SelectionSummary,
} from './legacy-selection.ts';

export const LEGACY_CANCEL_REASON = 'legacy_review: cancelled by gbrain jobs cancel --select';

interface ClosureRow { id: number; name: string; status: string; parent_job_id: number | null; updated_at: unknown; submission_authority: unknown; legacy_authority_is_null: boolean }

async function cancelClosure(engine: BrainEngine, selection: LegacyJobSelection) {
  const previewCommand = selectCommand('cancel', selection);
  await assertNoActiveJobs(engine, previewCommand);
  const candidates = await engine.executeRaw<ClosureRow>(
    `SELECT id, name, status, parent_job_id, updated_at, submission_authority, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs
      WHERE status = ANY($1::text[]) AND (cardinality($2::text[]) = 0 OR name = ANY($2::text[]))
        AND submission_authority IS DISTINCT FROM '{"version":1,"kind":"application"}'::jsonb
      ORDER BY id`, [selectedStatuses('cancel', selection), selection.names]);
  const rows = candidates.filter(row => !parseSubmissionAuthority(row.submission_authority));
  const ids = rows.map(row => Number(row.id));
  // The same recursion cancelJobs runs: every live descendant of a selected root.
  const outside = ids.length ? await engine.executeRaw<{ id: number }>(
    `WITH RECURSIVE descendants AS (
       SELECT id, 0 AS d FROM minion_jobs WHERE id = ANY($1::int[])
       UNION ALL
       SELECT m.id, descendants.d + 1 FROM minion_jobs m JOIN descendants ON m.parent_job_id = descendants.id WHERE descendants.d < 100
     ) SELECT DISTINCT j.id FROM minion_jobs j
        WHERE j.id IN (SELECT id FROM descendants) AND NOT (j.id = ANY($1::int[]))
          AND j.status = ANY($2::text[])
        ORDER BY j.id`, [ids, [...LIVE_JOB_STATUSES]]) : [];
  if (outside.length) {
    const named = outside.slice(0, 10).map(row => Number(row.id));
    throw catalogueError('legacy_job_selection_invalid',
      `Cancelling the selection would also cancel ${outside.length} descendant job(s) outside it: ${named.join(', ')}${outside.length > 10 ? ' …' : ''}.`,
      `Cancel them on purpose first (${named.map(id => `gbrain jobs cancel ${id}`).join('; ')}) or widen the filter to select them, then re-run ${previewCommand}.`);
  }
  const parents = [...new Set(rows.map(row => row.parent_job_id).filter((id): id is number => id != null && !ids.includes(Number(id))))];
  const transitions = parents.length ? await engine.executeRaw<{ id: number }>(
    `SELECT p.id FROM minion_jobs p
      WHERE p.id = ANY($1::int[]) AND p.status = 'waiting-children'
        AND NOT EXISTS (SELECT 1 FROM minion_jobs c WHERE c.parent_job_id = p.id
                          AND c.status NOT IN ('completed','failed','dead','cancelled') AND NOT (c.id = ANY($2::int[])))
      ORDER BY p.id`, [parents, ids]) : [];
  const parent_transitions = transitions.map(row => ({ id: Number(row.id), from: 'waiting-children', to: 'waiting' }));
  const hash = previewHash({ preview_version: 1, command: 'jobs-cancel', selection: formatSelection(selection), rows, parent_transitions });
  return { previewCommand, rows, ids, parent_transitions, hash };
}

export interface LegacyCancelPreview {
  selection: string;
  preview_command: string;
  summary: SelectionSummary;
  /** Selected rows whose non-NULL authority is unsupported (also cancelled). */
  unsupported_ids: number[];
  parent_transitions: Array<{ id: number; from: string; to: string }>;
  preview_hash: string | null;
  apply_command: string | null;
  rows: ClosureRow[];
  applied: false;
}

interface ApprovedCancel { selection: string; ids: number[] }

/** Preview: lists and hashes the closure, saves the exact id set under that hash. Changes no job. */
export async function previewLegacyCancel(engine: BrainEngine, selection: LegacyJobSelection): Promise<LegacyCancelPreview> {
  const closure = await cancelClosure(engine, selection);
  const base = {
    selection: formatSelection(selection), preview_command: closure.previewCommand, summary: summarizeSelection(closure.rows),
    unsupported_ids: closure.rows.filter(row => row.legacy_authority_is_null !== true).map(row => Number(row.id)),
    parent_transitions: closure.parent_transitions, rows: closure.rows, applied: false as const,
  };
  if (!closure.ids.length) return { ...base, preview_hash: null, apply_command: null };
  await saveApprovedSet<ApprovedCancel>(engine, { command: 'jobs-cancel', hash: closure.hash }, [{ selection: base.selection, ids: closure.ids }]);
  return { ...base, preview_hash: closure.hash, apply_command: selectCommand('cancel', selection, closure.hash) };
}

/** Apply: cancels exactly the previewed closure through cancelJobs in one transaction, or refuses whole. */
export async function applyLegacyCancel(engine: BrainEngine, selection: LegacyJobSelection, expected: string | undefined, yes: boolean) {
  const previewCommand = selectCommand('cancel', selection);
  if (!yes || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw catalogueError('legacy_job_selection_invalid', 'Apply requires BOTH --expect <preview hash> and --yes.',
      expected && /^[a-f0-9]{64}$/.test(expected) ? selectCommand('cancel', selection, expected) : `Preview first: ${previewCommand}`);
  }
  const approved = await loadApprovedSet<ApprovedCancel>(engine, { command: 'jobs-cancel', hash: expected, previewCommand });
  const [item] = approved.items;
  if (!item || item.selection !== formatSelection(selection) || !item.ids.length) throw previewChangedError(expected, previewCommand);
  return engine.transaction(async tx => {
    await tx.executeRaw('LOCK TABLE minion_jobs IN SHARE ROW EXCLUSIVE MODE');
    const closure = await cancelClosure(tx, selection);
    if (closure.hash !== expected || previewHash(closure.ids) !== previewHash(item.ids)) throw previewChangedError(expected, previewCommand);
    const cancelled = await new MinionQueue(tx).cancelJobs(closure.ids, { reason: LEGACY_CANCEL_REASON, rootStatuses: selectedStatuses('cancel', selection) as MinionJobStatus[] });
    if (cancelled.length !== closure.ids.length) throw previewChangedError(expected, previewCommand);
    await clearApprovedSet(tx, { command: 'jobs-cancel', hash: expected });
    return { selection: item.selection, cancelled_ids: closure.ids, parent_transitions: closure.parent_transitions, applied: true as const };
  });
}
