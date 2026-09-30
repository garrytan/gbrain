import type { BrainEngine } from './engine.ts';
import type { Migration } from './schema-migrations/types.ts';
import { MIGRATIONS } from './schema-migrations/registry.generated.ts';
import { setQuietMigrationNotices } from './schema-migrations/helpers.ts';
// runMigrations executes while an initialized engine is live. Keep its helper
// modules in the static graph rather than importing them from async handlers.
import {
  isStatementTimeoutError,
  isRetryableConnError,
} from './retry-matcher.ts';
import { repairTimelineDedupIndex } from './timeline-dedup-repair.ts';
import { repairPagesUpsertArbiter } from './pages-upsert-arbiter.ts';
import { repairLinkSourceCheck, LINK_SOURCE_GATE_MIGRATION_VERSION } from './link-source-check-repair.ts';

export type { Migration };

/**
 * Resolve idempotent classification with the v0.30.1 default. Used by the
 * migration runner's verify path and by the twice-run safety test
 * (test/migrate-idempotent-classify.test.ts).
 */
export function isMigrationIdempotent(m: Migration): boolean {
  // Default true: existing migrations were authored as idempotent (every
  // CREATE/ALTER uses IF NOT EXISTS guards). Explicit false opts out.
  return m.idempotent !== false;
}

/**
 * Migration drift error — verify hook failed and migration is non-idempotent.
 * Caller surfaces the column/table names that diverged and requires
 * `--skip-verify` to force re-run.
 */
export class MigrationDriftError extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    public readonly hint: string,
  ) {
    super(`Migration v${version} (${migrationName}) verify failed: ${hint}`);
    this.name = 'MigrationDriftError';
  }
}

/**
 * Retry-exhausted envelope (v0.30.1 / Finding F2). Surface the most recent
 * idle blockers we observed so the user has a paste-ready
 * pg_terminate_backend(<pid>) command.
 */
export class MigrationRetryExhausted extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    public readonly attempts: number,
    public readonly lastBlockers: IdleBlocker[],
    public readonly lastError: Error,
  ) {
    const lastB = lastBlockers[0];
    const hint = lastB
      ? `PID ${lastB.pid} idle since ${lastB.query_start} likely holds the lock; run: psql ... -c "SELECT pg_terminate_backend(${lastB.pid})"`
      : 'No idle-in-transaction blockers detected; check pg_locks for active waiters and ~/.gbrain/audit/connection-events-*.jsonl';
    super(
      `Migration v${version} (${migrationName}) failed after ${attempts} attempts. ${hint}. Original: ${lastError.message}`
    );
    this.name = 'MigrationRetryExhausted';
  }
}

// Schema migrations live one per file in src/core/schema-migrations/v<NNN>-<name>.ts;
// the generated static-import registry (bun run build:schema-migrations) supplies
// MIGRATIONS in its historical array order. Exported for tests that structurally
// assert migration contents. Read-only contract.
export { MIGRATIONS };

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? Math.max(...MIGRATIONS.map(m => m.version))
  : 1;

/**
 * Row returned by `getIdleBlockers`. The shape is the public contract
 * for both `gbrain doctor --locks` output and the internal DDL pre-flight.
 */
export interface IdleBlocker {
  pid: number;
  state: string;
  query_start: string;
  query: string;
}

/**
 * Find idle-in-transaction connections older than 5 minutes that might
 * block DDL. Postgres-only. Returns `[]` on PGLite, query failure, or
 * no blockers. The query-failure path is intentionally silent because
 * some managed Postgres configs restrict `pg_stat_activity` — a partial
 * view of the server is still useful for doctor/pre-flight.
 *
 * Single source of truth shared by:
 *   - `checkForBlockingConnections` (DDL pre-flight warning)
 *   - `gbrain doctor --locks` (CLI diagnostic)
 *   - any future `--exclusive` drain-wait logic
 */
export async function getIdleBlockers(engine: BrainEngine): Promise<IdleBlocker[]> {
  if (engine.kind !== 'postgres') return [];
  try {
    return await engine.executeRaw<IdleBlocker>(
      `SELECT pid, state, query_start::text, substring(query, 1, 120) as query
       FROM pg_stat_activity
       WHERE state = 'idle in transaction'
         AND query_start < NOW() - INTERVAL '5 minutes'
         AND pid != pg_backend_pid()`
    );
  } catch {
    return [];
  }
}

/**
 * Check for idle-in-transaction connections that might block DDL.
 * Returns true if blockers were found (logged as warnings).
 */
async function checkForBlockingConnections(engine: BrainEngine): Promise<boolean> {
  const rows = await getIdleBlockers(engine);
  if (rows.length > 0) {
    console.warn(`\n⚠️  Found ${rows.length} idle-in-transaction connection(s) older than 5 minutes:`);
    for (const r of rows) {
      console.warn(`  PID ${r.pid} — idle since ${r.query_start}`);
      console.warn(`    Query: ${r.query}`);
    }
    console.warn(`  These may block ALTER TABLE DDL. To kill: SELECT pg_terminate_backend(<pid>);\n`);
    return true;
  }
  return false;
}

/**
 * v0.30.1 (Cherry D3 / Finding F2): wrap a migration attempt in 3-attempt
 * retry+backoff (5s/15s/45s). Retry only on statement_timeout (57014) or
 * connection-reset patterns; other errors fail loud immediately.
 *
 * Before each retry: log idle-in-transaction blockers so the user knows
 * which PID is holding the lock. After exhaustion: throw
 * `MigrationRetryExhausted` with the named PID + suggested
 * pg_terminate_backend command.
 */
async function runMigrationSQLWithRetry(
  engine: BrainEngine,
  m: Migration,
  sql: string,
): Promise<void> {
  // GBRAIN_MIGRATE_BACKOFF_MS lets tests skip the 5s/15s/45s backoff. In
  // production the env var is unset and the default cadence applies.
  const fastBackoff = process.env.GBRAIN_MIGRATE_BACKOFF_MS;
  const backoffs = fastBackoff !== undefined
    ? [parseInt(fastBackoff, 10) || 0, parseInt(fastBackoff, 10) || 0, parseInt(fastBackoff, 10) || 0]
    : [5000, 15000, 45000];
  let lastErr: Error | null = null;
  let lastBlockers: IdleBlocker[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Pre-attempt diagnostic: if there are idle blockers, log them so
      // the operator can see what we're racing against. Cherry D3.
      if (attempt > 0) {
        lastBlockers = await getIdleBlockers(engine);
        if (lastBlockers.length > 0) {
          console.warn(`  [retry ${attempt}/3] ${lastBlockers.length} idle-in-transaction blocker(s):`);
          for (const b of lastBlockers) {
            console.warn(`    PID ${b.pid} idle since ${b.query_start} — ${b.query.slice(0, 80)}`);
          }
        }
      }
      await runMigrationSQL(engine, m, sql);
      return;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const retryable = isStatementTimeoutError(err) || isRetryableConnError(err);
      if (!retryable || attempt === 2) {
        // Final failure: capture blockers + throw enriched envelope when
        // retry-eligible (named-PID UX from F2). Non-retryable errors fall
        // through to the existing 57014 handler in runMigrations.
        if (retryable) {
          lastBlockers = await getIdleBlockers(engine);
          throw new MigrationRetryExhausted(m.version, m.name, attempt + 1, lastBlockers, lastErr);
        }
        throw err;
      }
      const delay = backoffs[attempt];
      console.warn(`  [retry ${attempt + 1}/3] ${m.name} hit ${lastErr.message.slice(0, 80)}; retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Defensive: shouldn't reach here.
  if (lastErr) throw lastErr;
}

/**
 * Wrap migration SQL execution with Supabase-compatible timeout.
 * Uses SET LOCAL statement_timeout inside a transaction to override
 * server-enforced timeouts (required for Supabase Postgres).
 */
async function runMigrationSQL(
  engine: BrainEngine,
  m: Migration,
  sql: string,
): Promise<void> {
  const useTransaction = m.transaction !== false;

  if (useTransaction || engine.kind === 'pglite') {
    // Wrap in transaction with extended timeout for Supabase compatibility.
    // SET LOCAL scopes the timeout to this transaction only.
    await engine.transaction(async (tx) => {
      if (engine.kind === 'postgres') {
        try {
          await tx.runMigration(m.version, "SET LOCAL statement_timeout = '600000'");
        } catch {
          // Non-fatal: PGLite or older Postgres versions may not support this
        }
      }
      await tx.runMigration(m.version, sql);
    });
  } else {
    // Postgres + transaction:false → can't use SET LOCAL (needs a txn),
    // can't use plain SET on the pooled connection (leaks to other
    // queries). Instead: reserve a dedicated backend, set session-level
    // statement_timeout on just that connection, run the DDL there.
    //
    // On Supabase (both PgBouncer 6543 and direct 5432) a server-level
    // statement_timeout of ~2 min is enforced. Without this override a
    // CREATE INDEX CONCURRENTLY on a large table (e.g. 500K pages) hits
    // the timeout and aborts. SET on the reserved connection cleanly
    // overrides because the GUC scope is connection-local (session-scope
    // is fine when nobody else uses the connection).
    //
    // The reserved-connection primitive is new in PR #356. See
    // BrainEngine.withReservedConnection.
    await engine.withReservedConnection(async (conn) => {
      try {
        await conn.executeRaw("SET statement_timeout = '600000'");
      } catch {
        // Non-fatal: some managed Postgres may restrict this GUC.
        // Falling through means the DDL runs with the server default.
      }
      await conn.executeRaw(sql);
    });
  }
}

/**
 * Cheap probe: does this engine have schema migrations pending?
 *
 * Reads the `version` config row in a single round-trip (no schema replay,
 * no migration apply). Used by `connectEngine` to gate `initSchema()` so
 * short-lived CLI invocations on already-migrated brains don't pay the
 * full bootstrap-probe + SCHEMA_SQL replay + ledger-check cost on every
 * `gbrain stats` / `gbrain query` / `gbrain doctor`.
 *
 * Defensive: treats a getConfig failure (config table missing, query error)
 * as "yes pending" so the caller falls through to the full initSchema path.
 * Worst case on a wedged brain is one extra schema replay — same as before.
 *
 * Closes #651 in cooperation with the post-upgrade auto-apply hook (X1)
 * without the perf cost #652 would have introduced on every CLI call.
 */
export async function hasPendingMigrations(engine: BrainEngine): Promise<boolean> {
  try {
    const currentStr = await engine.getConfig('version');
    const current = parseInt(currentStr || '1', 10);
    return current < LATEST_VERSION;
  } catch {
    return true;
  }
}

/**
 * v0.41.6.0 D4 — race-tolerant CLI-side migration runner.
 *
 * Wraps `engine.initSchema()` with a deadlock-aware retry + poll loop so
 * the common "two CLIs probe schema simultaneously" race doesn't surface
 * an alarming `Schema probe/migrate failed: deadlock detected` warning
 * on every sync.
 *
 * Flow:
 *  1. Try `engine.initSchema()`.
 *  2. On SQLSTATE 40P01 (deadlock_detected) from Postgres: wait 250ms,
 *     retry once.
 *  3. If second attempt still 40P01 (or any persistent lock-busy signal):
 *     poll `hasPendingMigrations()` every 250ms for up to 5s. If poll
 *     flips to `false` mid-window, return `{ status: 'race_resolved' }`
 *     silently (another runner finished — common case the user
 *     complained about).
 *  4. If still pending at deadline: return `{ status: 'persistent', error }`.
 *     Caller surfaces the revised warning.
 *  5. Non-40P01 errors propagate normally (real failures).
 *
 * The deeper root cause (codex F12 in plan-eng-review: initSchema
 * already holds pg_advisory_lock(42), so the deadlock graph likely
 * involves OTHER locks like DDL vs application-query contention or
 * PgBouncer pool artifacts) is filed as a P2 follow-up TODO. The
 * symptom fix here quiets the warning on the COMMON case where the race
 * resolves itself, while loud-failing when migration is genuinely stuck.
 *
 * `deadlineMs` defaults to 5000 (5s polling window). Test-only callers
 * pass smaller values for hermeticity; production paths use the default.
 *
 * `pollIntervalMs` defaults to 250ms — matches the retry-backoff delay
 * for a symmetric design (eng-review D11). ~20 polls per deadline window;
 * trivial DB load even on a stressed PgBouncer pool.
 */
export type TryRunPendingMigrationsResult =
  | { status: 'ok'; attempts: number }
  | { status: 'not_needed' }
  | { status: 'race_resolved'; attempts: number; pollIterations: number }
  | { status: 'persistent'; attempts: number; pollIterations: number; error: Error }
  | { status: 'error'; error: Error };

export interface TryRunPendingMigrationsOpts {
  deadlineMs?: number;
  pollIntervalMs?: number;
  retryBackoffMs?: number;
  /** Test seam: inject a custom hasPendingMigrations / initSchema pair. */
  _hooks?: {
    initSchema?: () => Promise<void>;
    hasPending?: () => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}

export async function tryRunPendingMigrations(
  engine: BrainEngine,
  opts: TryRunPendingMigrationsOpts = {},
): Promise<TryRunPendingMigrationsResult> {
  const deadlineMs = opts.deadlineMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const retryBackoffMs = opts.retryBackoffMs ?? 250;
  const initSchema = opts._hooks?.initSchema ?? (() => engine.initSchema());
  const hasPending = opts._hooks?.hasPending ?? (() => hasPendingMigrations(engine));
  const sleep = opts._hooks?.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const now = opts._hooks?.now ?? (() => Date.now());

  // Quick early-exit: if no migrations are actually pending, skip entirely.
  if (!await hasPending()) return { status: 'not_needed' };

  let attempts = 0;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      await initSchema();
      return { status: 'ok', attempts };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!isDeadlockError(lastErr)) {
        // Real failure: propagate to caller's catch.
        return { status: 'error', error: lastErr };
      }
      // Deadlock — backoff before retry.
      if (attempt === 0) await sleep(retryBackoffMs);
    }
  }

  // Both attempts deadlocked. Poll hasPendingMigrations until deadline.
  const deadline = now() + deadlineMs;
  let pollIterations = 0;
  while (now() < deadline) {
    pollIterations++;
    await sleep(pollIntervalMs);
    try {
      if (!await hasPending()) return { status: 'race_resolved', attempts, pollIterations };
    } catch {
      // hasPending throws → treat as pending (defensive; matches its own catch).
    }
  }

  return {
    status: 'persistent',
    attempts,
    pollIterations,
    error: lastErr ?? new Error('deadlock_persistent'),
  };
}

/**
 * Detect Postgres SQLSTATE 40P01 (deadlock_detected) from arbitrary
 * thrown values. Pattern-matches on:
 *   - postgres.js `.code === '40P01'`
 *   - error message containing `40P01` or `deadlock detected`
 * The text-fallback covers cases where the driver doesn't expose `.code`.
 */
export function isDeadlockError(err: unknown): boolean {
  if (!err) return false;
  const maybe = err as { code?: string; sqlState?: string; message?: string };
  if (maybe.code === '40P01' || maybe.sqlState === '40P01') return true;
  const msg = String(maybe.message ?? err);
  return /40P01|deadlock detected/i.test(msg);
}

export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  // Sort by version ascending so array insertion order doesn't affect
  // correctness. Migrations MUST run in version order; if v16 accidentally
  // precedes v15 in MIGRATIONS, setConfig(version, 16) would cause v15 to
  // be skipped on the next iteration.
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  const pending = sorted.filter(m => m.version > current);

  // #2038: schema-drift self-heal. A migration renumbered during a master
  // merge (v102 timeline dedup, originally v99) can be recorded-as-applied
  // without its DDL ever running — the version counter can't see it. Repair
  // the known drift on EVERY pass, including when nothing is pending (the
  // affected brains are stamped AHEAD of the missing migration, so they never
  // reach the loop below). Best-effort + idempotent: a no-op on a healthy
  // index; `doctor` surfaces it independently if this ever fails.
  try {
    const r = await repairTimelineDedupIndex(engine);
    if (r.repaired) {
      console.error(
        `[migrate] healed idx_timeline_dedup drift (#2038): ${r.before.join(',') || '(absent)'} ` +
        `→ page_id,date,md5(summary),source` +
        (r.collapsedDuplicates > 0 ? ` (collapsed ${r.collapsedDuplicates} duplicate row(s))` : ''),
      );
    }
  } catch { /* best-effort; doctor reports the drift if this couldn't run */ }

  // #550: same drift class for the pages upsert arbiter. When the
  // UNIQUE(source_id, slug) constraint vanishes (partial restore, manual DDL,
  // name-only migration guards), EVERY putPage fails with "no unique or
  // exclusion constraint" and neither re-initSchema nor the version counter
  // can see it. ADD-only self-heal; refuses (loudly) on duplicate rows.
  try {
    const p = await repairPagesUpsertArbiter(engine);
    if (p.repaired) {
      console.error(`[migrate] restored pages_source_slug_key UNIQUE(source_id, slug) (#550)`);
    } else if (p.reason === 'duplicates') {
      console.error(
        `[migrate] cannot restore pages_source_slug_key: ${p.duplicateGroups} duplicate ` +
        `(source_id, slug) group(s) exist — page upserts will keep failing until the ` +
        `duplicates are resolved (#550). See \`gbrain doctor\`.`,
      );
    }
  } catch { /* best-effort; doctor reports the drift if this couldn't run */ }

  // #4613: same drift class for links_link_source_check. A brain stamped past
  // v114 whose CHECK still carries the pre-v114 allowlist rejects every kebab
  // provenance write; the version counter can't see it. Refuses loudly on
  // violators. Ledger-gated: below v114 the pending loop replays v114 itself
  // (the repair would rewrite the constraint twice; pre-v11 has no column).
  if (current >= LINK_SOURCE_GATE_MIGRATION_VERSION) {
    try {
      const l = await repairLinkSourceCheck(engine);
      if (l.repaired) {
        console.error(`[migrate] restored links_link_source_check to the v114 kebab-case gate (#4613)`);
      } else if (l.reason === 'violations') {
        console.error(
          `[migrate] cannot restore links_link_source_check: ${l.violations} links row(s) have a ` +
          `non-kebab link_source — fix or delete them, then re-run (#4613). See \`gbrain doctor\`.`,
        );
      }
    } catch (e) {
      console.error(`[migrate] links_link_source_check self-heal could not run (#4613): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (pending.length === 0) {
    return { applied: 0, current };
  }

  // Fresh install vs upgrade: a never-migrated brain (schema blob seeds
  // version='1'; every migration is >= 2) replays the FULL history — printing
  // ~240 lines of internal migration names as the user's first-run experience.
  // That wall makes a 2-second init read as complex and fragile ("1 → 125"
  // implies the brand-new install was 124 versions stale). Fresh installs get
  // one summary line; EXISTING brains keep the full per-migration detail
  // (upgrades are where the names carry diagnostic value).
  // GBRAIN_MIGRATE_VERBOSE=1 is the incident escape hatch (env-first, matching
  // the GBRAIN_SYNC_*/GBRAIN_PACE_* pattern).
  const freshInstall = current <= 1 && pending.length === sorted.length;
  const quietReplay = freshInstall && process.env.GBRAIN_MIGRATE_VERBOSE !== '1';
  // Suppress per-migration explanatory notices during a fresh-install replay
  // (they are upgrade diagnostics, noise on a new user's first run). Restored
  // in the finally so an in-process upgrade after a fresh init still narrates.
  setQuietMigrationNotices(quietReplay);

  // Progress messages route to stderr so callers parsing stdout (e.g.
  // `gbrain jobs submit --json | jq`) aren't polluted by migration noise.
  if (quietReplay) {
    process.stderr.write(`  Setting up brain schema (v${LATEST_VERSION})...\n`);
  } else {
    process.stderr.write(`  Schema version ${current} → ${LATEST_VERSION} (${pending.length} migration(s) pending)\n`);
  }

  let applied = 0;
  try {
    // Pre-flight: warn about connections that might block DDL
    await checkForBlockingConnections(engine);

    for (const m of pending) {
      if (!quietReplay) process.stderr.write(`  [${m.version}] ${m.name}...\n`);
      try {
        await applyOneMigration(engine, m);
        // Update version after both SQL and handler succeed. Inside the same
        // catch so a stamp-write failure is also NAMED in quiet mode.
        await engine.setConfig('version', String(m.version));
      } catch (err) {
        // Quiet fresh-install replay: name the failing migration — without the
        // per-step lines, the error would otherwise be anonymous.
        if (quietReplay) process.stderr.write(`  [${m.version}] ${m.name} failed\n`);
        throw err;
      }

      if (!quietReplay) process.stderr.write(`  [${m.version}] ✓ ${m.name}\n`);
      applied++;
    }
  } finally {
    // Never leak the fresh-install quiet flag into a later in-process run —
    // covers every exit path from here on (incl. the pre-flight probe).
    setQuietMigrationNotices(false);
  }

  return { applied, current: LATEST_VERSION };
}

/** One migration's full body (SQL + handler + verify), extracted so the
 *  runMigrations loop can name the failing migration in quiet-replay mode. */
async function applyOneMigration(engine: BrainEngine, m: Migration): Promise<void> {
    // Pick SQL: engine-specific `sqlFor` wins over engine-agnostic `sql`.
    const sql = m.sqlFor?.[engine.kind] ?? m.sql;

    if (sql) {
      try {
        // v0.30.1: retry wrapper handles statement_timeout + conn-reset
        // across 3 attempts (5s/15s/45s). Other errors throw immediately.
        await runMigrationSQLWithRetry(engine, m, sql);
      } catch (err: unknown) {
        // Actionable diagnostics for statement timeout (Postgres error 57014).
        // Shape matches the 4-part error standard (what / why / fix / verify).
        const code = (err as { code?: string })?.code;
        if (code === '57014' || err instanceof MigrationRetryExhausted) {
          console.error(`\n❌ Migration ${m.version} (${m.name}) ${err instanceof MigrationRetryExhausted ? 'exhausted retries' : 'hit statement_timeout (SQLSTATE 57014)'}.`);
          if (err instanceof MigrationRetryExhausted && err.lastBlockers.length > 0) {
            const b = err.lastBlockers[0];
            console.error('');
            console.error(`   Likely blocker: PID ${b.pid}, idle since ${b.query_start}`);
            console.error(`   Query: ${b.query.slice(0, 120)}`);
            console.error('');
            console.error(`   Recovery: psql ... -c "SELECT pg_terminate_backend(${b.pid})"`);
            console.error('');
          } else {
            console.error('');
            console.error('   Cause: another connection holds a lock on the target table, or the');
            console.error('   server statement_timeout (~2 min on Supabase) is too short for this DDL.');
            console.error('');
            console.error('   Fix:');
            console.error('     1. gbrain doctor --locks    # find idle-in-transaction blockers');
            console.error('     2. Terminate blocker(s) shown by step 1 via pg_terminate_backend(<pid>)');
            console.error('     3. gbrain apply-migrations --yes  # re-run from the version that failed');
            console.error('');
          }
          console.error('   Verify:');
          console.error('     gbrain doctor              # schema_version should match latest');
          console.error('');
        }
        throw err;
      }
    }

    // Application-level handler (runs outside transaction for flexibility)
    if (m.handler) {
      await m.handler(engine);
    }

    // v0.30.1 (D6): post-condition probe. If a verify hook is declared, run
    // it before bumping config.version. When verify returns false, check
    // idempotent — if true, log + retry the same migration once; if false,
    // throw MigrationDriftError so operator runs --skip-verify deliberately.
    if (m.verify) {
      const verifyOk = await m.verify(engine).catch(() => false);
      if (!verifyOk) {
        const idempotent = isMigrationIdempotent(m);
        if (idempotent) {
          console.warn(`  [${m.version}] ⚠️  verify failed; re-running idempotent migration once`);
          if (sql) await runMigrationSQLWithRetry(engine, m, sql);
          if (m.handler) await m.handler(engine);
          // Best-effort: don't double-throw if second run still fails verify.
          // Operator's next run of doctor will re-detect drift.
        } else {
          throw new MigrationDriftError(
            m.version,
            m.name,
            `Schema does not match expected post-condition. Run with --skip-verify to force.`,
          );
        }
      }
    }

}
