/**
 * #6817: the one mapping from an atom drain's stop to what its caller does
 * next, shared by `gbrain dream --drain` (exit code, JSON `status` /
 * `retryable` / `code`, the human last line) and the `extract-atoms-drain`
 * Minion handler (retry under backoff, or dead-letter).
 *
 *   drained, backlog counted empty            exit 0, status ok
 *   provider_failure, auth/billing/model/
 *     content block                           exit 1, not retryable (atom_drain_provider_failure)
 *   provider_failure, rate limit/transient    exit 11, retryable (atom_drain_provider_failure)
 *   no_progress with a counted backlog        exit 1, not retryable (atom_drain_no_progress)
 *   every other stop, or an unknown count     exit 11, retryable (atom_drain_incomplete)
 *
 * Exit codes and retryability come from the error registry entries, so this
 * table and `gbrain errors <code>` cannot disagree. Type-only import of the
 * drain module: dream.ts loads this next to a drain helper tests replace.
 */
import { codeRetryable, exitCodeForCode } from '../error-catalogue.ts';
import type { ExtractAtomsDrainResult } from './extract-atoms-drain.ts';

export type DrainOutcomeCode = 'atom_drain_incomplete' | 'atom_drain_provider_failure' | 'atom_drain_no_progress';

export interface DrainOutcome {
  /** Never `ok` for a stop that left work behind. */
  status: 'ok' | 'incomplete' | 'provider_failure';
  exit: number;
  retryable: boolean;
  code?: DrainOutcomeCode;
  reason?: string;
}

type OutcomeInput = Pick<ExtractAtomsDrainResult, 'status' | 'stopped' | 'remaining' | 'provider_failure_class'>;

export function drainOutcome(result: OutcomeInput): DrainOutcome {
  if (result.stopped === 'drained' && result.remaining === 0) return { status: 'ok', exit: 0, retryable: false };
  if (result.status === 'provider_failure') return classified('provider_failure', 'atom_drain_provider_failure', result.provider_failure_class ?? 'transient');
  if (result.remaining === null) return classified('incomplete', 'atom_drain_incomplete', 'count_unavailable');
  if (result.stopped === 'no_progress') return classified('incomplete', 'atom_drain_no_progress');
  return classified('incomplete', 'atom_drain_incomplete', result.stopped);
}

function classified(status: DrainOutcome['status'], code: DrainOutcomeCode, reason?: string): DrainOutcome {
  return { status, exit: exitCodeForCode(code, reason), retryable: codeRetryable(code, reason), code, ...(reason ? { reason } : {}) };
}
