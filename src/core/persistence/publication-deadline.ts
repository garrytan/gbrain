/**
 * #6288 part 1 / #6352 (P2.3, UC2): a publish that neither resolves nor rejects used to hold its claim, its root and its
 * locks forever while the lease kept renewing. What bounds it now:
 *
 * - On Postgres the publish transaction itself is the real bound. `declareDurablePersistence` already sets a
 *   transaction-local `statement_timeout` (5 s) and `lock_timeout`; `bindPublicationTimeouts` adds a transaction-local
 *   `idle_in_transaction_session_timeout` of the publication ceiling, so a publisher stuck between statements with the
 *   transaction open is ended by the server (its connection is terminated and nothing it did can commit). Both are
 *   transaction-scoped, so they hold behind a transaction pooler that drops startup parameters.
 * - `boundPublication` never settles before the publish does, so nothing releases or reports a request or group while
 *   its transaction can still commit. At the ceiling it marks the publication overdue (the claim stamp reads
 *   `waiting_on: publication_deadline`); a grace later it aborts the publication's signal, passed to `transaction(fn, { signal })`:
 *   on Postgres that discards the transaction's connection and the publish rejects with an AbortError (nothing commits);
 *   if the publish still has not settled shortly after, the owner reports `restart_required`. The root stays held: restarting
 *   the owner process is the only honest recovery, never a promised reclaim.
 * - On PGLite a running transaction cannot be cancelled (the signal is checked only before BEGIN): the ceiling only marks
 *   the publication overdue and, past the grace, `restart_required`.
 *
 * The wave 9 yield between groups is outside any one `boundPublication` call, so it never counts against a group.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { gucMilliseconds, resolveSessionTimeouts } from '../db.ts';

export const PUBLICATION_CEILING_KEY = 'persistence.publication_ceiling_ms';
/** `persistence.publication_ceiling_ms`' default (60000 to 3600000 accepted). */
export const PUBLICATION_CEILING_DEFAULT_MS = 5 * 60_000;
/** After the ceiling: how long before the publication's signal is aborted, and how long after that before `restart_required`. */
export const PUBLICATION_GRACE_MS = 30_000;
export const PUBLICATION_SETTLE_MS = 5_000;
const CEILING_TTL_MS = 5_000;

let ceiling = { value: PUBLICATION_CEILING_DEFAULT_MS, at: 0 };
const signals = new AsyncLocalStorage<AbortSignal>();

/** The ceiling (cached for 5 s); anything missing or outside 60000..3600000 reads as the default. */
export async function readPublicationCeilingMs(engine: Pick<BrainEngine, 'getConfig'>): Promise<number> {
  if (Date.now() - ceiling.at < CEILING_TTL_MS) return ceiling.value;
  const n = Number((await engine.getConfig(PUBLICATION_CEILING_KEY).catch(() => null))?.trim());
  ceiling = { value: Number.isInteger(n) && n >= 60_000 && n <= 3_600_000 ? n : PUBLICATION_CEILING_DEFAULT_MS, at: Date.now() };
  return ceiling.value;
}

/** The idle-in-transaction bound a publish transaction gets: the ceiling, never above the pool's own session value. */
export function publicationIdleTimeoutMs(ceilingMs = ceiling.value): number {
  const session = gucMilliseconds(resolveSessionTimeouts().idle_in_transaction_session_timeout);
  return session !== null && session > 0 ? Math.min(ceilingMs, session) : ceilingMs;
}

/**
 * Sets the transaction-local idle bound. Callers await it (or send it first in their `pipelined` batch), so a refused SET
 * fails this publication's transaction with its own error. Skipped on PGLite: it would enforce the bound, and a
 * transaction it ends there wedges the engine's only connection.
 */
export async function bindPublicationTimeouts(tx: BrainEngine): Promise<void> {
  if (tx.kind !== 'postgres') return;
  await tx.executeRaw("SELECT set_config('idle_in_transaction_session_timeout',$1,true)", [`${publicationIdleTimeoutMs()}ms`]);
}

/**
 * `engine.transaction`, passing the current publication's signal on as `{ signal }`. An aborted transaction rejects
 * while its body may still be parked, so a rejection waits for the body to settle first: nothing (recovery included)
 * acts on the publication while the body can still rename a file.
 */
export async function publicationTransaction<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const signal = signals.getStore();
  if (!signal) return engine.transaction(fn);
  let body: Promise<unknown> = Promise.resolve();
  try {
    return await engine.transaction(tx => { const run = fn(tx); body = run; return run; }, { signal });
  } catch (error) {
    await body.then(() => undefined, () => undefined);
    const closed = (error as { cause?: { code?: unknown } })?.cause?.code;
    // The deadline discarded the connection: report it as the closed connection it is, which callers already retry.
    if (!signal.aborted || typeof closed !== 'string') throw error;
    throw Object.assign(new Error(`publication_deadline: the publish transaction passed the ceiling and its connection was discarded (${closed})`),
      { name: 'PublicationDeadlineError', code: closed, cause: error });
  }
}

export interface PublicationBound {
  ceilingMs: number;
  graceMs?: number;
  settleMs?: number;
  /** At the ceiling, with the publish still running. */
  onOverdue?(): void;
  /** Past the ceiling, the grace and the settle window: the owner must restart. `settled` resolves when the publish finally does. */
  onStuck?(settled: Promise<void>): void;
}

/** Runs `publish` under the ceiling; settles only with `publish`'s own outcome. */
export function boundPublication<T>(publish: () => Promise<T>, bound: PublicationBound): Promise<T> {
  const controller = new AbortController();
  const work = signals.run(controller.signal, publish);
  const settled = work.then(() => undefined, () => undefined);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); timer.unref?.(); timers.push(timer); };
  const grace = bound.graceMs ?? PUBLICATION_GRACE_MS, settle = bound.settleMs ?? PUBLICATION_SETTLE_MS;
  later(bound.ceilingMs, () => bound.onOverdue?.());
  later(bound.ceilingMs + grace, () => controller.abort(Object.assign(new Error('publication_deadline'), { code: 'publication_deadline' })));
  later(bound.ceilingMs + grace + settle, () => bound.onStuck?.(settled));
  void settled.then(() => { for (const timer of timers) clearTimeout(timer); });
  return work;
}
