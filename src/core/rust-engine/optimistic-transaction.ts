/**
 * Optimistic explicit transactions on the Rust engine (multi-user mode, rust-engine/multiuser-switch.ts; design
 * docs/designs/rust-engine/multi-user-server.md, interface I-1). Off, RustEngine._openTransaction never calls this.
 *
 * Each attempt opens its own transaction on its own one-thread executor (a single-flight wait blocks that thread, and
 * a shared thread would block the key holder's own calls), runs the callback on a transaction-bound clone, and commits.
 * There is no writer gate: transactions on different keys run at once. A commit the store refuses with
 * `write_conflict` (anything the transaction read changed after its snapshot, or the store doomed it on an earlier
 * conflict) keeps nothing, and the callback runs again from a fresh snapshot, at most OPTIMISTIC_TRANSACTION_RETRIES
 * more times; then the call ends `revision_conflict` with reason `transaction_contention`.
 *
 * Deadline: one absolute `deadlineAt` (the call's own deadline, else now + GBRAIN_RUST_TXN_DEADLINE_MS, else none),
 * never reset by a retry. While the callback runs, a timer races it: when it fires first, the attempt is closed (its
 * scope ends, so a late call of the callback is refused and cannot commit), rolled back, and the call ends `timeout`
 * reason `transaction_deadline`. Once the callback has resolved the timer is disarmed before the commit is sent; the
 * store makes the last deadline check when the commit runs, and its answer is the result.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionOptions } from '../engine.ts';
import type { CommitPosition } from '../engine-members/commit-log.ts';
import { opError } from '../ops/contract.ts';
import { transactionAborted } from '../postgres-engine/transaction-abort.ts';
import type { RustEngine, RustTransactionScope } from '../rust-engine.ts';
import { callDeadline } from './owner-ipc/client.ts';
import { mapStoreError, storeErrorCode } from './store-errors.ts';
import type { StoreBrain } from './store.ts';

/** What an optimistic engine keeps about its open attempts (`disconnect` ends them). */
export interface OptimisticTransactions {
  /** Each open attempt's scope and the promise that settles when it has fully ended. */
  readonly open: Map<RustTransactionScope, Promise<void>>;
}

interface Executor { Pool: new (threads: number) => { shutdown(waitMs: number): Promise<unknown> }; Brain: new (pool: unknown) => StoreBrain }

type Attempt<T> = { kind: 'done'; value: T } | { kind: 'conflict'; error: unknown };

/**
 * What a rerun of one transaction keeps from the runs before it: the keys they lost on (a rerun queues for them first)
 * and the first run's single-flight age (a rerun keeps its place, wait-die). In process the retry loop below keeps it;
 * a transaction over the wire is run again by its client from a fresh server transaction, so the brain server carries
 * it from the lost run to the client's rerun (served/session-calls.ts) through `withTransactionRerun`.
 */
export interface TransactionRerun { readonly keys: Set<string>; readonly age: { value?: number }; claimed?: boolean }

export function newTransactionRerun(): TransactionRerun { return { keys: new Set(), age: {} }; }

const carriedRerun = new AsyncLocalStorage<TransactionRerun>();

/**
 * Runs `fn` so the first optimistic transaction it opens starts from `rerun` and records its own runs into it. Only
 * that one transaction claims it; a transaction the callback opens later starts fresh.
 */
export function withTransactionRerun<T>(rerun: TransactionRerun, fn: () => T): T {
  return carriedRerun.run(rerun, fn);
}

/**
 * Records the key a call inside a transaction lost on (`write_conflict`) into `rerun`, as a lost commit's key is
 * recorded below. True when `error` is a lost conflict: the caller's rerun then keeps its place in line.
 */
export function noteLostConflict(rerun: TransactionRerun, error: unknown): boolean {
  if (!isConflict(error)) return false;
  const lost = conflictHex(error);
  if (lost) rerun.keys.add(lost);
  return true;
}

/** The rerun state the first optimistic transaction inside `withTransactionRerun` starts from; any other starts fresh. */
export function claimTransactionRerun(): TransactionRerun {
  const carried = carriedRerun.getStore();
  if (carried === undefined || carried.claimed) return newTransactionRerun();
  carried.claimed = true;
  return carried;
}

/** How many more times an optimistic transaction's callback runs after a lost commit (interface I-1). */
export const OPTIMISTIC_TRANSACTION_RETRIES = 8;

/**
 * `GBRAIN_RUST_TXN_DEADLINE_MS` (a multi-user sub-switch, read only on this path, which runs only in multi-user mode) as
 * a positive number of milliseconds: the deadline of an explicit transaction whose call has none of its own.
 */
export function rustTransactionDeadlineMs(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = env.GBRAIN_RUST_TXN_DEADLINE_MS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Waits for a cleanup step (rollback, close, executor shutdown) and drops its failure: the attempt already has its
 * answer, and a cleanup that fails leaves nothing the caller could act on.
 */
async function settle(step: Promise<unknown>): Promise<void> {
  await step.catch(() => undefined); // silent-read-ok: cleanup of an ended attempt, not a read
}

/** How long an attempt's executor waits for its last call when the attempt ends (milliseconds). */
const EXECUTOR_SHUTDOWN_WAIT_MS = 5_000;

/** The absolute deadline of a transaction that starts now, or undefined for none. */
export function transactionDeadlineAt(): number | undefined {
  const own = callDeadline().deadlineAt;
  if (own !== undefined) return own;
  const ms = rustTransactionDeadlineMs();
  return ms === undefined ? undefined : Date.now() + ms;
}

function deadlineError(member: string): Error {
  return opError('timeout', `${member} ran past its transaction deadline, so nothing was committed (ids it took may be skipped).`,
    'Retry the call; if it keeps timing out, give it a longer deadline or retry when fewer writers use the same pages.',
    { reason: 'transaction_deadline', detail: `member=${member} written=nothing` }) as Error;
}

/** The full key (hex) a store `write_conflict` names, or null (a single-flight refusal names a page key instead). */
function conflictHex(error: unknown): string | null {
  return /write conflict on key ([0-9a-f]+)$/.exec(error instanceof Error ? error.message : '')?.[1] ?? null;
}

/** The key a store `write_conflict` names (hex), cut to a readable length, or null. */
function conflictKey(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  const hex = /write conflict on key ([0-9a-f]+)/.exec(message)?.[1];
  if (hex) return hex.slice(0, 64);
  const flight = /single-flight key (\S+?):/.exec(message)?.[1];
  return flight ?? null;
}

function contentionExhausted(attempts: number, last: unknown): Error {
  const key = conflictKey(last);
  return opError('revision_conflict',
    `The transaction lost to concurrent writers ${attempts} times in a row, so nothing it wrote was kept.`,
    'Retry the call later; if it keeps failing, fewer writers on the same pages or settings at once will let it through.',
    { reason: 'transaction_contention', detail: `member=transaction attempts=${attempts} written=nothing${key ? ` last_conflict_key=${key}` : ''}`, retryable: true }) as Error;
}

/** True for a store failure (the disk or the records), mapped or not: never run again. */
function isStoreFailure(error: unknown): boolean {
  const code = storeErrorCode(error);
  return code === 'store_io' || code === 'store_corrupt' || code === 'rust_store_unreadable';
}

/** True when `error` (thrown out of the callback or the commit) is a lost conflict. */
function isConflict(error: unknown): boolean {
  return storeErrorCode(error) === 'write_conflict';
}

/** Runs `work` against `deadlineAt`: past it, `onTimeout` runs and the promise rejects with `deadlineError`. */
function raceDeadline<T>(work: Promise<T>, deadlineAt: number | undefined, onTimeout: () => void): Promise<T> {
  if (deadlineAt === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(deadlineError('transaction'));
    }, Math.max(0, deadlineAt - Date.now()));
    work.then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * `engine.transaction(fn)` in multi-user mode. `run` is the callback wrapper RustEngine passes (it binds the clone);
 * `context` is the engine's re-entry context.
 */
export async function runOptimisticTransaction<T>(
  engine: RustEngine,
  state: OptimisticTransactions,
  context: AsyncLocalStorage<RustTransactionScope[]>,
  opts: TransactionOptions | undefined,
  run: (scope: RustTransactionScope) => Promise<T>,
): Promise<T> {
  const signal = opts?.signal;
  if (signal?.aborted) throw transactionAborted(signal);
  const deadlineAt = transactionDeadlineAt();
  // The keys earlier runs lost on (a rerun queues for them first, as a retried Store::write does) and the first run's
  // single-flight age (a rerun keeps it, so it becomes the oldest and gets through, wait-die); carried in from a lost
  // run over the wire when the brain server runs a client's rerun.
  const { keys: retryKeys, age } = claimTransactionRerun();
  for (let attempt = 1; ; attempt++) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw deadlineError('transaction');
    const outcome = await runAttempt(engine, state, context, opts, deadlineAt, { keys: [...retryKeys].sort(), age }, run);
    if (outcome.kind === 'done') return outcome.value;
    const lost = conflictHex(outcome.error);
    if (lost) retryKeys.add(lost);
    if (attempt > OPTIMISTIC_TRANSACTION_RETRIES) throw contentionExhausted(attempt, outcome.error);
    if (signal?.aborted) throw transactionAborted(signal);
  }
}

async function runAttempt<T>(
  engine: RustEngine,
  state: OptimisticTransactions,
  context: AsyncLocalStorage<RustTransactionScope[]>,
  opts: TransactionOptions | undefined,
  deadlineAt: number | undefined,
  rerun: { keys: string[]; age: { value?: number } },
  run: (scope: RustTransactionScope) => Promise<T>,
): Promise<Attempt<T>> {
  const rootBrain = (await engine.storeFor('transaction')).brain;
  const { Pool, Brain } = engine.addon as unknown as Executor;
  const pool = new Pool(1);
  const brain = new Brain(pool);
  const scope: RustTransactionScope = { root: engine, brain, live: true, ended: false, settings: new Map() };
  let finished!: () => void;
  state.open.set(scope, new Promise<void>((resolve) => { finished = resolve; }));
  try {
    try {
      await brain.beginTransaction(rootBrain, opts?.readOnly === true, {
        mode: 'optimistic', ...(deadlineAt !== undefined ? { deadlineAtMs: deadlineAt } : {}),
        ...(rerun.keys.length ? { retryKeys: rerun.keys } : {}),
        ...(rerun.age.value !== undefined ? { age: rerun.age.value } : {}),
      });
      rerun.age.value ??= await brain.transactionAge() as number;
    } catch (error) {
      throw mapStoreError(error, { member: 'transaction' });
    }
    let value: T;
    try {
      const work = context.run([scope, ...(context.getStore() ?? [])], () => run(scope));
      // A callback still running after the deadline closed its attempt fails on its own; nothing waits for it.
      work.catch(() => undefined); // silent-read-ok: the caller gets this attempt's answer from the race below
      value = await raceDeadline(work, deadlineAt, () => { scope.live = false; scope.ended = true; });
    } catch (error) {
      scope.live = false;
      // A store failure is never a conflict to run again, even when the transaction was doomed before it.
      const conflicted = isConflict(error) || (!scope.ended && !isStoreFailure(error)
        // silent-read-ok: a failed probe means "not known to be a conflict"; the callback's own error is rethrown
        && await (brain.transactionConflicted() as Promise<boolean>).catch(() => false));
      // A rollback that fails (its ids could not be written forward) ends the call with that failure.
      try { await brain.rollbackTransaction(); } catch (rollback) { if (conflicted) throw mapStoreError(rollback, { member: 'transaction' }); }
      if (conflicted) return { kind: 'conflict', error };
      throw error;
    }
    scope.live = false;
    if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'transaction' });
    try {
      // The position it committed at, kept on its scope (`lastCommitPosition` on the transaction's engine).
      scope.committedAt = await brain.commitTransaction() as CommitPosition;
    } catch (error) {
      await settle(brain.rollbackTransaction());
      if (isConflict(error)) return { kind: 'conflict', error };
      throw mapStoreError(error, { member: 'transaction' });
    }
    return { kind: 'done', value };
  } finally {
    scope.live = false;
    // The settings end with the transaction, as SET LOCAL does.
    scope.settings.clear();
    await settle(brain.clearWriteTrust());
    await settle(brain.close());
    await settle(pool.shutdown(EXECUTOR_SHUTDOWN_WAIT_MS));
    state.open.delete(scope);
    finished();
  }
}

/** `disconnect`: waits up to `waitMs` for open attempts, then ends the rest (their later calls reject `engine_closed`). */
export async function endOptimisticTransactions(state: OptimisticTransactions, waitMs: number): Promise<void> {
  if (state.open.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), waitMs); });
  const outcome = await Promise.race([Promise.all([...state.open.values()]).then(() => 'done' as const), waited]);
  clearTimeout(timer);
  if (outcome === 'done') return;
  // Every attempt is ended and every rollback sent before any is awaited: an attempt waiting for a key another
  // holds runs its rollback only after the holder's rollback gives the key back.
  const scopes = [...state.open.keys()];
  for (const scope of scopes) { scope.ended = true; scope.live = false; }
  await Promise.all(scopes.map((scope) => settle(scope.brain.rollbackTransaction())));
  await Promise.all(scopes.map((scope) => settle(scope.brain.close())));
}

/** A store handle whose calls run under the caller's deadline (multi-user mode; `brain` itself when there is none). */
export function brainWithCallDeadline(brain: StoreBrain): StoreBrain {
  const deadlineAt = callDeadline().deadlineAt;
  return deadlineAt !== undefined && typeof brain.withDeadline === 'function' ? brain.withDeadline(deadlineAt) : brain;
}
