/**
 * #6803: an absolute statement deadline carried by the async context, and the
 * engine wrapper that honours it.
 *
 * `withStatementDeadline(scope, run)` runs `run` with `scope` as the current
 * deadline; every continuation of `run` keeps it, so work that outlives its
 * caller (a check whose result the doctor runner already dropped) still stops
 * at its own deadline instead of borrowing the next caller's.
 * `deadlineBoundEngine(engine)` returns one stable wrapper per real engine
 * that reads the current scope on every call:
 *
 *   - past the deadline, a statement (and any other engine method) is not
 *     sent: it throws `StatementDeadlineError` and marks the scope `expired`;
 *   - on Postgres a raw statement carries the deadline to the server (a
 *     transaction-local statement_timeout recomputed after the pool wait, and
 *     an abort of the pool wait itself), and a statement cancelled at the
 *     deadline marks the scope `expired` even when the caller catches the
 *     error, so the caller's owner can still report the result as unknown;
 *   - PGLite has one in-process connection and no cancellation: it gets only
 *     the refusal before each statement, and a statement already running
 *     finishes.
 *
 * Without a scope (or with `deadlineAt: null`) the wrapper passes every call
 * through. Engine methods with their own SQL (e.g. `getStats`) get only the
 * refusal before the call. The wrapper exposes the engine it wraps under
 * `RAW_ENGINE`, and `engineCacheKey` maps either to the same object, so
 * engine-keyed caches keep one entry per real engine.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface StatementDeadline {
  startedAt: number;
  /** Absolute epoch ms; null: no deadline (the scope still carries `memo`). */
  deadlineAt: number | null;
  /** Set when a statement was refused or cancelled for this deadline. */
  expired: boolean;
  /** Values shared by every scope of one run (e.g. one doctor run's capacity forecast). */
  memo?: Map<string, Promise<unknown>>;
  /** The run's overall deadline, for work shared across the run's scopes; null: none. */
  runDeadlineAt?: number | null;
}

/** A statement that would start after its deadline. */
export class StatementDeadlineError extends Error {
  readonly code: string = 'statement_deadline';
  constructor(readonly elapsedMs: number, message = `The statement deadline passed after ${elapsedMs} ms.`) {
    super(message);
    this.name = 'StatementDeadlineError';
  }
}

export const RAW_ENGINE: unique symbol = Symbol.for('gbrain.engine.raw');

const wrappers = new WeakMap<object, object>();
/** wrapper -> the engine it wraps (looked up here, never through a property of the engine, which a stub may answer). */
const rawEngines = new WeakMap<object, object>();

/** The object an engine-keyed cache should use: the real engine behind a deadline wrapper. */
export function engineCacheKey<T extends object>(engine: T): object {
  return rawEngines.get(engine) ?? engine;
}

const scopes = new AsyncLocalStorage<StatementDeadline | undefined>();

export function withStatementDeadline<T>(scope: StatementDeadline | null, run: () => Promise<T>): Promise<T> {
  return scopes.run(scope ?? undefined, run);
}

export function currentStatementDeadline(): StatementDeadline | undefined {
  return scopes.getStore();
}

/** Whether an error is a deadline refusal, a statement the server cancelled (57014) or an aborted pool wait. */
export function deadlineFailure(error: unknown): boolean {
  return error instanceof StatementDeadlineError || cancelled(error);
}

function cancelled(error: unknown): boolean {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  return e?.code === '57014' || e?.name === 'AbortError' || /canceling statement|statement timeout/i.test(String(e?.message ?? ''));
}

function refuse(scope: StatementDeadline): never {
  scope.expired = true;
  throw new StatementDeadlineError(Date.now() - scope.startedAt);
}

type RawCall = (sql: string, params?: unknown[], opts?: Record<string, unknown> & { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown[]>;

export function deadlineBoundEngine<E extends object>(engine: E): E {
  const raw = engineCacheKey(engine) as E;
  const known = wrappers.get(raw);
  if (known) return known as E;
  const wrapper = new Proxy(raw, { get(target, key) {
    if (key === RAW_ENGINE) return target;
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: Parameters<RawCall>[2]) => {
      const scope = scopes.getStore();
      const call = (value as RawCall).bind(target);
      if (!scope || scope.deadlineAt === null) return call(sql, params, opts);
      const left = scope.deadlineAt - Date.now();
      if (left <= 0) refuse(scope);
      if ((target as { kind?: string }).kind !== 'postgres') return call(sql, params, opts);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
      try {
        return await call(sql, params, { ...opts, signal, timeoutMs: Math.min(left, opts?.timeoutMs ?? left), deadlineAt: scope.deadlineAt });
      } catch (error) {
        if (cancelled(error) && Date.now() >= scope.deadlineAt - 100) scope.expired = true;
        throw error;
      }
    };
    // A function proxy, not a bare wrapper: a function-valued property keeps its own properties (the Postgres sql getter keeps reserve).
    return new Proxy(value as (...a: unknown[]) => unknown, { apply(fn, _self, args) {
      const scope = scopes.getStore();
      if (scope && scope.deadlineAt !== null && Date.now() >= scope.deadlineAt) refuse(scope);
      return Reflect.apply(fn, target, args);
    } });
  } });
  wrappers.set(raw, wrapper);
  rawEngines.set(wrapper, raw);
  return wrapper;
}
