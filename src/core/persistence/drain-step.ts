/**
 * #6423: the step this process's managed-sync pass is in, process-local. A pass that admits nothing (a transaction-mode
 * pooler that never answers a pipelined waiver run) leaves no claim on any request for the drain's head probe to read, so
 * the in-pass governor in `sync-drain.ts` names this step and the last statement label on its `no_progress` stop, and a
 * pass it abandoned throws at its next step boundary. #6712 PR 2: the tail after a committed checkpoint (statistics, links)
 * runs after the lease is released (`sync-tail.ts`), so no step covers it.
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
const abandoned = new WeakSet<AbortSignal>();
/** #6706: marks a pass's signal abandoned even when another abort reason (the drain's deadline) landed on it first. */
export function markPassAbandoned(signal: AbortSignal): void { abandoned.add(signal); }
export function stampDrainStep(step: DrainStep, signal?: AbortSignal, now = Date.now()): void {
  if (signal?.aborted && signal.reason instanceof DrainPassAbandoned) throw signal.reason;
  if (signal && abandoned.has(signal)) throw new DrainPassAbandoned('pass abandoned');
  current = { step, since: now, last_sql: null };
}
/** Records the statement the current step is about to send (label only, never text or parameters). */
export function noteDrainSql(sql: string, now = Date.now()): void {
  if (current) current.last_sql = { label: sqlLabel(sql), at: now };
}
export function readDrainStep(): DrainStepStamp | null { return current; }
export function clearDrainStep(): void { current = null; }
