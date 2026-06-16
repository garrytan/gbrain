import type { BrainEngine } from '../engine.ts';
import { loadConfig, type MBrainConfig } from '../config.ts';
import { buildExecutionEnvelope } from '../execution-envelope.ts';
import { supportsRawPostgresAccess } from '../engine-factory.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { resolveOfflineProfile, type OfflineProfile } from '../offline-profile.ts';
import {
  formatRuntimeDatabaseIdentity,
  resolvePostgresRuntimeProfile,
} from '../postgres-runtime/connection-profile.ts';
import type { BrainHealth, BrainStats } from '../types.ts';
import type { AgentTrustExplainReport } from '../types/agent-trust-explain.ts';
import type { InstalledAgentReadinessReport } from './installed-agent-readiness-service.ts';
import { readSyncWatchFailure, type SyncWatchFailure } from '../health-beacon.ts';
import { loadSubbrainRegistry } from '../subbrains.ts';
import { MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD } from './memory-review-report-service.ts';
import * as db from '../db.ts';
import { spawnSync } from 'child_process';

// Stop counting staged candidates past this point; doctor only needs to know
// the backlog is large, not its exact size.
const INBOX_BACKLOG_SCAN_LIMIT = 200;
// A configured sync that has not succeeded in this many days is stale.
const SYNC_RECENCY_WARN_DAYS = 7;
// Autopilot is normally daily; allow slack before warning on a missed cycle.
const AUTOPILOT_RECENCY_WARN_HOURS = 36;
// A serve process older than this likely predates the current code/config:
// MCP servers hold both in memory from the moment they start (2026-06-12
// incident: week-old serve processes replayed an already-fixed regression).
const STALE_SERVE_PROCESS_AGE_SECONDS = 48 * 60 * 60;
// More simultaneous serve processes than this suggests leaked MCP servers.
const SERVE_PROCESS_COUNT_WARN_THRESHOLD = 4;

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface DoctorReport {
  status: 'healthy' | 'unhealthy';
  checks: DoctorCheck[];
  agent_explain?: AgentTrustExplainReport;
}

export interface DoctorAutopilotCycleSummary {
  id: string;
  status: string;
  failure_class: string | null;
  last_error: string | null;
  updated_at: string | null;
  finished_at: string | null;
}

export interface DoctorInputs {
  connectionOk: boolean;
  connectionError?: string;
  now?: string | Date;
  stats?: BrainStats;
  config: MBrainConfig | null;
  profile: OfflineProfile | null;
  rawPostgresChecksSupported: boolean;
  pgvector?: { status: 'ok' | 'warn' | 'fail'; message: string };
  rls?: { status: 'ok' | 'warn' | 'fail'; message: string };
  schemaVersion?: string | null;
  latestVersion: number;
  health?: BrainHealth;
  installedAgent?: InstalledAgentReadinessReport;
  agentExplain?: AgentTrustExplainReport;
  systemOfRecord?: {
    pending_reconcile: number;
    failed: number;
    conflict?: number;
  };
  memoryRuntime?: {
    queue_depth: number;
    failed_jobs: number;
    dead_jobs: number;
    stuck_locks: number;
    unavailable_runners: number;
    unhealthy_connectors: number;
    credential_warnings: number;
    prompt_injection_safety_count: number;
    purge_candidates: number;
    autopilot_stuck_jobs?: number;
    autopilot_last_cycle?: DoctorAutopilotCycleSummary | null;
  };
  syncRecency?: {
    configured: boolean;
    last_run: string | null;
    days_since: number | null;
  };
  syncWatchFailure?: SyncWatchFailure | null;
  memoryInboxBacklog?: {
    staged_for_review: number;
    capped: boolean;
    threshold: number;
  };
  serveProcesses?: ServeProcessInfo[];
}

export interface ServeProcessInfo {
  pid: number;
  elapsed_seconds: number | null;
  command: string;
}

interface DoctorServiceDeps {
  getConnection: typeof db.getConnection;
  loadConfig: typeof loadConfig;
  resolveOfflineProfile: typeof resolveOfflineProfile;
  supportsRawPostgresAccess: typeof supportsRawPostgresAccess;
}

const DEFAULT_DEPS: DoctorServiceDeps = {
  getConnection: db.getConnection,
  loadConfig,
  resolveOfflineProfile,
  supportsRawPostgresAccess,
};

export async function collectDoctorInputs(
  engine: BrainEngine,
  deps: DoctorServiceDeps = DEFAULT_DEPS,
): Promise<DoctorInputs> {
  const config = deps.loadConfig();
  const profile = config ? deps.resolveOfflineProfile(config) : null;

  try {
    const stats = await engine.getStats();
    const inputs: DoctorInputs = {
      connectionOk: true,
      stats,
      config,
      profile,
      rawPostgresChecksSupported: !!config && deps.supportsRawPostgresAccess(config),
      latestVersion: LATEST_VERSION,
    };

    if (inputs.rawPostgresChecksSupported) {
      inputs.pgvector = await checkPgVector(deps);
      inputs.rls = await checkRls(deps);
      inputs.systemOfRecord = await checkSystemOfRecordHealth(deps);
      inputs.memoryRuntime = await checkMemoryRuntimeHealth(deps);
    }

    try {
      inputs.schemaVersion = await engine.getConfig('version');
    } catch {
      inputs.schemaVersion = undefined;
    }

    try {
      inputs.health = await engine.getHealth();
    } catch {
      inputs.health = undefined;
    }

    try {
      inputs.syncRecency = await collectSyncRecency(engine);
    } catch {
      inputs.syncRecency = undefined;
    }

    inputs.syncWatchFailure = readSyncWatchFailure();
    inputs.serveProcesses = collectServeProcesses();

    try {
      const staged = await engine.listMemoryCandidateEntries({
        status: 'staged_for_review',
        limit: INBOX_BACKLOG_SCAN_LIMIT,
        offset: 0,
      });
      inputs.memoryInboxBacklog = {
        staged_for_review: staged.length,
        capped: staged.length >= INBOX_BACKLOG_SCAN_LIMIT,
        threshold: MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD,
      };
    } catch {
      inputs.memoryInboxBacklog = undefined;
    }

    return inputs;
  } catch (error: unknown) {
    return {
      connectionOk: false,
      connectionError: error instanceof Error ? error.message : String(error),
      config,
      profile,
      rawPostgresChecksSupported: false,
      latestVersion: LATEST_VERSION,
      serveProcesses: collectServeProcesses(),
    };
  }
}

/** Parse `ps` etime ([[dd-]hh:]mm:ss) into seconds; null when unparseable. */
export function parseEtimeSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (days ? parseInt(days, 10) * 86400 : 0)
    + (hours ? parseInt(hours, 10) * 3600 : 0)
    + parseInt(minutes!, 10) * 60
    + parseInt(seconds!, 10);
}

/** Extract mbrain serve rows from `ps -axo pid=,etime=,args=` output. */
export function parseServeProcessTable(psOutput: string, selfPid?: number): ServeProcessInfo[] {
  const rows: ServeProcessInfo[] = [];
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = parseInt(match[1]!, 10);
    const command = match[3]!;
    if (selfPid !== undefined && pid === selfPid) continue;
    // Match only real mbrain MCP servers: the mbrain binary or its cli.ts
    // entrypoint immediately followed by the `serve` subcommand. A looser
    // "mbrain anywhere + serve anywhere" check false-positives on dev servers
    // (e.g. `webpack serve`) launched from a directory named mbrain.
    if (!/(?:^|[\s/])mbrain\s+serve\b/.test(command) && !/cli\.ts\s+serve\b/.test(command)) continue;
    if (/\bgrep\b/.test(command)) continue;
    rows.push({ pid, elapsed_seconds: parseEtimeSeconds(match[2]!), command });
  }
  return rows;
}

function collectServeProcesses(): ServeProcessInfo[] | undefined {
  try {
    const result = spawnSync('ps', ['-axo', 'pid=,etime=,args='], { encoding: 'utf-8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    return parseServeProcessTable(result.stdout, process.pid);
  } catch {
    return undefined;
  }
}

function formatProcessAge(seconds: number | null): string {
  if (seconds === null) return 'unknown age';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function buildServeProcessCheck(processes: ServeProcessInfo[]): DoctorCheck {
  if (processes.length === 0) {
    return { name: 'serve_processes', status: 'ok', message: 'No mbrain serve processes running' };
  }
  const stale = processes.filter(
    (proc) => (proc.elapsed_seconds ?? 0) >= STALE_SERVE_PROCESS_AGE_SECONDS,
  );
  if (stale.length > 0) {
    const listed = stale
      .map((proc) => `pid ${proc.pid} (${formatProcessAge(proc.elapsed_seconds)})`)
      .join(', ');
    return {
      name: 'serve_processes',
      status: 'warn',
      message: `${processes.length} serve process(es) running; ${stale.length} stale (>48h): ${listed}. Stale servers hold the code and config they started with — restart your agent clients (Claude Code/Codex) to relaunch them.`,
    };
  }
  if (processes.length > SERVE_PROCESS_COUNT_WARN_THRESHOLD) {
    return {
      name: 'serve_processes',
      status: 'warn',
      message: `${processes.length} mbrain serve processes running (expected at most ${SERVE_PROCESS_COUNT_WARN_THRESHOLD}) — likely leaked MCP servers; restart your agent clients (Claude Code/Codex).`,
    };
  }
  const oldest = processes.reduce<number | null>(
    (max, proc) => (proc.elapsed_seconds !== null && (max === null || proc.elapsed_seconds > max)
      ? proc.elapsed_seconds
      : max),
    null,
  );
  return {
    name: 'serve_processes',
    status: 'ok',
    message: `${processes.length} mbrain serve process(es) running (oldest ${formatProcessAge(oldest)})`,
  };
}

async function collectSyncRecency(engine: BrainEngine): Promise<DoctorInputs['syncRecency']> {
  const legacyRepoPath = await engine.getConfig('sync.repo_path');
  const registry = await loadSubbrainRegistry(engine);
  const subbrainIds = Object.keys(registry.subbrains);
  const configured = !!legacyRepoPath || subbrainIds.length > 0;
  if (!configured) {
    return { configured: false, last_run: null, days_since: null };
  }

  const lastRuns = (await Promise.all([
    engine.getConfig('sync.last_run'),
    ...subbrainIds.map((id) => engine.getConfig(`sync.subbrains.${id}.last_run`)),
  ])).filter((value): value is string => !!value);

  const latest = lastRuns
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)[0] ?? null;

  return {
    configured: true,
    last_run: latest?.value ?? null,
    days_since: latest ? Math.max(0, Math.floor((Date.now() - latest.time) / 86_400_000)) : null,
  };
}

async function checkPgVector(deps: DoctorServiceDeps): Promise<{ status: 'ok' | 'warn' | 'fail'; message: string }> {
  try {
    const sql = deps.getConnection();
    const extensions = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (extensions.length > 0) {
      return { status: 'ok', message: 'Extension installed' };
    }
    return { status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' };
  } catch {
    return { status: 'warn', message: 'Could not check pgvector extension' };
  }
}

async function checkRls(deps: DoctorServiceDeps): Promise<{ status: 'ok' | 'warn' | 'fail'; message: string }> {
  try {
    const sql = deps.getConnection();
    const tables = await sql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                           'page_versions','timeline_entries','ingest_log','config','files')
    `;
    const noRls = tables.filter((table: any) => !table.rowsecurity);
    if (noRls.length === 0) {
      return { status: 'ok', message: 'RLS enabled on configured core tables' };
    }
    const names = noRls.map((table: any) => table.tablename).join(', ');
    return { status: 'warn', message: `RLS not enabled on: ${names}` };
  } catch {
    return { status: 'warn', message: 'Could not check RLS status' };
  }
}

async function checkSystemOfRecordHealth(
  deps: DoctorServiceDeps,
): Promise<{ pending_reconcile: number; failed: number; conflict: number } | undefined> {
  try {
    const sql = deps.getConnection();
    const tableRows = await sql`
      SELECT to_regclass('canonical_projection_targets') AS table_name
    `;
    if (!tableRows[0]?.table_name) return undefined;

    const rows = await sql`
      SELECT status, count(*)::int AS count
      FROM canonical_projection_targets
      WHERE status IN ('pending_reconcile', 'failed', 'conflict')
      GROUP BY status
    `;
    return {
      pending_reconcile: projectionStatusCount(rows as Array<Record<string, unknown>>, 'pending_reconcile'),
      failed: projectionStatusCount(rows as Array<Record<string, unknown>>, 'failed'),
      conflict: projectionStatusCount(rows as Array<Record<string, unknown>>, 'conflict'),
    };
  } catch {
    return undefined;
  }
}

function projectionStatusCount(rows: Array<Record<string, unknown>>, status: string): number {
  const row = rows.find((candidate) => candidate.status === status);
  return Number(row?.count ?? 0);
}

async function checkMemoryRuntimeHealth(
  deps: DoctorServiceDeps,
): Promise<NonNullable<DoctorInputs['memoryRuntime']> | undefined> {
  try {
    return {
      queue_depth: await countTableRows(deps, 'memory_jobs', "status IN ('waiting', 'delayed', 'active')"),
      failed_jobs: await countTableRows(deps, 'memory_jobs', "status = 'failed'"),
      dead_jobs: await countTableRows(deps, 'memory_jobs', "status = 'dead'"),
      stuck_locks: await countTableRows(deps, 'memory_jobs', "status = 'active' AND lock_expires_at <= now()")
        + await countTableRows(deps, 'memory_cycle_locks', 'ttl_expires_at < now()'),
      unavailable_runners: await countTableRows(deps, 'runner_jobs', "status IN ('failed', 'degraded')"),
      unhealthy_connectors: await countTableRows(
        deps,
        'connector_sync_states',
        "health_status IN ('unhealthy', 'revoked')",
      ),
      credential_warnings: await countTableRows(
        deps,
        'credential_refs',
        "health_status IN ('unhealthy', 'expired') OR rotation_status IN ('rotation_due', 'revoked')",
      ),
      prompt_injection_safety_count: await countTableRows(deps, 'prompt_injection_flags', "risk IN ('flagged', 'quarantined')"),
      purge_candidates: await countTableRows(
        deps,
        'purge_plan_items',
        "status IN ('planned', 'approved')",
      ),
      autopilot_stuck_jobs: await countTableRows(
        deps,
        'memory_jobs',
        "name IN ('autopilot_cycle', 'autopilot-cycle') AND status = 'active' AND lock_expires_at <= now()",
      ),
      autopilot_last_cycle: await collectAutopilotLastCycle(deps),
    };
  } catch {
    return undefined;
  }
}

async function collectAutopilotLastCycle(deps: DoctorServiceDeps): Promise<DoctorAutopilotCycleSummary | null> {
  const sql = deps.getConnection();
  try {
    const tableRows = await sql`SELECT to_regclass('memory_jobs') AS table_name`;
    if (!tableRows[0]?.table_name) return null;
    const rows = await sql`
      SELECT id, status, failure_class, last_error,
             updated_at::text AS updated_at,
             finished_at::text AS finished_at
      FROM memory_jobs
      WHERE name IN ('autopilot_cycle', 'autopilot-cycle')
        AND status IN ('completed', 'failed', 'dead', 'cancelled')
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: stringOrEmpty(row.id),
      status: stringOrEmpty(row.status),
      failure_class: stringOrNull(row.failure_class),
      last_error: stringOrNull(row.last_error),
      updated_at: stringOrNull(row.updated_at),
      finished_at: stringOrNull(row.finished_at),
    };
  } catch {
    return null;
  }
}

async function countTableRows(
  deps: DoctorServiceDeps,
  tableName: string,
  whereClause: string,
): Promise<number> {
  const sql = deps.getConnection();
  try {
    const tableRows = await sql`SELECT to_regclass(${tableName}) AS table_name`;
    if (!tableRows[0]?.table_name) return 0;
    const rows = await queryCount(sql, tableName, whereClause);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

function queryCount(
  sql: ReturnType<DoctorServiceDeps['getConnection']>,
  tableName: string,
  whereClause: string,
): Promise<Array<{ count: number }>> {
  if (tableName === 'memory_jobs' && whereClause === "status IN ('waiting', 'delayed', 'active')") {
    return sql`SELECT count(*)::int AS count FROM memory_jobs WHERE status IN ('waiting', 'delayed', 'active')`;
  }
  if (tableName === 'memory_jobs' && whereClause === "status = 'failed'") {
    return sql`SELECT count(*)::int AS count FROM memory_jobs WHERE status = 'failed'`;
  }
  if (tableName === 'memory_jobs' && whereClause === "status = 'dead'") {
    return sql`SELECT count(*)::int AS count FROM memory_jobs WHERE status = 'dead'`;
  }
  if (
    tableName === 'memory_jobs'
    && whereClause === "name IN ('autopilot_cycle', 'autopilot-cycle') AND status = 'active' AND lock_expires_at <= now()"
  ) {
    return sql`
      SELECT count(*)::int AS count
      FROM memory_jobs
      WHERE name IN ('autopilot_cycle', 'autopilot-cycle')
        AND status = 'active'
        AND lock_expires_at <= now()
    `;
  }
  if (tableName === 'memory_jobs' && whereClause === "status = 'active' AND lock_expires_at <= now()") {
    return sql`SELECT count(*)::int AS count FROM memory_jobs WHERE status = 'active' AND lock_expires_at <= now()`;
  }
  if (tableName === 'memory_cycle_locks') {
    return sql`SELECT count(*)::int AS count FROM memory_cycle_locks WHERE ttl_expires_at < now()`;
  }
  if (tableName === 'runner_jobs') {
    return sql`SELECT count(*)::int AS count FROM runner_jobs WHERE status IN ('failed', 'degraded')`;
  }
  if (tableName === 'connector_sync_states') {
    return sql`SELECT count(*)::int AS count FROM connector_sync_states WHERE health_status IN ('unhealthy', 'revoked')`;
  }
  if (tableName === 'credential_refs') {
    return sql`
      SELECT count(*)::int AS count
      FROM credential_refs
      WHERE health_status IN ('unhealthy', 'expired')
         OR rotation_status IN ('rotation_due', 'revoked')
    `;
  }
  if (tableName === 'prompt_injection_flags') {
    return sql`SELECT count(*)::int AS count FROM prompt_injection_flags WHERE risk IN ('flagged', 'quarantined')`;
  }
  if (tableName === 'purge_plan_items') {
    return sql`SELECT count(*)::int AS count FROM purge_plan_items WHERE status IN ('planned', 'approved')`;
  }
  return Promise.resolve([{ count: 0 }]);
}

export function buildDoctorReport(input: DoctorInputs): DoctorReport {
  const checks: DoctorCheck[] = [];

  if (!input.connectionOk) {
    checks.push({
      name: 'connection',
      status: 'fail',
      message: input.connectionError || 'Unknown connection error',
    });
    if (input.serveProcesses !== undefined) {
      checks.push(buildServeProcessCheck(input.serveProcesses));
    }
    appendInstalledAgentChecks(checks, input.installedAgent);
    return {
      status: 'unhealthy',
      checks,
      ...doctorAgentExplainField(input.agentExplain),
    };
  }

  checks.push({
    name: 'connection',
    status: 'ok',
    message: `Connected, ${input.stats?.page_count ?? 0} pages`,
  });

  if (input.config && input.profile) {
    checks.push({ name: 'engine', status: 'ok', message: input.config.engine });
    checks.push({
      name: 'embedding_provider',
      status: input.profile.embedding.available ? 'ok' : 'warn',
      message: `${input.profile.embedding.mode}${input.profile.embedding.reason ? ` — ${input.profile.embedding.reason}` : ''}`,
    });
    checks.push({
      name: 'query_rewrite_provider',
      status: input.profile.rewrite.available ? 'ok' : 'warn',
      message: `${input.profile.rewrite.mode}${input.profile.rewrite.reason ? ` — ${input.profile.rewrite.reason}` : ''}`,
    });
    const envelope = buildExecutionEnvelope(input.config);
    const offlineProfileMessage = envelope.mode === 'local_offline'
      ? 'local/offline profile active (enabled)'
      : 'cloud-connected profile active';
    checks.push({
      name: 'offline_profile',
      status: envelope.mode === 'local_offline' ? 'ok' : 'warn',
      message: offlineProfileMessage,
    });
    checks.push({
      name: 'execution_envelope',
      status: 'ok',
      message: `${envelope.mode}; baseline families: ${envelope.baselineFamilies.join(', ')}`,
    });

    const unsupportedContractSurfaces = Object.entries(envelope.publicContract)
      .filter(([, surface]) => surface.status === 'unsupported')
      .map(([name, surface]) => `${name}: ${surface.reason}`);

    checks.push({
      name: 'contract_surface',
      status: unsupportedContractSurfaces.length > 0 ? 'warn' : 'ok',
      message: unsupportedContractSurfaces.length > 0
        ? unsupportedContractSurfaces.join('; ')
        : 'All Phase 0 contract surfaces supported',
    });

    const unsupported = Object.entries(envelope.publicContract)
      .filter(([, surface]) => surface.status === 'unsupported')
      .map(([name, surface]) => `${name === 'files' ? 'file/storage' : 'check-update'}: ${surface.reason}`);

    checks.push({
      name: 'unsupported_capabilities',
      status: unsupported.length > 0 ? 'warn' : 'ok',
      message: unsupported.length > 0 ? unsupported.join('; ') : 'None',
    });
  }

  if (input.config?.engine === 'postgres') {
    checks.push({
      name: 'target_runtime',
      status: 'ok',
      message: 'Postgres target runtime active',
    });
    try {
      const runtimeProfile = resolvePostgresRuntimeProfile(input.config);
      checks.push({
        name: 'runtime_db_identity',
        status: 'ok',
        message: formatRuntimeDatabaseIdentity(runtimeProfile),
      });
    } catch (error: unknown) {
      checks.push({
        name: 'runtime_db_identity',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (input.config) {
    checks.push({
      name: 'target_runtime',
      status: 'warn',
      message: `${input.config.engine} is a legacy local runtime; migrate to Postgres for target runtime features`,
    });
  }

  if (input.rawPostgresChecksSupported) {
    if (input.pgvector) {
      checks.push({ name: 'pgvector', status: input.pgvector.status, message: input.pgvector.message });
    }
    if (input.rls) {
      checks.push({ name: 'rls', status: input.rls.status, message: input.rls.message });
    }
  } else {
    const engineName = input.config?.engine || 'current';
    checks.push({
      name: 'pgvector',
      status: 'ok',
      message: `Not applicable: pgvector check is managed Postgres-only for ${engineName} mode`,
    });
    checks.push({
      name: 'rls',
      status: 'ok',
      message: `Not applicable: RLS check is managed Postgres-only for ${engineName} mode`,
    });
  }

  if (input.schemaVersion === undefined) {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  } else {
    const version = parseInt(input.schemaVersion || '0', 10);
    if (version >= input.latestVersion) {
      checks.push({
        name: 'schema_version',
        status: 'ok',
        message: `Version ${version} (latest: ${input.latestVersion})`,
      });
    } else {
      checks.push({
        name: 'schema_version',
        status: 'warn',
        message: `Version ${version}, latest is ${input.latestVersion}. Run mbrain init to migrate.`,
      });
    }
  }

  if (!input.health) {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  } else {
    const pct = (input.health.embed_coverage * 100).toFixed(0);
    if (input.health.embed_coverage >= 0.9) {
      checks.push({
        name: 'embeddings',
        status: 'ok',
        message: `${pct}% coverage, ${input.health.missing_embeddings} missing`,
      });
    } else if (input.health.embed_coverage > 0) {
      checks.push({
        name: 'embeddings',
        status: 'warn',
        message: `${pct}% coverage, ${input.health.missing_embeddings} missing. Run: mbrain embed --stale`,
      });
    } else {
      checks.push({
        name: 'embeddings',
        status: 'warn',
        message: 'No embeddings yet. Run: mbrain embed --stale',
      });
    }
  }

  if (input.syncRecency?.configured) {
    const { last_run, days_since } = input.syncRecency;
    if (!last_run) {
      checks.push({
        name: 'sync_recency',
        status: 'warn',
        message: "Sync is configured but no successful run is recorded. Run: mbrain sync",
      });
    } else if (days_since !== null && days_since > SYNC_RECENCY_WARN_DAYS) {
      checks.push({
        name: 'sync_recency',
        status: 'warn',
        message: `Last successful sync was ${days_since} days ago (${last_run}). Run: mbrain sync`,
      });
    } else {
      checks.push({
        name: 'sync_recency',
        status: 'ok',
        message: days_since === 0 ? 'Last successful sync: today' : `Last successful sync: ${days_since} day(s) ago`,
      });
    }
  }

  if (input.syncWatchFailure) {
    checks.push({
      name: 'sync_watch',
      status: 'warn',
      message: `Live sync watcher stopped at ${input.syncWatchFailure.stopped_at} after ${input.syncWatchFailure.consecutive_failures} consecutive failures: ${input.syncWatchFailure.reason}. Restart with: mbrain sync --watch (or dismiss with: mbrain sync --clear-failure)`,
    });
  }

  if (input.memoryInboxBacklog) {
    const backlog = input.memoryInboxBacklog;
    const countLabel = backlog.capped ? `${backlog.staged_for_review}+` : `${backlog.staged_for_review}`;
    checks.push({
      name: 'memory_inbox_backlog',
      status: backlog.staged_for_review >= backlog.threshold ? 'warn' : 'ok',
      message: backlog.staged_for_review >= backlog.threshold
        ? `${countLabel} candidates staged for review (threshold ${backlog.threshold}). Review them via 'mbrain memory-report' before the backlog drifts.`
        : `${countLabel} candidates staged for review (threshold ${backlog.threshold})`,
    });
  }

  if (input.systemOfRecord) {
    const pending = input.systemOfRecord.pending_reconcile;
    const failed = input.systemOfRecord.failed;
    const conflict = input.systemOfRecord.conflict ?? 0;
    const parts = [
      `${pending} pending reconcile`,
      `${failed} failed projection`,
      ...(conflict > 0 ? [`${conflict} conflict`] : []),
    ];
    checks.push({
      name: 'system_of_record',
      status: pending > 0 || failed > 0 || conflict > 0 ? 'warn' : 'ok',
      message: parts.join(', '),
    });
  }

  if (input.memoryRuntime) {
    const runtime = input.memoryRuntime;
    const parts = [
      `${runtime.queue_depth} queued`,
      `${runtime.failed_jobs} failed jobs`,
      `${runtime.dead_jobs} dead jobs`,
      `${runtime.stuck_locks} stuck locks`,
      `${runtime.unavailable_runners} unavailable runners`,
      `${runtime.unhealthy_connectors} unhealthy connectors`,
      `${runtime.credential_warnings} credential warnings`,
      `${runtime.prompt_injection_safety_count} prompt-injection safety flag${runtime.prompt_injection_safety_count === 1 ? '' : 's'}`,
      `${runtime.purge_candidates} purge candidates`,
    ];
    checks.push({
      name: 'memory_runtime',
      status: runtime.dead_jobs > 0 || runtime.stuck_locks > 0 ? 'fail'
        : runtime.failed_jobs > 0
          || runtime.unavailable_runners > 0
          || runtime.unhealthy_connectors > 0
          || runtime.credential_warnings > 0
          || runtime.prompt_injection_safety_count > 0
          ? 'warn'
          : 'ok',
      message: parts.join(', '),
    });
  }

  const autopilotCheck = buildAutopilotCheck(input);
  if (autopilotCheck) checks.push(autopilotCheck);

  if (input.serveProcesses !== undefined) {
    checks.push(buildServeProcessCheck(input.serveProcesses));
  }

  appendInstalledAgentChecks(checks, input.installedAgent);

  return {
    status: checks.some((check) => check.status === 'fail') ? 'unhealthy' : 'healthy',
    checks,
    ...doctorAgentExplainField(input.agentExplain),
  };
}

function buildAutopilotCheck(input: DoctorInputs): DoctorCheck | null {
  const runtime = input.memoryRuntime;
  if (!runtime) return null;
  const enabled = isAutopilotEnabled(input.config);
  const nowMs = doctorNowMs(input);
  const stuckJobs = runtime.autopilot_stuck_jobs ?? 0;
  const lastCycle = runtime.autopilot_last_cycle ?? null;
  if (!enabled && stuckJobs === 0 && !lastCycle) return null;

  const parts = [enabled ? 'enabled' : 'not enabled'];
  if (lastCycle) {
    const observedAt = autopilotCycleObservedAt(lastCycle);
    const ageMs = observedAt ? Math.max(0, nowMs - observedAt.getTime()) : null;
    parts.push(
      `last cycle ${lastCycle.status || 'unknown'} (${lastCycle.id || 'unknown'})`
      + (observedAt ? ` at ${observedAt.toISOString()} (${formatAutopilotAge(ageMs)} ago)` : ''),
    );
    if (lastCycle.failure_class) parts.push(`failure ${lastCycle.failure_class}`);
    if (lastCycle.last_error) parts.push(lastCycle.last_error);
    if (enabled && lastCycle.status === 'completed') {
      if (!observedAt) {
        parts.push('last successful cycle timestamp is unavailable');
      } else if (isAutopilotCompletedCycleStale(lastCycle, nowMs)) {
        parts.push(`last successful cycle is stale (>${AUTOPILOT_RECENCY_WARN_HOURS}h)`);
      }
    }
  } else {
    parts.push('last cycle not recorded');
  }
  if (stuckJobs > 0) {
    parts.push(`${stuckJobs} stuck autopilot job${stuckJobs === 1 ? '' : 's'}`);
  }

  return {
    name: 'autopilot',
    status: autopilotStatus(enabled, stuckJobs, lastCycle, nowMs),
    message: parts.join(', '),
  };
}

function autopilotStatus(
  enabled: boolean,
  stuckJobs: number,
  lastCycle: DoctorAutopilotCycleSummary | null,
  nowMs: number,
): DoctorCheck['status'] {
  if (stuckJobs > 0 || lastCycle?.status === 'dead') return 'fail';
  if (lastCycle?.status === 'failed' || lastCycle?.status === 'cancelled') return 'warn';
  if (enabled && lastCycle?.status === 'completed' && isAutopilotCompletedCycleStale(lastCycle, nowMs)) return 'warn';
  if (enabled && !lastCycle) return 'warn';
  return 'ok';
}

function isAutopilotCompletedCycleStale(lastCycle: DoctorAutopilotCycleSummary, nowMs: number): boolean {
  const observedAt = autopilotCycleObservedAt(lastCycle);
  if (!observedAt) return true;
  return nowMs - observedAt.getTime() > AUTOPILOT_RECENCY_WARN_HOURS * 60 * 60 * 1000;
}

function doctorNowMs(input: Pick<DoctorInputs, 'now'>): number {
  if (!input.now) return Date.now();
  const value = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);
  return Number.isFinite(value) ? value : Date.now();
}

function autopilotCycleObservedAt(lastCycle: DoctorAutopilotCycleSummary): Date | null {
  const value = lastCycle.finished_at ?? lastCycle.updated_at;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAutopilotAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown';
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (minutes >= 60 * 48) {
    const days = Math.floor(minutes / (60 * 24));
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function isAutopilotEnabled(config: MBrainConfig | null): boolean {
  const autopilot = (config as (MBrainConfig & { autopilot?: { enabled?: unknown } }) | null)?.autopilot;
  return autopilot?.enabled === true;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function appendInstalledAgentChecks(
  checks: DoctorCheck[],
  installedAgent: InstalledAgentReadinessReport | undefined,
) {
  if (!installedAgent) return;

  for (const check of installedAgent.checks) {
    checks.push({
      name: `agent:${check.name}`,
      status: check.status,
      message: check.message,
    });
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['', 'MBrain Health Check', '==================='];
  for (const check of report.checks) {
    const icon = check.status === 'ok' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`  [${icon}] ${check.name}: ${check.message}`);
  }

  const hasFail = report.checks.some((check) => check.status === 'fail');
  const hasWarn = report.checks.some((check) => check.status === 'warn');
  if (hasFail) {
    lines.push('', 'Failed checks found. Fix the issues above.');
  } else if (hasWarn) {
    lines.push('', 'All checks OK (some warnings).');
  } else {
    lines.push('', 'All checks passed.');
  }

  if (report.agent_explain) {
    const explain = report.agent_explain;
    const proof = explain.proof;
    lines.push(
      '',
      'Agent Trust Explain',
      '===================',
      `  Installed: command ${explain.installed_surface.command}; MCP ${formatList(explain.installed_surface.mcp_registrations)}; prompt rules ${explain.installed_surface.prompt_rules_version ?? 'missing'}; Claude hook ${explain.installed_surface.claude_stop_hook}`,
      `  Answer authority: ${explain.memory_behavior.answer_authority.join('; ')}`,
      `  Hints only: ${explain.memory_behavior.hint_only_surfaces.join('; ')}`,
      `  Writes: ${explain.memory_behavior.writeback_route}; canonical writes require ${explain.memory_behavior.canonical_write_requirements.join(' + ')}`,
      `  read_context evidence boundary: ${explain.memory_behavior.read_context_evidence_boundary}`,
      `  Graph frontier: ${explain.memory_behavior.graph_frontier_default}`,
      `  Proof: ${proof.status}; ${proof.scenarios.length} scenarios; ${proof.authority_violations} authority violations; ${proof.mutations} mutations`,
      `  Next: ${explain.next_actions.join('; ')}`,
      `  Limits: ${explain.limitations.join('; ')}`,
    );
  }

  return lines.join('\n');
}

function doctorAgentExplainField(
  explain: AgentTrustExplainReport | undefined,
): Pick<DoctorReport, 'agent_explain'> {
  return explain ? { agent_explain: explain } : {};
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'not checked';
}

export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some((check) => check.status === 'fail') ? 1 : 0;
}
