/**
 * #6089: the schema-version half of the `gbrain apply-migrations` exit
 * contract. The runner never exits 0 while it leaves the schema behind.
 *
 * - One helper connects the configured brain and reads `config.version`; the
 *   Postgres pre-flight, `--force-schema` and the check after orchestrators
 *   all go through it.
 * - After the orchestrators ran, the version is read again. On Postgres only
 *   when the pre-flight connected (an unreachable database stays non-fatal,
 *   with the GBRAIN_DB_ACCESS marker). On PGLite this check replaces the
 *   pre-flight, which stays skipped (#1100 lock race): it runs in-process once
 *   the orchestrators released the datastore, never in a child process, and an
 *   authorized run applies the schema migrations here.
 * - A schema still behind, or a version that cannot be read back, is
 *   `migrations_pending` (exit 1) with a reason and the schema migrations
 *   still pending. After an authorized run the fix is a report (doctor, then
 *   tell the user), never another `--yes` that would repeat the failure.
 */
import { existsSync } from 'node:fs';
import type { GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { Action } from '../core/agent-output.ts';
import { opError, type OperationError } from '../core/ops/contract.ts';
import { PgliteBusyError } from '../core/pglite-lock.ts';
import { DB_ACCESS_MARKER_PREFIX, shouldEmitDbAccessMarker } from '../core/pg-access-classify.ts';

export type SchemaPendingReason = 'not_applied' | 'still_behind' | 'schema_unreadable';

export interface SchemaPending {
  reason: SchemaPendingReason;
  /** The version read back, or null when it could not be read. */
  current: number | null;
  latest: number;
  /** Schema migration versions above the last version this run read. */
  pending: number[];
  /** Redacted read error (`schema_unreadable` only). */
  read_error?: string;
}

/** Connect the configured brain and read its schema version. The caller disconnects; a failed read disconnects here. */
export async function connectAtSchemaVersion(cfg: GBrainConfig): Promise<{ engine: BrainEngine; version: number }> {
  const { toEngineConfig } = await import('../core/config.ts');
  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(cfg));
  try {
    await engine.connect(toEngineConfig(cfg));
    return { engine, version: parseInt(await engine.getConfig('version') || '1', 10) };
  } catch (err) {
    await engine.disconnect().catch(() => {});
    throw err;
  }
}

/** A connection error with URLs and connection details redacted: safe for stderr, issues and CI logs. */
export async function redactDbError(err: unknown): Promise<string> {
  const { redactUrlsInText } = await import('../core/url-redact.ts');
  const { redactConnectionInfo } = await import('../core/audit/redact-connection-info.ts');
  return redactConnectionInfo(redactUrlsInText(err instanceof Error ? err.message : String(err)));
}

async function pendingAbove(version: number | null): Promise<{ latest: number; pending: number[] }> {
  const { MIGRATIONS, LATEST_VERSION } = await import('../core/migrate.ts');
  const pending = version === null ? [] : MIGRATIONS.map(m => m.version).filter(v => v > version).sort((a, b) => a - b);
  return { latest: LATEST_VERSION, pending };
}

/** The pre-flight's finding when it saw the schema behind and did not bring it to head. */
export async function schemaBehindAtPreflight(version: number, authorized: boolean): Promise<SchemaPending> {
  return { reason: authorized ? 'still_behind' : 'not_applied', current: version, ...(await pendingAbove(version)) };
}

/**
 * Read the schema version after the orchestrators ran; null when it is at
 * head or there is nothing to check (no PGLite datastore yet, or Postgres was
 * unreachable at the pre-flight, or a PGLite datastore that was never
 * initialized). `apply` brings a PGLite schema to head on an authorized run.
 * A busy PGLite datastore is rethrown like an orchestrator's.
 */
export async function checkSchemaAfterOrchestrators(opts: {
  cfg: GBrainConfig;
  authorized: boolean;
  preflightVersion: number | null;
  apply: (engine: BrainEngine, from: number) => Promise<unknown>;
}): Promise<SchemaPending | null> {
  const { cfg, authorized } = opts;
  const pglite = cfg.engine === 'pglite';
  if (pglite ? !cfg.database_path || !existsSync(cfg.database_path) : opts.preflightVersion === null) return null;
  let lastRead = opts.preflightVersion;
  try {
    const { engine, version } = await connectAtSchemaVersion(cfg);
    let current = version;
    try {
      const { latest } = await pendingAbove(current);
      if (pglite && authorized && current < latest) {
        console.error(`Schema v${current} is behind v${latest}; applying schema migrations in-process...`);
        try { await opts.apply(engine, current); } catch (err) { console.error(`Schema migration failed: ${await redactDbError(err)}`); }
        current = parseInt(await engine.getConfig('version') || '1', 10);
      }
    } finally {
      await engine.disconnect();
    }
    lastRead = current;
    const { latest, pending } = await pendingAbove(current);
    if (current >= latest) return null;
    return { reason: authorized ? 'still_behind' : 'not_applied', current, latest, pending };
  } catch (err) {
    if (err instanceof PgliteBusyError) throw err;
    // A PGLite datastore without the config table was never initialized: `gbrain init` creates a brain, not this run.
    if (pglite && /relation "config" does not exist/i.test(err instanceof Error ? err.message : String(err))) {
      console.error('The PGLite datastore has no gbrain schema yet, so there is no schema version to check; `gbrain init` creates it.');
      return null;
    }
    return { reason: 'schema_unreadable', current: null, ...(await pendingAbove(lastRead)), read_error: await redactDbError(err) };
  }
}

/** Tell the user, then show doctor's view: the same run again would fail the same way. */
function reportFix(why: string): Action {
  return { consent: [], actor: 'agent', requires_exclusive: false, why, verify: { argv: ['gbrain', 'doctor', '--json'] } };
}

const REPORT_SUGGESTION = 'Run `gbrain doctor --json` and tell the user what it reports, with the schema error from stderr. '
  + 'If the gbrain install itself is broken, the deterministic clone install in README.md recovers it (issue #218).';

/** `migrations_pending` for a run that leaves the schema behind. `rerunWithYes` is the fix when the run was not authorized. */
export function schemaPendingError(p: SchemaPending, rerunWithYes: Action): OperationError {
  const ids = p.pending.length ? p.pending.map(v => `v${v}`).join(', ') : 'unknown';
  const where = `schema v${p.current}, latest v${p.latest}; pending: ${ids}`;
  if (p.reason === 'not_applied') {
    return opError('migrations_pending', `Schema migrations are behind (${where}); this run did not apply them.`,
      'Apply them with `gbrain apply-migrations --yes` (or `--force-schema`).',
      { reason: p.reason, fix: rerunWithYes });
  }
  if (p.reason === 'still_behind') {
    return opError('migrations_pending', `Schema migrations are still behind after an authorized run (${where}); the schema migration did not apply, and running --yes again repeats that.`,
      REPORT_SUGGESTION,
      { reason: p.reason, why: 'apply-migrations --yes tried the schema migrations and they did not apply; stderr names the failing migration.',
        fix: reportFix('Tell the user the schema migrations did not apply and what doctor reports; another --yes run repeats the failure.') });
  }
  return opError('migrations_pending', `The schema version could not be read after the orchestrators ran (${p.read_error ?? 'unknown error'}); latest v${p.latest}, pending since the last version read: ${ids}.`,
    REPORT_SUGGESTION,
    { reason: p.reason, why: 'The run cannot confirm the schema reached head, so it does not report success.',
      fix: reportFix('Tell the user the schema version could not be confirmed and what doctor reports.') });
}

/** Postgres unreachable without --require-db: still non-fatal, but never silent. */
export function reportDatabaseUnreachable(probe: { reason: string; access?: string }): void {
  if (shouldEmitDbAccessMarker()) process.stderr.write(`${DB_ACCESS_MARKER_PREFIX} ${probe.access ?? 'unknown'}\n`);
  console.error(`Database unreachable (${probe.reason}): the schema version was not checked; orchestrators run their filesystem-only phases. `
    + 'Diagnose it with `gbrain db-repair`; pass --require-db to fail instead.');
}
