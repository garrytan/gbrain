/**
 * #2898 — deadlined acquisition of the initSchema advisory lock.
 *
 * `PostgresEngine.initSchema` used a bare `SELECT pg_advisory_lock(42)`,
 * which blocks FOREVER when another session holds the lock. Session-scoped
 * advisory locks leak through transaction-mode poolers (PgBouncer/Supabase
 * pooler strip session lock state across checkouts — the same reason the
 * cycle lock moved to a TTL table, see migrate.ts `cycle_locks_table`): a
 * pooled backend that acquired the lock for a client that vanished holds it
 * indefinitely, and every subsequent `gbrain` invocation hangs at connect
 * with no output.
 *
 * This helper polls `pg_try_advisory_lock(42)` with:
 *   - a stderr heartbeat (every ~5s) naming the holder pid from pg_locks so
 *     the operator can SEE the wait instead of a silent hang, and
 *   - a hard deadline (default 10 min — long enough for a legitimate
 *     concurrent migration run on the direct pool; tunable via
 *     `GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS`), after which it throws a
 *     structured error naming the holder pid with
 *     `SELECT pg_terminate_backend(<pid>)` recovery guidance.
 *
 * Postgres-only by design: PGLite is single-connection and takes no
 * advisory lock in initSchema (no parity counterpart required).
 */

/** Fixed advisory-lock key for initSchema DDL — brain-global on purpose
 *  (initSchema mutates the whole database; a per-source key would let two
 *  initSchema calls deadlock on shared DDL). */
export const INIT_SCHEMA_LOCK_KEY = 42;

/** The `application_name` of the transaction holding the schema migration lock, so diagnostics name it as a running migration and idle-blocker reports skip it. */
export const SCHEMA_MIGRATION_LOCK_APPLICATION_NAME = 'gbrain-schema-migration-lock';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 5_000;

export interface InitSchemaLockOpts {
  /** Hard deadline in ms. Default: GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS or 600s. */
  timeoutMs?: number;
  /** Poll interval in ms (default 500). */
  pollMs?: number;
  /** Heartbeat interval in ms (default 5000). Progress goes to stderr. */
  heartbeatMs?: number;
  /** Log sink (default process.stderr). */
  log?: (line: string) => void;
  /** Clock + sleep seams for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Resolve the timeout from opts > env > default. Invalid env falls through. */
export function resolveInitSchemaLockTimeoutMs(
  opts: Pick<InitSchemaLockOpts, 'timeoutMs'> = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const raw = env.GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Best-effort: pid of the granted holder of the advisory lock, and whether it is a running migration's lock transaction. */
// engine-sql-ok: pg_locks/pg_stat_activity read naming the holder of the Postgres advisory lock; PGLite takes none
async function lockHolder(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<{ pid: number | null; migrating: boolean }> {
  try {
    const rows = await query(
      `SELECT l.pid, a.application_name FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = 0
          AND l.objid = ${INIT_SCHEMA_LOCK_KEY} AND l.granted
        LIMIT 1`,
    );
    const pid = rows[0]?.pid;
    return {
      pid: typeof pid === 'number' ? pid : pid != null ? Number(pid) : null,
      migrating: rows[0]?.application_name === SCHEMA_MIGRATION_LOCK_APPLICATION_NAME,
    };
  } catch {
    return { pid: null, migrating: false };
  }
}

/**
 * Acquire the initSchema advisory lock or throw after the deadline.
 * `query` runs a raw SQL string on the SAME connection that will run the DDL
 * (session locks are per-backend — acquiring on any other connection would
 * be meaningless).
 */
export async function acquireInitSchemaAdvisoryLock(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
  opts: InitSchemaLockOpts = {},
): Promise<void> {
  await waitForSchemaLock(async () => (await query(`SELECT pg_try_advisory_lock(${INIT_SCHEMA_LOCK_KEY}) AS locked`))[0]?.locked === true, query, opts);
}

/** Polls `tryLock` until it returns true, with the heartbeat and deadline described above. */
// engine-sql-ok: polls a Postgres advisory-lock attempt; no storage-domain SQL
async function waitForSchemaLock(
  tryLock: () => Promise<boolean>,
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
  opts: InitSchemaLockOpts,
): Promise<void> {
  const timeoutMs = resolveInitSchemaLockTimeoutMs(opts);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const started = now();
  let lastBeat = started;
  for (;;) {
    if (await tryLock()) return;

    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      const { pid: holder, migrating } = await lockHolder(query);
      const holderNote = holder != null
        ? `Held by backend pid ${holder}.`
        : 'Holder pid could not be determined from pg_locks.';
      // A live migration holds it: terminating that backend would let a second runner start the step in flight.
      if (migrating) {
        throw new Error(
          `initSchema: timed out after ${Math.round(elapsed / 1000)}s waiting for the schema advisory lock ` +
          `(pg_advisory_lock(${INIT_SCHEMA_LOCK_KEY})). ${holderNote} Another gbrain process is running schema migrations; ` +
          `do not terminate it. Retry once it finishes (it releases the lock when it ends). ` +
          `Tune the wait with GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS.`,
        );
      }
      throw new Error(
        `initSchema: timed out after ${Math.round(elapsed / 1000)}s waiting for the schema advisory lock ` +
        `(pg_advisory_lock(${INIT_SCHEMA_LOCK_KEY})). ${holderNote} ` +
        `Another gbrain process may be mid-migration — retry once it finishes. ` +
        `If the holder is a LEAKED session (transaction-mode poolers like PgBouncer/Supabase ` +
        `strip session advisory-lock state across checkouts, so a backend can hold the lock for a ` +
        `client that is long gone), terminate it and retry:\n` +
        (holder != null
          ? `  SELECT pg_terminate_backend(${holder});\n`
          : `  SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${INIT_SCHEMA_LOCK_KEY} AND granted;\n` +
            `  SELECT pg_terminate_backend(<pid>);\n`) +
        `Tune the wait with GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS.`,
      );
    }

    if (now() - lastBeat >= heartbeatMs) {
      lastBeat = now();
      const { pid: holder, migrating } = await lockHolder(query);
      log(
        `  [initSchema] waiting for the schema advisory lock` +
        `${holder != null ? ` (held by backend pid ${holder}${migrating ? ', running schema migrations' : ''})` : ''}` +
        ` — ${Math.round(elapsed / 1000)}s elapsed, timeout ${Math.round(timeoutMs / 1000)}s`,
      );
    }

    await sleep(pollMs);
  }
}

type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

// engine-sql-ok: pg_locks read of this backend's own advisory lock; no storage-domain SQL
async function assertSchemaLockHeld(query: Query): Promise<void> {
  const rows = await query(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${INIT_SCHEMA_LOCK_KEY}
       AND pid = pg_backend_pid() AND granted) AS held`,
  ).catch(() => []);
  if (rows[0]?.held === true) return;
  throw new Error('The schema migration lock was lost (the connection holding it closed), so another gbrain process may now run '
    + 'schema migrations; stopped before the next migration. Run `gbrain apply-migrations --yes` again: it resumes where this run stopped.');
}

/**
 * GBRA-467: hold the schema migration lock (key 42) on `conn`, a reserved connection, while `fn` runs its work
 * on other connections. Every path that runs schema migrations takes this lock
 * (migrate.ts `withSchemaMigrationLock`).
 *
 * The lock is transaction-scoped, taken inside a transaction that stays open on `conn` for the whole run. A
 * transaction-mode pooler keeps one server connection for an open transaction, so the lock holds through it,
 * and the server releases it when the holder's connection dies. A session lock does not hold there: it lands on
 * whichever server connection the statement got, a second caller that gets the same one takes it again, and the
 * unlock can run on another. The transaction disables its idle timeout, since it idles while migrations run.
 * `fn` receives a check that the lock is still held, for the runner to call before each migration.
 */
// engine-sql-ok: transaction control and a Postgres advisory lock (BEGIN / SET LOCAL / pg_try_advisory_xact_lock / ROLLBACK); no storage-domain SQL
export async function holdSchemaMigrationTransactionLock<T>(
  conn: { unsafe: (sql: string) => Promise<unknown> },
  fn: (assertHeld: () => Promise<void>) => Promise<T>,
  opts: InitSchemaLockOpts = {},
): Promise<T> {
  const query: Query = sql => conn.unsafe(sql) as Promise<Array<Record<string, unknown>>>;
  const tryLock = async (): Promise<boolean> => {
    // READ COMMITTED whatever the role's default: a snapshot held for the whole run would make CREATE INDEX
    // CONCURRENTLY wait on this transaction.
    await query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await query('SET LOCAL idle_in_transaction_session_timeout = 0');
      await query(`SET LOCAL application_name = '${SCHEMA_MIGRATION_LOCK_APPLICATION_NAME}'`);
      if ((await query(`SELECT pg_try_advisory_xact_lock(${INIT_SCHEMA_LOCK_KEY}) AS locked`))[0]?.locked === true) return true;
    } catch (error) {
      await query('ROLLBACK').catch(() => {});
      throw error;
    }
    await query('ROLLBACK');
    return false;
  };
  await waitForSchemaLock(tryLock, query, opts);
  try {
    return await fn(() => assertSchemaLockHeld(query));
  } finally {
    await query('ROLLBACK').catch(() => {});
  }
}

/**
 * The same lock as a session lock, the fallback when every pool has one connection (GBRAIN_POOL_SIZE=1): `fn` runs
 * its work on that connection, so nothing can hold a transaction open beside it. This keeps the pre-GBRA-467
 * guarantee and no more: the lock holds on a real session, not through a transaction-mode pooler, so there is no
 * held-lock check (through such a pooler it would read another server connection). Both forms use key 42, so they
 * exclude each other and an older gbrain's session lock.
 */
// engine-sql-ok: Postgres session advisory-lock unlock; no storage-domain SQL
export async function holdSchemaMigrationSessionLock<T>(
  conn: { unsafe: (sql: string) => Promise<unknown> },
  fn: (assertHeld: () => Promise<void>) => Promise<T>,
  opts: InitSchemaLockOpts = {},
): Promise<T> {
  const query: Query = sql => conn.unsafe(sql) as Promise<Array<Record<string, unknown>>>;
  await acquireInitSchemaAdvisoryLock(query, opts);
  try {
    return await fn(async () => {});
  } finally {
    await query(`SELECT pg_advisory_unlock(${INIT_SCHEMA_LOCK_KEY})`);
  }
}
