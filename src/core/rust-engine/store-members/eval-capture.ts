/**
 * Eval capture members (BrainEngine logEvalCandidate, listEvalCandidates, deleteEvalCandidatesBefore,
 * logEvalCaptureFailure, listEvalCaptureFailures). The store keeps the `eval_candidates` and `eval_capture_failures`
 * rows (rust/docs/store/eval_capture.md); timestamps cross the binding as ISO strings and come back as `Date`s.
 */
import type { EvalCandidate, EvalCandidateInput, EvalCaptureFailure, EvalCaptureFailureReason } from '../../types.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** A `Date` argument as the ISO string the store reads; anything else is passed on for the store to judge. */
function isoArg(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The store keeps a `facts/<id>` slug while that fact row exists, as PGLite does (rust/docs/store/eval_capture.md). */
export const logEvalCandidate: StoreMember<[input: EvalCandidateInput], number> = (brain, input) =>
  storeCall({ member: 'logEvalCandidate' }, () => brain.logEvalCandidate({ ...input, embedding_column: input?.embedding_column ?? null }));

export const listEvalCandidates: StoreMember<[filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }], EvalCandidate[]> =
  async (brain, filter) => {
    // PGLite filters by tool only when it is truthy, and reads a null since as the epoch.
    const scope = {
      since: filter?.since == null ? undefined : isoArg(filter.since),
      limit: typeof filter?.limit === 'number' ? filter.limit : undefined,
      tool: filter?.tool || undefined,
    };
    const rows: EvalCandidate[] = await storeCall({ member: 'listEvalCandidates' }, () => brain.listEvalCandidates(scope));
    return rows.map((row) => withDates(row, ['created_at', 'as_of_ts']));
  };

export const deleteEvalCandidatesBefore: StoreMember<[date: Date], number> = (brain, date) =>
  storeCall({ member: 'deleteEvalCandidatesBefore' }, () => brain.deleteEvalCandidatesBefore(isoArg(date)));

export const logEvalCaptureFailure: StoreMember<[reason: EvalCaptureFailureReason], void> = async (brain, reason) => {
  await storeCall({ member: 'logEvalCaptureFailure' }, () => brain.logEvalCaptureFailure(reason ?? null));
};

export const listEvalCaptureFailures: StoreMember<[filter?: { since?: Date }], EvalCaptureFailure[]> = async (brain, filter) => {
  const scope = { since: filter?.since == null ? undefined : isoArg(filter.since) };
  const rows: EvalCaptureFailure[] = await storeCall({ member: 'listEvalCaptureFailures' }, () => brain.listEvalCaptureFailures(scope));
  return rows.map((row) => withDates(row, ['ts']));
};
