/**
 * #5984 lanes: several bulk groups of one draining managed sync publish at once.
 *
 * The drain opens a lane policy for its worktree (`openLanes`): the run's id,
 * the number of lanes it asked for and the number still in effect. While it
 * is open, this process's consumer claims the head of the next admitted group
 * of that run even when earlier groups of the same run are still publishing
 * (`claimNextLaneHead` in journal.ts), up to the effective number of lanes.
 * Lane publications share the worktree's native lock (worktree-lease.ts) and
 * begin their transactions in manifest order. They apply concurrently but
 * commit in manifest order: before a lane locks the counters it waits until
 * the group before it (its members' `intent.after`) has committed. A failed
 * earlier group cancels the later ones; a lock or statement timeout lowers
 * the effective number of lanes for the rest of the drain (step-down).
 * Other processes, and this one once the policy closes, claim lane rows
 * under the ordinary per-worktree FIFO.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';
import { leaseDraining, leaseWounded } from './worktree-lease.ts';

export interface LanePolicy { run: string; asked: number; effective: number; stepDown: string | null;
  /** Groups whose transaction began while the group before them was still publishing in this process. */
  overlapped: number;
  /** Lane groups that did not commit as a group (cancelled, released for the FIFO head, or published singly). */
  fallbacks: number }
export interface LaneState extends LanePolicy { coordinationPath: string | null; claimed: Set<string>; begun: Set<string>;
  /** Lane tasks this process runs for the run, from the head's claim until the task settles; `closing` stops new claims. */
  tasks: number; closing: boolean }
const policies = new Map<string, LaneState>();

/** The drain's lane policy for a worktree; replaces any earlier one. */
export function openLanes(worktreeId: string, run: string, lanes: number, coordinationPath: string | null): void {
  policies.set(worktreeId, { run, asked: lanes, effective: lanes, stepDown: null, overlapped: 0, fallbacks: 0, coordinationPath, claimed: new Set(), begun: new Set(), tasks: 0, closing: false });
}
/**
 * Ends a drain's lane run on every worktree it opened: no new lane claims, then waits (up to `maxMs`) for the
 * lane tasks already running to settle, so a drain never reports while one of its groups is still publishing
 * or aborting. Its unclaimed groups go back to the FIFO claim.
 */
export async function closeLaneRun(run: string, maxMs = 90_000): Promise<void> {
  const open = [...policies].filter(([, state]) => state.run === run);
  for (const [, state] of open) state.closing = true;
  const started = Date.now();
  while (open.some(([, state]) => state.tasks > 0) && Date.now() - started < maxMs) await sleep(20);
  for (const [worktreeId, state] of open) if (policies.get(worktreeId) === state) policies.delete(worktreeId);
}
/** Counts a lane task from its head's claim until it settles; returns the release. */
export function laneTask(state: LaneState): () => void {
  state.tasks++;
  let released = false;
  return () => { if (!released) { released = true; state.tasks--; } };
}
export function lanePolicy(worktreeId: string): LanePolicy | null {
  const state = policies.get(worktreeId);
  return state ? { run: state.run, asked: state.asked, effective: state.effective, stepDown: state.stepDown, overlapped: state.overlapped, fallbacks: state.fallbacks } : null;
}
/** The open lane runs and how many lanes each may run now (0 while the worktree's lease drains for an exclusive writer). */
export function laneRoots(): Array<{ worktreeId: string; run: string; capacity: number }> {
  return [...policies].map(([worktreeId, state]) => ({ worktreeId, run: state.run,
    capacity: state.closing || (state.coordinationPath && leaseDraining(state.coordinationPath)) ? 0 : state.effective }));
}
/** The lane run a request belongs to, when its worktree's lane policy is open in this process. */
export function laneOf(row: Pick<WriteRequest, 'worktree_id' | 'intent'>): LaneState | null {
  const lane = (row.intent as Record<string, unknown> | null | undefined)?.lane;
  const state = row.worktree_id ? policies.get(row.worktree_id) : undefined;
  return typeof lane === 'string' && state?.run === lane && state.effective > 1 ? state : null;
}
/** A lane lock or statement timeout that survived its retry: one lane fewer for the rest of the drain. */
export function stepDownLanes(worktreeId: string, reason: string): void {
  const state = policies.get(worktreeId);
  if (!state || state.effective <= 1) return;
  state.effective--;
  state.stepDown = reason;
}

/** The last member of a group is what the next group's `after` names. */
function groupKey(rows: WriteRequest[]): string { return rows.at(-1)!.request_id; }
export function laneClaimed(state: LaneState, rows: WriteRequest[]): void { state.claimed.add(groupKey(rows)); }
export function laneFinished(state: LaneState, rows: WriteRequest[]): void { state.claimed.delete(groupKey(rows)); state.begun.delete(groupKey(rows)); }

export class LaneAbort extends Error {
  constructor(readonly reason: 'predecessor_failed' | 'predecessor_requeued' | 'wounded' | 'order_timeout') { super(`lane ${reason}`); }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Lane transactions begin in manifest order: a group whose predecessor this
 * process claimed but has not begun waits for it, so the oldest unfinished
 * group always holds a connection first (transaction-mode poolers included).
 */
export async function awaitLaneBegin(state: LaneState, rows: WriteRequest[], maxMs = 10_000): Promise<void> {
  const after = predecessorOf(rows);
  const started = Date.now();
  while (after && state.claimed.has(after) && !state.begun.has(after) && Date.now() - started < maxMs) await sleep(20);
  if (after && state.claimed.has(after)) state.overlapped++;
  state.begun.add(groupKey(rows));
}

/**
 * Inside the group transaction, after its members are applied and before the
 * counters are locked: waits until the previous group committed. Each poll is
 * a fresh read of the predecessor's receipt. Throws LaneAbort when the
 * predecessor ended without committing or went back to the queue, when an
 * exclusive writer waits for the worktree's lease, or after `maxMs`.
 */
export async function awaitLaneTurn(tx: BrainEngine, state: LaneState, rows: WriteRequest[], maxMs = 60_000): Promise<void> {
  const after = predecessorOf(rows);
  if (!after) return;
  const head = rows[0]!;
  const started = Date.now();
  for (let poll = 0; ; poll++) {
    const [prior] = await tx.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
      [head.principal_kind, head.principal_id, after]);
    if (prior?.state === 'committed') return;
    if (prior && ['failed', 'conflict', 'cancelled'].includes(prior.state)) throw new LaneAbort('predecessor_failed');
    // A released (or not yet admitted) predecessor goes first: this lane gives its slot and claims back, rather than wait on it.
    if (!prior || prior.state === 'queued') throw new LaneAbort('predecessor_requeued');
    if (state.coordinationPath && leaseWounded(state.coordinationPath)) throw new LaneAbort('wounded');
    if (Date.now() - started >= maxMs) throw new LaneAbort('order_timeout');
    await sleep(Math.min(200, 25 * (poll + 1)));
  }
}

function predecessorOf(rows: WriteRequest[]): string | null {
  const after = (rows[0]?.intent as Record<string, unknown> | null | undefined)?.after;
  return typeof after === 'string' ? after : null;
}
