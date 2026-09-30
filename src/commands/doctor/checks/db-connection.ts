/**
 * Database reachability: the PGLite data-dir diagnosis and scratch-store probe
 * that run when the connect failed, the connection check itself (live, or
 * synthesized when there is no engine), and the two early stops that end the
 * run before the DB checks.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { loadConfig, gbrainPath } from '../../../core/config.ts';
import { startHeartbeat } from '../../../core/progress.ts';
import { checkPgliteScratchProbe } from './core-health.ts';
import { computePgliteDataDirCheck } from './pglite-worker.ts';
import type { Check } from '../../doctor.ts';
import { classifyPgAccessError } from '../../../core/pg-access-classify.ts';
import { dbRepairRecurrenceCheck } from './engine-fit.ts';
import { STOP_DOCTOR, connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runPgliteDataDir(ctx: DoctorContext): Promise<Check[]> {
  const { args, engine, fastMode, progress } = ctx;
  const checks: Check[] = [];

  // 3d. PGLite data-dir diagnosis (WAL-repair wave) + scratch-store probe
  // (#2674). The data-dir check re-derives the failure state from DISK (the
  // connect error was swallowed by the fs-only fallback); the probe adds the
  // RUNTIME dimension (a throwaway store that opens fine proves the WASM
  // runtime is healthy). Both only fire when the connect already FAILED on a
  // PGLite brain (engine === null, not --fast — under --fast connect wasn't
  // attempted, so "engine === null" proves nothing there).
  //
  // Probe cost gate (a PGLite cold start is 5–20s): auto-runs ONLY when init
  // failed AND the disk diagnosis didn't already fully explain it — a live
  // lock or a missing dir needs no runtime probe (and 'locked' was exactly
  // the reviewed false-positive: blaming the store while `gbrain serve` held
  // it). Explicit --probe-pglite always runs it. A routine healthy
  // `gbrain doctor` never pays it.
  {
    const probeRequested = args.includes('--probe-pglite');
    let cfgForProbe: ReturnType<typeof loadConfig> = null;
    try { cfgForProbe = loadConfig(); } catch { /* no config — nothing to diagnose */ }
    const pgliteInitFailed = !engine && !fastMode && cfgForProbe?.engine === 'pglite';

    let dirVerdict: import('../../../core/pglite-repair.ts').PgliteDirDiagnosis['verdict'] | undefined;
    if (pgliteInitFailed) {
      try {
        const { inspectPgliteDataDir } = await import('../../../core/pglite-repair.ts');
        const { resolve } = await import('node:path');
        // Absolutize: a RELATIVE database_path would make the sidecar/backup
        // lookups resolve against doctor's cwd instead of the engine's.
        const pgliteDataDir = resolve(cfgForProbe!.database_path || gbrainPath('brain.pglite'));
        const diagnosis = inspectPgliteDataDir(pgliteDataDir);
        dirVerdict = diagnosis.verdict;
        checks.push(computePgliteDataDirCheck(pgliteDataDir, diagnosis));
      } catch {
        // Best-effort: an unreadable config or fs failure must not stop doctor.
      }
    }

    const dirExplainsFailure = dirVerdict === 'locked' || dirVerdict === 'missing';
    if (probeRequested || (pgliteInitFailed && !dirExplainsFailure)) {
      progress.start('doctor.pglite_probe');
      const stopHb = startHeartbeat(progress, 'pglite scratch-store probe (cold start, can take 5–20s)…');
      try {
        checks.push(
          await checkPgliteScratchProbe({
            // A lock/missing dir explains the failure without the store being
            // damaged — an explicit --probe-pglite there still reports on the
            // runtime, but must not treat the store as the convicted party.
            realInitFailed: pgliteInitFailed && !dirExplainsFailure,
            storeDamageEvidence:
              dirVerdict === 'wal-corruption-likely' || dirVerdict === 'unsupported-layout',
            realStorePath: cfgForProbe?.database_path,
          }),
        );
      } finally {
        stopHb();
        progress.finish();
      }
    }
  }
  return checks;
}

export const pgliteDataDirEntry: DoctorEntry = {
  name: 'pglite_data_dir',
  emits: ['pglite_data_dir', 'pglite_scratch_probe'],
  run: runPgliteDataDir,
};

/**
 * PgBouncer / prepared-statement compatibility. URL-only inspection — no DB
 * round-trip — extracted so it runs BOTH before the connection check and in
 * the dead-DB filesystem lane (a URL problem is diagnosable with the DB down).
 */
async function pgbouncerPrepareCheck(): Promise<Check | null> {
  try {
    const { resolvePrepare } = await import('../../../core/db.ts');
    const config = loadConfig();
    const url = config?.database_url || '';
    if (!url) return null;
    const prepare = resolvePrepare(url);
    if (prepare === false) {
      return { name: 'pgbouncer_prepare', status: 'ok', message: 'Prepared statements disabled (PgBouncer-safe)' };
    }
    try {
      const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
      if (parsed.port === '6543') {
        return {
          name: 'pgbouncer_prepare',
          status: 'warn',
          message:
            'Port 6543 (PgBouncer transaction mode) detected but prepared statements are enabled. ' +
            'This causes "prepared statement does not exist" errors under concurrent load. ' +
            'Fix: unset GBRAIN_PREPARE (or set =false), or add ?prepare=false to the connection URL.',
        };
      }
    } catch {
      // URL parse failure — skip, nothing actionable
    }
    return null;
  } catch {
    return null; // best-effort; never fail doctor on this check
  }
}

/**
 * db-availability loop (2c/2c-bis): the ONE classified-connection-fail shape,
 * shared by the live connection check and the dead-DB synthesized entry.
 * `connection` is in ROOT_CAUSE_CHECKS, so top_issues[0].fix carries the
 * classified remediation instead of a raw pg error. Deliberately NOT
 * makeRemediationStep: that lane feeds `--remediate`, whose Minion jobs need
 * the very DB that's down (db-repair is the engine-free applier here).
 */
function classifiedConnectionCheck(e: unknown): Check {
  const d = classifyPgAccessError(e, { url: loadConfig()?.database_url ?? null });
  return {
    name: 'connection',
    status: 'fail',
    message: d.message,
    details: { reason: d.reason, transient: d.transient, fix_hint: `${d.remediation} Run: gbrain db-repair` },
  };
}

async function runOfflineConnection(ctx: DoctorContext): Promise<Check[]> {
  const { connectError, dbSource, engine, fastMode } = ctx;
  const checks: Check[] = [];

  // --- DB checks (skip if --fast or no engine) ---
  if (!engine) {
    // Pick the precise message. When dbSource is provided, we know
    // whether a URL exists (env or config-file) — the caller simply
    // skipped the connection. When null, there really is no config
    // anywhere.
    if (!fastMode && dbSource && connectError !== undefined) {
      // 2c-bis: a REAL connect failure — synthesize the classified check so
      // `checks[name=="connection"]` exists in every failure shape.
      checks.push(classifiedConnectionCheck(connectError));
    } else {
      let msg: string;
      if (fastMode && dbSource) {
        msg = `Skipping DB checks (--fast mode, URL present from ${dbSource})`;
      } else if (!fastMode && dbSource) {
        msg = `Could not connect to configured DB (URL from ${dbSource}); filesystem checks only`;
      } else {
        msg = 'No database configured (filesystem checks only). Set GBRAIN_DATABASE_URL or run `gbrain init`.';
      }
      checks.push({ name: 'connection', status: 'warn', message: msg });
    }
    // URL-only + engine-free checks still run on a dead DB — that is the
    // point of them.
    const pgbouncer = await pgbouncerPrepareCheck();
    if (pgbouncer) checks.push(pgbouncer);
    const recurrence = dbRepairRecurrenceCheck();
    if (recurrence) checks.push(recurrence);
  }
  return checks;
}

export const offlineConnectionEntry: DoctorEntry = {
  name: 'connection',
  emits: ['connection', 'pgbouncer_prepare', 'db_repair_recurrence'],
  run: runOfflineConnection,
};

async function stopWithoutEngine(ctx: DoctorContext): Promise<Check[] | typeof STOP_DOCTOR> {
  // Early return: caller renders the partial check list + decides exit code.
  // Pre-v0.39 this site called outputResults + process.exit directly; the
  // narrow-seam extract moved both to the runDoctor CLI wrapper.
  if (ctx.fastMode || !ctx.engine) return STOP_DOCTOR;
  return [];
}

export const dbChecksGateEntry: DoctorEntry = { name: 'connection', emits: [], run: stopWithoutEngine };

async function runConnection(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // DB checks phase — start a single reporter phase so agents see which
  // check is running (several take seconds on 50K-page brains; without a
  // heartbeat the binary looks hung when stdout is piped).
  progress.start('doctor.db_checks');

  // 3a. PgBouncer / prepared-statement compatibility — HOISTED above the
  // connection check because it is URL-only (no round-trip) and must still
  // run when the connection below fails.
  progress.heartbeat('pgbouncer_prepare');
  {
    const pgbouncer = await pgbouncerPrepareCheck();
    if (pgbouncer) checks.push(pgbouncer);
  }

  // 3b. db-repair recurrence — engine-free receipts read; runs regardless of
  // connection state (repeat repairs are most interesting when the DB is sick).
  {
    const recurrence = dbRepairRecurrenceCheck();
    if (recurrence) checks.push(recurrence);
  }

  // 3. Connection
  progress.heartbeat('connection');
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    // db-availability loop (2c): classified + redacted, with the fix hint.
    checks.push(classifiedConnectionCheck(e));
    progress.finish();
    ctx.connectionFailed = true;
  }
  return checks;
}

export const connectionEntry: DoctorEntry = {
  name: 'connection',
  emits: ['pgbouncer_prepare', 'db_repair_recurrence', 'connection'],
  run: runConnection,
};

async function stopOnConnectionFailure(ctx: DoctorContext): Promise<Check[] | typeof STOP_DOCTOR> {
  // Early return: caller renders the partial check list + decides exit code.
  // Pre-v0.39 this site called outputResults + process.exit directly; the
  // narrow-seam extract moved both to the runDoctor CLI wrapper.
  if (ctx.connectionFailed) return STOP_DOCTOR;
  return [];
}

export const connectionGateEntry: DoctorEntry = {
  name: 'connection',
  emits: [],
  run: stopOnConnectionFailure,
};
