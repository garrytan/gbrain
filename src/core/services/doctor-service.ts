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
import * as db from '../db.ts';

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

export interface DoctorInputs {
  connectionOk: boolean;
  connectionError?: string;
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
    quarantine_count: number;
    purge_candidates: number;
  };
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

    return inputs;
  } catch (error: unknown) {
    return {
      connectionOk: false,
      connectionError: error instanceof Error ? error.message : String(error),
      config,
      profile,
      rawPostgresChecksSupported: false,
      latestVersion: LATEST_VERSION,
    };
  }
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
      return { status: 'ok', message: 'RLS enabled on all tables' };
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
      quarantine_count: await countTableRows(deps, 'prompt_injection_flags', "risk = 'quarantined'"),
      purge_candidates: await countTableRows(
        deps,
        'purge_plan_items',
        "status IN ('planned', 'approved')",
      ),
    };
  } catch {
    return undefined;
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
    return sql`SELECT count(*)::int AS count FROM prompt_injection_flags WHERE risk = 'quarantined'`;
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
      `${runtime.quarantine_count} quarantined chunks`,
      `${runtime.purge_candidates} purge candidates`,
    ];
    checks.push({
      name: 'memory_runtime',
      status: runtime.dead_jobs > 0 || runtime.stuck_locks > 0 ? 'fail'
        : runtime.failed_jobs > 0
          || runtime.unavailable_runners > 0
          || runtime.unhealthy_connectors > 0
          || runtime.credential_warnings > 0
          ? 'warn'
          : 'ok',
      message: parts.join(', '),
    });
  }

  appendInstalledAgentChecks(checks, input.installedAgent);

  return {
    status: checks.some((check) => check.status === 'fail') ? 'unhealthy' : 'healthy',
    checks,
    ...doctorAgentExplainField(input.agentExplain),
  };
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
