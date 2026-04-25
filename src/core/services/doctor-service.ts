import type { BrainEngine } from '../engine.ts';
import { loadConfig, type MBrainConfig } from '../config.ts';
import { buildExecutionEnvelope } from '../execution-envelope.ts';
import { supportsRawPostgresAccess } from '../engine-factory.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { resolveOfflineProfile, type OfflineProfile } from '../offline-profile.ts';
import type { BrainHealth, BrainStats } from '../types.ts';
import * as db from '../db.ts';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface DoctorReport {
  status: 'healthy' | 'unhealthy';
  checks: DoctorCheck[];
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

export function buildDoctorReport(input: DoctorInputs): DoctorReport {
  const checks: DoctorCheck[] = [];

  if (!input.connectionOk) {
    checks.push({
      name: 'connection',
      status: 'fail',
      message: input.connectionError || 'Unknown connection error',
    });
    return {
      status: 'unhealthy',
      checks,
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

  return {
    status: checks.some((check) => check.status === 'fail') ? 'unhealthy' : 'healthy',
    checks,
  };
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

  return lines.join('\n');
}

export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some((check) => check.status === 'fail') ? 1 : 0;
}
