/**
 * #6423: the step this process's managed-sync pass is in, process-local. A pass that admits nothing (a transaction-mode
 * pooler that never answers a pipelined waiver run) leaves no claim on any request for the drain's head probe to read, so
 * the in-pass governor in `sync-drain.ts` names this step and the last statement label on its `no_admission` stop.
 */
import { sqlLabel } from './claim-phase.ts';

export type DrainStep = 'freeze' | 'waiver_run' | 'admission' | 'await_receipt';
export interface DrainStepStamp { step: DrainStep; since: number; last_sql: { label: string; at: number } | null }

let current: DrainStepStamp | null = null;

/** The reason the in-pass governor aborts the pass it abandons. */
export class DrainPassAbandoned extends Error {}

/**
 * Enters `step`; a pass the governor abandoned throws here, so it admits and writes nothing more. The caller's own
 * cancellation is not thrown here: the pass's existing cancel handling still banks work it already admitted.
 */
export function stampDrainStep(step: DrainStep, signal?: AbortSignal, now = Date.now()): void {
  if (signal?.aborted && signal.reason instanceof DrainPassAbandoned) throw signal.reason;
  current = { step, since: now, last_sql: null };
}
/** Records the statement the current step is about to send (label only, never text or parameters). */
export function noteDrainSql(sql: string, now = Date.now()): void {
  if (current) current.last_sql = { label: sqlLabel(sql), at: now };
}
export function readDrainStep(): DrainStepStamp | null { return current; }
export function clearDrainStep(): void { current = null; }
