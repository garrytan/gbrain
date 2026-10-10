/**
 * #6423: the step this process's managed-sync pass is in, process-local. A pass that admits nothing (a transaction-mode
 * pooler that never answers a pipelined waiver run) leaves no claim on any request for the drain's head probe to read, so
 * the in-pass governor in `sync-drain.ts` names this step and the last statement label on its `no_admission` stop.
 */
import { sqlLabel } from './claim-phase.ts';

export type DrainStep = 'freeze' | 'waiver_run' | 'admission' | 'await_receipt';
export interface DrainStepStamp { step: DrainStep; since: number; last_sql: { label: string; at: number } | null }

let current: DrainStepStamp | null = null;

/** Enters `step` and throws the pass's abort reason, so an abandoned pass admits and writes nothing more. */
export function stampDrainStep(step: DrainStep, signal?: AbortSignal, now = Date.now()): void {
  signal?.throwIfAborted();
  current = { step, since: now, last_sql: null };
}
/** Records the statement the current step is about to send (label only, never text or parameters). */
export function noteDrainSql(sql: string, now = Date.now()): void {
  if (current) current.last_sql = { label: sqlLabel(sql), at: now };
}
export function readDrainStep(): DrainStepStamp | null { return current; }
export function clearDrainStep(): void { current = null; }
