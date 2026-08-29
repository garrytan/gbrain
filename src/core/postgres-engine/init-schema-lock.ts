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

/** Best-effort: pid of the granted holder of the advisory lock, or null. */
async function lockHolderPid(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<number | null> {
  try {
    const rows = await query(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0
          AND objid = ${INIT_SCHEMA_LOCK_KEY} AND granted
        LIMIT 1`,
    );
    const pid = rows[0]?.pid;
    return typeof pid === 'number' ? pid : pid != null ? Number(pid) : null;
  } catch {
    return null;
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
  const timeoutMs = resolveInitSchemaLockTimeoutMs(opts);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const started = now();
  let lastBeat = started;
  for (;;) {
    const rows = await query(`SELECT pg_try_advisory_lock(${INIT_SCHEMA_LOCK_KEY}) AS locked`);
    if (rows[0]?.locked === true) return;

    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      const holder = await lockHolderPid(query);
      const holderNote = holder != null
        ? `Held by backend pid ${holder}.`
        : 'Holder pid could not be determined from pg_locks.';
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
      const holder = await lockHolderPid(query);
      log(
        `  [initSchema] waiting for the schema advisory lock` +
        `${holder != null ? ` (held by backend pid ${holder})` : ''}` +
        ` — ${Math.round(elapsed / 1000)}s elapsed, timeout ${Math.round(timeoutMs / 1000)}s`,
      );
    }

    await sleep(pollMs);
  }
}
