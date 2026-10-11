/**
 * #5227 (W14 P1.6): a bounded wait for the schema DDL's locks.
 *
 * `initSchema` replays `schema.sql` through one `conn.unsafe(sqlText)` (dozens
 * of `ALTER TABLE` and `ENABLE ROW LEVEL SECURITY`, each an ACCESS EXCLUSIVE
 * lock even as a no-op) on the reserved DDL backend, with no `lock_timeout`.
 * One idle-in-transaction session touching any table made every `gbrain init`
 * and `upgrade` wait in `wait_event_type=Lock` with no output until killed.
 *
 * The replay is many statements, not one transaction, so `SET LOCAL` binds
 * nothing there: this sets a SESSION-level `lock_timeout` on the reserved
 * backend (the `migrate.ts` `statement_timeout` precedent) and restores the
 * value it found, so a pooled backend never leaks the setting. While the wait
 * is active, a separate diagnostic connection samples `pg_blocking_pids()` of
 * the waiting backend once (after the cancel the blocker may already be gone);
 * SQLSTATE 55P03 then becomes the typed `schema_lock_blocked` refusal naming
 * those sessions by pid, application, state and transaction age. Query text
 * is never read: the message carries identifiers only.
 */
import postgres from '#postgres';
import { opError, type OperationError } from '../ops/contract.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';

export interface Queryable { unsafe(query: string, params?: unknown[]): Promise<unknown> }

export interface BlockingSession {
  pid: number;
  application_name: string | null;
  state: string | null;
  wait_event_type: string | null;
  transaction_age_seconds: number | null;
}

export interface SchemaLockTimeoutOpts {
  /** The session lock_timeout in ms. Default: GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS or 60 s. */
  timeoutMs?: number;
  /** Which schema step runs under the bound; named in the refusal. */
  step: string;
  /** A separate connection for the blocker sample; `null` when none can be opened (the sample is skipped). */
  diagnostic?: () => Promise<(Queryable & { end(): Promise<void> }) | null>;
  /** When to sample blockers, in ms after the statement starts (default: half the timeout). Test seam. */
  sampleAtMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Resolve the timeout from opts > env > default. Invalid env falls through. */
export function resolveSchemaLockTimeoutMs(opts: Pick<SchemaLockTimeoutOpts, 'timeoutMs'> = {}, env: NodeJS.ProcessEnv = process.env): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const raw = env.GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Sessions blocking `pid`, identifiers only (no query text). */
// engine-sql-ok: pg_stat_activity / pg_blocking_pids diagnostics on a Postgres-only lock wait, no storage-domain SQL
export const BLOCKING_SESSIONS_SQL = `SELECT pid, application_name, state, wait_event_type,
    EXTRACT(EPOCH FROM now() - xact_start)::int AS transaction_age_seconds
  FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids($1::int)) ORDER BY pid`;

export async function sampleBlockingSessions(diagnostic: Queryable, pid: number): Promise<BlockingSession[]> {
  const rows = await diagnostic.unsafe(BLOCKING_SESSIONS_SQL, [pid]) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    pid: Number(row.pid),
    application_name: row.application_name == null ? null : String(row.application_name),
    state: row.state == null ? null : String(row.state),
    wait_event_type: row.wait_event_type == null ? null : String(row.wait_event_type),
    transaction_age_seconds: row.transaction_age_seconds == null ? null : Number(row.transaction_age_seconds),
  }));
}

function describe(sessions: BlockingSession[]): string {
  return sessions.map(s => `pid ${s.pid}${s.application_name ? ` (${s.application_name})` : ''}, ${s.state ?? 'unknown state'}`
    + `${s.transaction_age_seconds != null ? `, transaction open ${s.transaction_age_seconds}s` : ''}`).join('; ');
}

/** The typed refusal for SQLSTATE 55P03 under the schema bound. */
// engine-sql-ok: the suggestion text quotes an operator's pg_stat_activity query; nothing here runs SQL
export function schemaLockBlockedError(input: { step: string; timeoutMs: number; sessions: BlockingSession[] | null; sampledDuringWait: boolean }): OperationError {
  const { step, timeoutMs, sessions } = input;
  const holders = sessions === null ? 'The blocking sessions could not be sampled.'
    : sessions.length === 0 ? `No blocking session was found${input.sampledDuringWait ? ' at the sample' : ' after the cancel (it may have finished)'}.`
    : `Blocked by ${describe(sessions)}${input.sampledDuringWait ? '' : ' (sampled after the cancel)'}.`;
  const pids = sessions?.map(s => s.pid) ?? [];
  return opError('schema_lock_blocked',
    `Schema ${step} waited ${Math.round(timeoutMs / 1000)}s for a table lock another session holds, and stopped instead of hanging. ${holders} Query text is not shown.`,
    `Nothing was changed by the cancelled step; the schema is as it was. Find what holds the lock (an open transaction in another client, a stuck job): ${pids.length
      ? `the blocking pid(s) are ${pids.join(', ')}. Let that session finish or, with the user's agreement, end it with SELECT pg_terminate_backend(<pid>) on the database host.`
      : 'run SELECT pid, application_name, state FROM pg_stat_activity WHERE state LIKE \'idle in transaction%\' on the database host and let that session finish or, with the user\'s agreement, end it with SELECT pg_terminate_backend(<pid>).'} Then rerun the same gbrain command; a longer wait is GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS.`,
    { detail: step, docs: 'docs/ENGINES.md#schema-lock-blocked' });
}

/**
 * A one-backend connection beside the DDL backend for the blocker sample;
 * `null` when the engine has no URL to open one with (the sample is skipped).
 */
export function schemaDiagnosticConnection(url: string | undefined): SchemaLockTimeoutOpts['diagnostic'] {
  if (!url) return undefined;
  return async () => {
    const sql = postgres(url, { max: 1, connect_timeout: 10, prepare: false, onnotice: () => {}, connection: { application_name: 'gbrain-schema-lock-diagnostic' } });
    return { unsafe: (query: string, params?: unknown[]) => sql.unsafe(query, params as never), end: () => sql.end({ timeout: 5 }) };
  };
}

/**
 * Run `run` on `conn` under a session-level `lock_timeout`, restoring the
 * previous value afterwards. A lock timeout becomes `schema_lock_blocked`
 * with the blockers sampled from the diagnostic connection while the wait
 * was active; every other error propagates unchanged.
 */
// engine-sql-ok: lock_timeout GUC control around a caller's DDL (SHOW / SET), no storage-domain SQL
export async function withSchemaLockTimeout<T>(conn: Queryable, run: () => Promise<T>, opts: SchemaLockTimeoutOpts): Promise<T> {
  const timeoutMs = resolveSchemaLockTimeoutMs(opts);
  const previous = String(((await conn.unsafe('SHOW lock_timeout')) as Array<{ lock_timeout: string }>)[0]?.lock_timeout ?? '0');
  await conn.unsafe(`SET lock_timeout = '${Math.max(1, Math.round(timeoutMs))}ms'`);
  const pid = Number(((await conn.unsafe('SELECT pg_backend_pid() AS pid')) as Array<{ pid: number | string }>)[0]?.pid);
  let sampled: BlockingSession[] | null | undefined;
  let sampling: Promise<void> | undefined;
  const sample = async () => {
    const diagnostic = await opts.diagnostic?.().catch(() => null);
    if (!diagnostic) { sampled = null; return; }
    try { sampled = await sampleBlockingSessions(diagnostic, pid); }
    catch { sampled = null; }
    finally { await diagnostic.end().catch(() => {}); }
  };
  const sampleAt = Math.min(opts.sampleAtMs ?? Math.floor(timeoutMs / 2), Math.max(0, timeoutMs - 50));
  const timer = opts.diagnostic ? setTimeout(() => { sampling = sample(); }, sampleAt) : undefined;
  try {
    return await run();
  } catch (error) {
    if (!isLockTimeoutError(error)) throw error;
    if (sampling) await sampling;
    const sampledDuringWait = sampled !== undefined;
    if (!sampledDuringWait) await sample();
    throw schemaLockBlockedError({ step: opts.step, timeoutMs, sessions: sampled ?? null, sampledDuringWait });
  } finally {
    if (timer) clearTimeout(timer);
    await conn.unsafe(`SET lock_timeout = '${previous.replace(/'/g, '')}'`).catch(() => {});
  }
}
