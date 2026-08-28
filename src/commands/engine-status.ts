/**
 * `gbrain engine status` — the ENGINE-FREE detection primitive of the
 * db-availability loop. Answers "which engine is this brain on, where does
 * its URL come from, and (with --probe) can we reach it?" without requiring
 * a working database — the exact situation the bundled skills call it in.
 *
 * CLI-only (dispatched in handleCliOnly BEFORE connectEngine, like
 * pglite-repair). Deliberately NOT an operations.ts op: the starter MCP
 * surface is cli-primary for ops like this, and an MCP server can't serve a
 * status call when its DB is down anyway.
 *
 * Zero round-trips without --probe. With --probe: a SINGLE bounded connect
 * (the driver's built-in `connect_timeout: 10` in db.ts — never a custom
 * race) + SELECT 1; failures come back as a classified PgAccessDiagnosis,
 * not a raw error. On PGLite the probe is LOCK-AWARE: a live `gbrain serve`
 * holding the single-writer lock reports `locked_by_serve` (healthy-with-
 * note) instead of hanging ~30s on the lock and misreporting a broken brain.
 */

import { existsSync } from 'node:fs';

import {
  envShadowDetected,
  getDbUrlSource,
  gbrainPath,
  isThinClient,
  loadConfig,
  loadConfigFileOnly,
  toEngineConfig,
  type GBrainConfig,
} from '../core/config.ts';
import { HOST_BRAIN_ID, loadMounts, type MountEntry } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { connectWithRetry, resolvePoolSize, resolvePrepare } from '../core/db.ts';
import { createEngine } from '../core/engine-factory.ts';
import {
  deriveDirectUrl,
  deriveSessionPoolerUrl,
  isSupabasePoolerUrl,
} from '../core/connection-manager.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { redactPgUrl } from '../core/url-redact.ts';
import {
  classifyPgAccessError,
  diagnoseDbConfig,
  type PgAccessDiagnosis,
  type PgDbUrlSource,
} from '../core/pg-access-classify.ts';

class UnknownFlagError extends Error {}

interface EngineStatusOpts {
  json: boolean;
  probe: boolean;
  brain: string | null;
  help: boolean;
}

function parseArgs(args: string[]): EngineStatusOpts {
  const opts: EngineStatusOpts = { json: false, probe: false, brain: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'status') continue; // subcommand token
    else if (a === '--json') opts.json = true;
    else if (a === '--probe') opts.probe = true;
    else if (a === '--brain') {
      const val = args[++i];
      if (val === undefined || val.startsWith('-')) throw new UnknownFlagError('--brain requires a brain id');
      opts.brain = val;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new UnknownFlagError(`Unknown flag for engine status: ${a}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`gbrain engine status — report the active engine + DB config, engine-free

Usage:
  gbrain engine status [--json] [--probe] [--brain <id>]

Flags:
  --json         machine output (schema_version 1)
  --probe        attempt ONE bounded connect + SELECT 1 (classified on failure)
  --brain <id>   resolve a specific brain (default: --brain/GBRAIN_BRAIN_ID/.gbrain-mount chain)

Works with the database down — that is the point. Pair with:
  gbrain db-repair          diagnose + fix Postgres access
  gbrain init --prefer-postgres   set up an engine, Postgres-first`);
}

interface ProbeResult {
  ok: boolean;
  note?: string;
  latency_ms?: number;
  mode?: unknown;
  pool_latency_ms?: { read: number | null; direct: number | null };
  diagnosis?: PgAccessDiagnosis;
}

interface EngineStatusReport {
  schema_version: 1;
  brain_id: string;
  effective_engine: 'postgres' | 'pglite' | null;
  config_file_engine: 'postgres' | 'pglite' | null;
  db_url_source: PgDbUrlSource;
  database_url: string | null; // redacted
  database_path: string | null;
  thin_client: boolean;
  env: {
    shadowed: boolean;
    gbrain_database_url: string | null; // redacted
    database_url: string | null; // redacted
    note?: string;
  };
  pooler?: {
    supabase_pooler: boolean;
    prepare: boolean | undefined;
    direct_url_derivable: boolean;
    session_pooler_derivable: boolean;
    direct_pool_disabled: boolean;
    pool_size: number;
    direct_pool_size: number | null;
  };
  pglite_lock?: { held: boolean; serve?: boolean; pid?: number; subcommand?: string };
  config_diagnosis?: PgAccessDiagnosis;
  probe?: ProbeResult;
}

function fileEngine(fileCfg: GBrainConfig | null): 'postgres' | 'pglite' | null {
  if (!fileCfg) return null;
  if (fileCfg.engine) return fileCfg.engine;
  if (fileCfg.database_url) return 'postgres';
  if (fileCfg.database_path) return 'pglite';
  return null;
}

/** Resolve the mount entry for a non-host brain, or null when unknown. */
function mountFor(brainId: string): MountEntry | null {
  try {
    return loadMounts().find((m) => m.id === brainId) ?? null;
  } catch {
    return null;
  }
}

async function runProbe(
  engineKind: 'postgres' | 'pglite',
  engineConfig: import('../core/types.ts').EngineConfig,
  dataDir: string | null,
): Promise<ProbeResult> {
  if (engineKind === 'pglite') {
    // Read-only contract: PGLite CREATES a database at a missing path on
    // connect — a status probe against a typo'd/missing data dir must
    // report the misconfiguration, never materialize a junk store that
    // masks it.
    if (dataDir && !existsSync(dataDir)) {
      return { ok: false, note: 'data_dir_missing' };
    }
    // Lock-aware: a live holder means the DB is in active use (working) —
    // connecting would block on the single-writer lock for up to 30s and
    // then misreport a HEALTHY brain as broken.
    const lock = inspectLockHolder(dataDir ?? undefined);
    if (lock.held) {
      // A live holder always carries its pid; held-with-no-pid is the
      // CORRUPT-lock shape (liveness unknowable) — that is not a healthy
      // probe, and connecting could still block, so report it as a failure.
      if (lock.pid === undefined) {
        return { ok: false, note: 'lock_unreadable' };
      }
      return {
        ok: true,
        note: lock.serve ? 'locked_by_serve' : `locked_by_${lock.subcommand ?? 'live_process'}`,
      };
    }
  }
  const started = Date.now();
  const engine = await createEngine(engineConfig);
  try {
    // SINGLE attempt, ONE connection — the driver's connect_timeout bounds
    // it (never a custom race), and a status probe must never run the
    // 3-attempt backoff ladder or hold pooler slots while diagnosing.
    await connectWithRetry(engine, { ...engineConfig, poolSize: 1 }, { noRetry: true, log: () => {} });
    await engine.executeRaw('SELECT 1');
    const result: ProbeResult = { ok: true, latency_ms: Date.now() - started };
    if (engineKind === 'postgres') {
      // First real callers of the ConnectionManager introspection surface
      // (TODOS 1231): report routing mode + per-pool health latencies when
      // the engine exposes them.
      const mgr = (engine as unknown as {
        connectionManager?: {
          describeMode?: () => unknown;
          healthCheck?: () => Promise<{ read: number | null; direct: number | null }>;
        };
      }).connectionManager;
      try {
        result.mode = mgr?.describeMode?.();
        const health = await mgr?.healthCheck?.();
        if (health) result.pool_latency_ms = health;
      } catch { /* introspection is best-effort */ }
    }
    return result;
  } finally {
    try { await engine.disconnect(); } catch { /* probe cleanup is best-effort */ }
  }
}

export async function runEngineStatus(args: string[]): Promise<number> {
  let opts: EngineStatusOpts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  const brainId = resolveBrainId(opts.brain);
  const shadowed = envShadowDetected();

  let report: EngineStatusReport;

  if (brainId !== HOST_BRAIN_ID) {
    // Mounted brain: the mount entry IS the config — report ITS engine, not
    // the host's (a mount failure must never read as a host failure).
    const mount = mountFor(brainId);
    report = {
      schema_version: 1,
      brain_id: brainId,
      effective_engine: mount?.engine ?? null,
      config_file_engine: mount?.engine ?? null,
      db_url_source: mount ? 'config-file' : null,
      database_url: mount?.database_url ? redactPgUrl(mount.database_url) : null,
      database_path: mount?.database_path ?? null,
      thin_client: false,
      env: { shadowed: false, gbrain_database_url: null, database_url: null },
    };
    if (!mount) {
      report.config_diagnosis = {
        reason: 'no_url',
        transient: false,
        message: `Brain '${brainId}' is not a registered mount.`,
        remediation: `Unknown brain '${brainId}'. List mounts: gbrain mounts list. Add one: gbrain mounts add.`,
        brainId,
      };
    } else if (opts.probe && mount.engine) {
      report.probe = await probeSafely(mount.engine, {
        engine: mount.engine,
        database_url: mount.database_url,
        database_path: mount.database_path,
      }, mount.database_path ?? null, mount.database_url ?? null, 'config-file', brainId);
    }
  } else {
    const cfg = loadConfig();
    const fileCfg = loadConfigFileOnly();
    const source = getDbUrlSource() as PgDbUrlSource;
    const thin = isThinClient(cfg);
    const url = cfg?.database_url ?? null;
    const dataDir = cfg?.database_path ?? (cfg?.engine === 'pglite' ? gbrainPath('brain.pglite') : null);

    report = {
      schema_version: 1,
      brain_id: brainId,
      effective_engine: cfg?.engine ?? null,
      config_file_engine: fileEngine(fileCfg),
      db_url_source: source,
      database_url: url ? redactPgUrl(url) : null,
      database_path: cfg?.database_path ?? null,
      thin_client: thin,
      env: {
        shadowed,
        gbrain_database_url: process.env.GBRAIN_DATABASE_URL ? redactPgUrl(process.env.GBRAIN_DATABASE_URL) : null,
        database_url: process.env.DATABASE_URL ? redactPgUrl(process.env.DATABASE_URL) : null,
        note:
          process.env.GBRAIN_DATABASE_URL && process.env.DATABASE_URL
            ? 'both env URLs set — GBRAIN_DATABASE_URL wins'
            : shadowed
              ? 'DATABASE_URL excluded by the cwd-.env guard (#427)'
              : undefined,
      },
    };

    if (url && cfg?.engine === 'postgres') {
      report.pooler = {
        supabase_pooler: isSupabasePoolerUrl(url),
        prepare: resolvePrepare(url),
        direct_url_derivable: deriveDirectUrl(url) !== null,
        session_pooler_derivable: deriveSessionPoolerUrl(url) !== null,
        direct_pool_disabled: process.env.GBRAIN_DISABLE_DIRECT_POOL === '1' || process.env.GBRAIN_DISABLE_DIRECT_POOL === 'true',
        pool_size: resolvePoolSize(),
        direct_pool_size: process.env.GBRAIN_DIRECT_POOL_SIZE ? Number(process.env.GBRAIN_DIRECT_POOL_SIZE) : null,
      };
    }
    if (cfg?.engine === 'pglite') {
      const lock = inspectLockHolder(dataDir ?? undefined);
      report.pglite_lock = { held: lock.held, serve: lock.serve, pid: lock.pid, subcommand: lock.subcommand };
    }

    if (!cfg && !thin) {
      report.config_diagnosis = diagnoseDbConfig({ source, envShadowed: shadowed, brainId }) ?? undefined;
    }

    if (opts.probe) {
      if (thin) {
        report.probe = { ok: true, note: 'thin_client — no local engine to probe; the remote brain serves this machine' };
      } else if (!cfg) {
        report.probe = { ok: false, diagnosis: report.config_diagnosis };
      } else {
        report.probe = await probeSafely(cfg.engine ?? 'postgres', toEngineConfig(cfg), dataDir, url, source, brainId);
      }
    }
  }

  const exitCode = report.config_diagnosis || report.probe?.ok === false ? 1 : 0;

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return exitCode;
  }

  printHuman(report);
  return exitCode;
}

async function probeSafely(
  engineKind: 'postgres' | 'pglite',
  engineConfig: import('../core/types.ts').EngineConfig,
  dataDir: string | null,
  url: string | null,
  source: PgDbUrlSource,
  brainId: string,
): Promise<ProbeResult> {
  try {
    return await runProbe(engineKind, engineConfig, dataDir);
  } catch (e) {
    return { ok: false, diagnosis: classifyPgAccessError(e, { url, source, brainId }) };
  }
}

function printHuman(r: EngineStatusReport): void {
  const lines: string[] = [];
  lines.push(`Brain:   ${r.brain_id}`);
  lines.push(`Engine:  ${r.effective_engine ?? '(not configured)'}${r.config_file_engine && r.config_file_engine !== r.effective_engine ? ` (config file says ${r.config_file_engine} — an env URL is overriding it)` : ''}`);
  lines.push(`Source:  ${r.db_url_source ?? '(none)'}${r.thin_client ? ' [thin client]' : ''}`);
  if (r.database_url) lines.push(`URL:     ${r.database_url}`);
  if (r.database_path) lines.push(`Path:    ${r.database_path}`);
  if (r.env.note) lines.push(`Env:     ${r.env.note}`);
  if (r.pooler) {
    lines.push(
      `Pooler:  supabase=${r.pooler.supabase_pooler} prepare=${String(r.pooler.prepare)} pool=${r.pooler.pool_size}` +
      `${r.pooler.direct_pool_disabled ? ' direct-pool=DISABLED' : ''}`,
    );
  }
  if (r.pglite_lock?.held) {
    lines.push(`Lock:    held by live ${r.pglite_lock.serve ? 'serve' : r.pglite_lock.subcommand ?? 'process'} (pid ${r.pglite_lock.pid ?? '?'})`);
  }
  if (r.config_diagnosis) {
    lines.push(`Status:  ${r.config_diagnosis.reason} — ${r.config_diagnosis.remediation}`);
  }
  if (r.probe) {
    if (r.probe.ok) {
      lines.push(`Probe:   ok${r.probe.note ? ` (${r.probe.note})` : ''}${r.probe.latency_ms !== undefined ? ` ${r.probe.latency_ms}ms` : ''}`);
    } else if (r.probe.diagnosis) {
      lines.push(`Probe:   FAIL ${r.probe.diagnosis.reason} — ${r.probe.diagnosis.remediation}`);
    } else {
      // Diagnosis-less failures (e.g. data_dir_missing, lock_unreadable)
      // must still SAY why — a silent nonzero exit reads as a healthy block.
      lines.push(`Probe:   FAIL${r.probe.note ? ` (${r.probe.note})` : ''}`);
    }
  }
  console.log(lines.join('\n'));
}
