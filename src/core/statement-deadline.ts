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
 *     finishes;
 *   - on Postgres a typed read in BOUNDED_TYPED_READS (a member that replaced a
 *     statement the doctor bounded through `executeRaw`: the decide-store, timeline,
 *     notifier-coverage and writer-binding reads) runs under `withReadDeadline`, so the
 *     engine ends it at the deadline like a raw statement.
 *
 * Without a scope (or with `deadlineAt: null`) the wrapper passes every call
 * through. Other engine methods with their own SQL (e.g. `getStats`) get only the
 * refusal before the call. The wrapper exposes the engine it wraps under
 * `RAW_ENGINE`, and `engineCacheKey` maps either to the same object, so
 * engine-keyed caches keep one entry per real engine.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReadDeadlineError, withReadDeadline } from './read-deadline.ts';
import { DOCTOR_READ_MEMBERS } from './engine-sql/doctor-reads.ts';
import { DOCTOR_DERIVED_MEMBERS } from './engine-sql/doctor-derived.ts';
import { DOCTOR_PERSISTENCE_MEMBERS } from './engine-sql/doctor-persistence.ts';
import { DOCTOR_PAGES_MEMBERS } from './engine-sql/doctor-pages.ts';
import { DOCTOR_SEARCH_MEMBERS } from './engine-sql/doctor-search.ts';
import { DOCTOR_ACC_MEMBERS } from './engine-sql/doctor-acc-members.ts';
import { DOCTOR_JOIN_MEMBERS } from './engine-sql/doctor-join.ts';
import { DOCTOR_CHECKPOINT_MEMBERS } from './engine-sql/doctor-checkpoints.ts';
import { DOCTOR_TERMINAL_MEMBERS } from './engine-sql/doctor-terminal.ts';
import { DOCTOR_BRAIN_MEMBERS } from './engine-sql/doctor-brain.ts';
import { DOCTOR_SYNC_MEMBERS } from './engine-sql/doctor-sync.ts';
import { DOCTOR_FACTS_TRUST_MEMBERS } from './engine-sql/doctor-facts-trust.ts';
import { FENCE_CENSUS_MEMBERS } from './engine-sql/fence-census.ts';
import { DOCTOR_SRC_MEMBERS } from './engine-sql/doctor-sources.ts';

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

/** The write-journal reads (engine-sql/persistence-journal.ts, persistence-claims.ts, persistence-housekeeping.ts, persistence-admission.ts, config.ts) that replaced statements this wrapper bounded through executeRaw. */
const JOURNAL_TYPED_READS: ReadonlySet<string> = new Set(['readJournalLimitRows', 'readWriteRequest', 'readWriteRequestById', 'readWriteRequestProgress', 'countOutstandingBySource', 'hasDeferralRoom', 'readRefreshTiming', 'countHeldBehindImport', 'ownsSchemaTables', 'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential', 'readCounterRows', 'readAdmissionRate', 'readHeldPageRows', 'readHeldCoverageRows',
  'readSourceMembership', 'getConfigValues', 'readReceiptBudget', 'readCapacityForecastInputs', 'listHostConsumerRows', 'probeLiveConsumerRows']);
/**
 * Typed reads that replaced a statement a doctor entry sent through this wrapper's executeRaw, outside the doctor-*.ts
 * member lists: the embedding column check, the entity duplicate finder, the source lists, onboard coverage, derived
 * taint, managed generations, backup maturity, the trust backfill, and the sync hold and pass-row reads.
 */
const DOCTOR_PATH_TYPED_READS: readonly string[] = [
  'readChunkColumnTypes', 'countChunkColumnCoverage', 'listUnretiredPagesBySlugPattern', 'countDistinctInboundLinkers',
  'listNameVariantCandidates', 'readSoleSourceId', 'readFirstSourceId', 'listSourceIds', 'countDatedMeetingPages',
  'entityFeatureCoverage', 'countDerivedRowTaint', 'listPendingGenerationMembers', 'listGenerationOrphanCandidates',
  'readBrainMaturity', 'readOpCheckpointKeys', 'readGitHoldRecords', 'readLiveSyncPassRows',
];
/** The typed reads (engine-sql/decide-store.ts) that replaced statements this wrapper bounded through executeRaw: decide_health. */
export const BOUNDED_TYPED_READS: ReadonlySet<string> = new Set(['readDecideState', 'decideSlotUsage', 'dailyDecideSpend', 'listDecideResolvedModels', 'listDecideMixedModelDecisions', 'listDecideReceiptStats', 'listDecideCalibrations',
  'countSegmentedTimelinePages', 'listCoveredSources', 'listExportWithdrawals', 'listPrivateQueueHealth', 'listQueueWedgeCounts', 'listStuckActiveJobsByName', 'listWaitingByQueue', 'hasNotifierCoverage', 'readExportWithdrawalLedgerBytes', 'readMaxTimelineEntryId', 'readOldestWaitingAge', 'readQueueDivergence', 'readQueueHealthSignals', 'readWedgeSignals', 'storedTimelineRowsByPageIds', 'getWorktreeBinding']);
/** The write-journal reads, the writer-binding read (engine-sql/write-misc.ts `getWorktreeBinding`), the liveness round trip (engine-sql/health.ts `pingStore`) and the doctor reads (engine-sql/doctor-*.ts), which also replaced bounded statements. */
const DOCTOR_BOUNDED_READS: ReadonlySet<string> = new Set([
  ...JOURNAL_TYPED_READS, 'getWorktreeBinding', 'pingStore', ...DOCTOR_READ_MEMBERS, ...DOCTOR_DERIVED_MEMBERS, ...DOCTOR_PERSISTENCE_MEMBERS, ...DOCTOR_PAGES_MEMBERS, ...DOCTOR_SEARCH_MEMBERS, ...DOCTOR_ACC_MEMBERS, ...DOCTOR_JOIN_MEMBERS,
  ...DOCTOR_CHECKPOINT_MEMBERS, ...DOCTOR_TERMINAL_MEMBERS, ...DOCTOR_BRAIN_MEMBERS, ...DOCTOR_SYNC_MEMBERS, ...DOCTOR_SRC_MEMBERS, ...DOCTOR_FACTS_TRUST_MEMBERS, ...FENCE_CENSUS_MEMBERS,
  ...DOCTOR_PATH_TYPED_READS,
]);
/** Every typed read that replaced a bounded statement and runs under the doctor's read deadline: the journal and doctor reads, the decide reads and the writer-binding read. */
const DEADLINE_BOUND_READS: ReadonlySet<string> = new Set([...DOCTOR_BOUNDED_READS, ...BOUNDED_TYPED_READS]);

type RawCall = (sql: string, params?: unknown[], opts?: Record<string, unknown> & { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown[]>;

export function deadlineBoundEngine<E extends object>(engine: E): E {
  const raw = engineCacheKey(engine) as E;
  const known = wrappers.get(raw);
  if (known) return known as E;
  // Only Postgres takes a per-statement bound; the other engines run a statement to its end. An engine's kind never changes.
  const boundsStatements = (raw as { kind?: string }).kind === 'postgres';
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
      if (!boundsStatements) return call(sql, params, opts);
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
      if (!scope || scope.deadlineAt === null || typeof key !== 'string' || !DEADLINE_BOUND_READS.has(key) || !boundsStatements) {
        return Reflect.apply(fn, target, args);
      }
      // A typed read that replaced an executeRaw statement keeps that statement's bound: the engine ends it at the deadline.
      const deadlineAt = scope.deadlineAt;
      // A decide read runs on the raw engine. Any other typed read runs with this wrapper as `this`, so a member built on
      // `this.executeRaw` sends its statement through the bounded executeRaw above; the raw engine's executeRaw does not
      // read the ambient read deadline. Both carry the deadline's signal: a native read (preparationRead, runDeadlineRead)
      // has its reserved connection discarded when the deadline passes with the read unanswered (as executeRaw's was).
      const self = BOUNDED_TYPED_READS.has(key) ? target : wrapper;
      return withReadDeadline(deadlineAt, () => Reflect.apply(fn, self, args) as Promise<unknown>, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())))
        .catch((error: unknown) => {
          if (error instanceof ReadDeadlineError) refuse(scope);
          if (cancelled(error) && Date.now() >= deadlineAt - 100) scope.expired = true;
          throw error;
        });
    } });
  } });
  wrappers.set(raw, wrapper);
  rawEngines.set(wrapper, raw);
  return wrapper;
}
