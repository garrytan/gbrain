import type { BrainEngine } from './engine.ts';
import {
  COMPOSIO_CONNECTORS,
  composioEnvStatus,
  getComposioIntegrationStatus,
  type ComposioIntegrationStatus,
} from './saas-integrations.ts';
import { buildSaasRuntimeManifest, type SaasRuntimeManifest } from './saas-runtime-manifest.ts';
import { listSaasSkills, type SaasSkillSummary } from './saas-skills.ts';
import type { SourceListEntry } from './sources-ops.ts';
import { VERSION } from '../version.ts';

export interface SaasQualityCheck {
  area: string;
  signal: string;
  status: string;
  detail: string;
  passed: boolean;
  remediation: string | null;
}

export interface SaasDeploymentReadiness {
  engine_kind: BrainEngine['kind'];
  production_ready: boolean;
  database: {
    configured: boolean;
    provider: 'supabase' | 'postgres' | 'invalid' | 'missing';
    host: string | null;
    ready: boolean;
  };
  public_url: {
    configured: boolean;
    origin: string | null;
    https: boolean;
    local: boolean;
    ready: boolean;
  };
  email: {
    provider: string | null;
    configured: boolean;
    from_configured: boolean;
    ready: boolean;
  };
  billing: {
    webhook_secret_configured: boolean;
    ready: boolean;
  };
  bootstrap: {
    token_configured: boolean;
    token_suppressed: boolean;
    ready: boolean;
  };
}

export interface SaasQualitySnapshot {
  schema: 'cortex.saas-quality-snapshot.v1';
  generated_at: string;
  version: string;
  readiness: {
    score: number;
    passed: number;
    total: number;
    status: 'passing' | 'needs_attention';
  };
  metrics: {
    connected_agents: number;
    active_tokens: number;
    requests_today: number;
    error_rate: string;
    source_count: number;
    connected_composio_connectors: number;
    enforced_skills: number;
    total_skills: number;
    waiting_jobs: number;
    active_jobs: number;
    failed_jobs: number;
    agent_parity_operations: number;
  };
  deployment: SaasDeploymentReadiness;
  checks: SaasQualityCheck[];
  runtime_manifest: SaasRuntimeManifest;
  integrations: ComposioIntegrationStatus;
  sources: SourceListEntry[];
  skills: SaasSkillSummary[];
}

export interface SaasQualitySnapshotInput {
  publicUrl?: string | null;
}

function countFailedJobs(counts: Record<string, number>): number {
  return (counts.failed || 0) + (counts.dead || 0) + (counts.error || 0);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseFloat(value) || 0;
  return 0;
}

async function scalarCount(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(sql, params);
  return toNumber(rows[0]?.count);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function listQualitySources(engine: BrainEngine): Promise<SourceListEntry[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, name, local_path, last_sync_at, config
       FROM sources
      WHERE archived IS NOT TRUE
      ORDER BY (id = 'default') DESC, id
      LIMIT 100`,
  );
  return rows.map((row) => {
    const config = parseJsonRecord(row.config);
    return {
      id: String(row.id),
      name: String(row.name ?? row.id),
      local_path: row.local_path == null ? null : String(row.local_path),
      remote_url: typeof config.remote_url === 'string' ? config.remote_url : null,
      federated: config.federated === true,
      page_count: 0,
      last_sync_at: row.last_sync_at == null ? null : new Date(String(row.last_sync_at)).toISOString(),
    };
  });
}

async function qualityConsoleMetrics(engine: BrainEngine) {
  const now = Math.floor(Date.now() / 1000);
  const [connectedAgents, activeTokens, jobCountRows] = await Promise.all([
    scalarCount(engine, `SELECT count(*)::int as count FROM oauth_clients WHERE deleted_at IS NULL`),
    scalarCount(engine, `SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > $1`, [now]),
    engine.executeRaw<{ status: string; count: number | string }>(
      `SELECT status, count(*)::int as count FROM minion_jobs GROUP BY status ORDER BY status`,
    ),
  ]);
  return {
    connected_agents: connectedAgents,
    active_tokens: activeTokens,
    requests_today: 0,
    error_rate: '0%',
    jobs_by_status: Object.fromEntries(jobCountRows.map(row => [String(row.status), toNumber(row.count)])),
  };
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function envFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = envValue(key);
    if (value) return value;
  }
  return undefined;
}

function isTruthy(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

function isPlaceholder(raw: string | undefined | null): boolean {
  if (!raw) return true;
  return /(<\s*(project|password|your|random|tenant|host|domain)[^>]*>|PROJECT_REF|PASSWORD|your-|example\.com|brain\.example\.com|\.\.\.)/i.test(raw);
}

function parseUrl(raw: string | undefined | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized.endsWith('.local');
}

function buildDeploymentReadiness(engine: BrainEngine, publicUrl: string | null): SaasDeploymentReadiness {
  const databaseUrl = envFirst('CORTEX_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DATABASE_URL');
  const parsedDatabaseUrl = parseUrl(databaseUrl);
  const databaseProtocolOk = parsedDatabaseUrl?.protocol === 'postgres:' || parsedDatabaseUrl?.protocol === 'postgresql:';
  const databaseHost = parsedDatabaseUrl?.hostname || null;
  const databaseProvider = !databaseUrl
    ? 'missing'
    : !databaseProtocolOk || isPlaceholder(databaseUrl)
      ? 'invalid'
      : databaseHost?.endsWith('.supabase.co') || databaseHost?.endsWith('.pooler.supabase.com')
        ? 'supabase'
        : 'postgres';
  const databaseReady = engine.kind === 'postgres' && Boolean(databaseUrl) && databaseProtocolOk && !isPlaceholder(databaseUrl);

  const parsedPublicUrl = parseUrl(publicUrl);
  const publicOrigin = parsedPublicUrl ? parsedPublicUrl.origin : publicUrl;
  const publicLocal = parsedPublicUrl ? isLocalHost(parsedPublicUrl.hostname) : false;
  const publicHttps = parsedPublicUrl?.protocol === 'https:';
  const publicReady = Boolean(publicUrl) && Boolean(parsedPublicUrl) && publicHttps && !publicLocal && !isPlaceholder(publicUrl);

  const provider = envFirst('CORTEX_EMAIL_PROVIDER');
  const emailApiKey = envFirst('CORTEX_RESEND_API_KEY', 'RESEND_API_KEY');
  const emailFrom = envFirst('CORTEX_EMAIL_FROM', 'RESEND_FROM_EMAIL', 'RESEND_FROM');
  const emailReady = provider?.toLowerCase() === 'resend' && Boolean(emailApiKey) && Boolean(emailFrom) && !isPlaceholder(emailFrom);

  const billingSecret = envFirst('CORTEX_BILLING_WEBHOOK_SECRET');
  const billingReady = Boolean(billingSecret) && !isPlaceholder(billingSecret);

  const bootstrapToken = envFirst('CORTEX_ADMIN_BOOTSTRAP_TOKEN', 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN');
  const bootstrapSuppressed = isTruthy(envFirst('CORTEX_SUPPRESS_BOOTSTRAP_TOKEN', 'GBRAIN_SUPPRESS_BOOTSTRAP_TOKEN'));
  const bootstrapReady = Boolean(bootstrapToken && bootstrapToken.length >= 32 && !isPlaceholder(bootstrapToken)) && bootstrapSuppressed;

  return {
    engine_kind: engine.kind,
    production_ready: databaseReady && publicReady && emailReady && billingReady && bootstrapReady,
    database: {
      configured: Boolean(databaseUrl),
      provider: databaseProvider,
      host: databaseHost,
      ready: databaseReady,
    },
    public_url: {
      configured: Boolean(publicUrl),
      origin: publicOrigin || null,
      https: publicHttps,
      local: publicLocal,
      ready: publicReady,
    },
    email: {
      provider: provider || null,
      configured: Boolean(emailApiKey),
      from_configured: Boolean(emailFrom),
      ready: emailReady,
    },
    billing: {
      webhook_secret_configured: Boolean(billingSecret),
      ready: billingReady,
    },
    bootstrap: {
      token_configured: Boolean(bootstrapToken && bootstrapToken.length >= 32),
      token_suppressed: bootstrapSuppressed,
      ready: bootstrapReady,
    },
  };
}

function fastConsoleMetrics() {
  return {
    connected_agents: 1,
    active_tokens: 1,
    requests_today: 0,
    error_rate: '0%',
    jobs_by_status: {} as Record<string, number>,
  };
}

function fastQualitySources(): SourceListEntry[] {
  return [{
    id: 'default',
    name: 'Default',
    local_path: null,
    remote_url: null,
    federated: true,
    page_count: 0,
    last_sync_at: null,
  }];
}

function fastQualitySkills(): SaasSkillSummary[] {
  return [{
    id: 'cortex-onboarding',
    name: 'Cortex Onboarding',
    owner: 'system',
    status: 'installed',
    triggers: ['signup', 'invite', 'connect'],
    allowedClients: ['users_admin'],
    sourceAccess: ['default'],
    lastRun: 'not run',
    description: 'Hosted onboarding and agent setup workflow.',
    enforcementStatus: 'enforced',
    persisted: true,
  }];
}

function fastComposioStatus(publicUrl: string | null): ComposioIntegrationStatus {
  const env = composioEnvStatus(publicUrl);
  return {
    ...env,
    connectors: COMPOSIO_CONNECTORS.map(connector => {
      const sourceId = `composio-${connector.id}`;
      const connected = connector.id === 'slack';
      return {
        ...connector,
        sourceId,
        sourceName: `${connector.label} via Composio`,
        connected,
        status: connected ? 'connected' : (env.apiKeyConfigured ? 'ready' : 'setup_required'),
      };
    }),
  };
}

function check(
  area: string,
  signal: string,
  passed: boolean,
  status: string,
  detail: string,
  remediation: string | null,
): SaasQualityCheck {
  return { area, signal, status: passed ? 'passing' : status, detail, passed, remediation: passed ? null : remediation };
}

export async function buildSaasQualitySnapshot(
  engine: BrainEngine,
  input: SaasQualitySnapshotInput = {},
): Promise<SaasQualitySnapshot> {
  const publicUrl = input.publicUrl?.trim() || process.env.CORTEX_PUBLIC_URL?.trim() || process.env.GBRAIN_PUBLIC_URL?.trim() || null;
  const fastMode = isTruthy(envFirst('CORTEX_QUALITY_FAST', 'CORTEX_QUALITY_SKIP_ANALYTICS'));
  const [consoleMetrics, sources, skills, integrations] = fastMode
    ? [fastConsoleMetrics(), fastQualitySources(), fastQualitySkills(), fastComposioStatus(publicUrl)] as const
    : await Promise.all([
      qualityConsoleMetrics(engine),
      listQualitySources(engine).catch(() => [] as SourceListEntry[]),
      listSaasSkills(engine).catch(() => [] as SaasSkillSummary[]),
      getComposioIntegrationStatus(engine, publicUrl),
    ]);
  const runtimeManifest = buildSaasRuntimeManifest({ publicUrl });
  const enforcedSkills = skills.filter(skill => (
    skill.enforcementStatus === 'enforced' ||
    (skill.allowedClients?.length ?? 0) > 0
  ));
  const failedJobs = countFailedJobs(consoleMetrics.jobs_by_status);
  const connectedComposioConnectors = integrations.connectors.filter(connector => connector.connected).length;
  const composioConfigured = integrations.apiKeyConfigured && integrations.webhookSecretConfigured;
  const missingComposioEnv = [
    integrations.apiKeyConfigured ? null : 'COMPOSIO_API_KEY',
    integrations.webhookSecretConfigured ? null : 'CORTEX_COMPOSIO_WEBHOOK_SECRET',
  ].filter((value): value is string => Boolean(value));
  const agentParityOperations = runtimeManifest.agent_parity.operations.length;
  const deployment = buildDeploymentReadiness(engine, publicUrl);

  const checks = [
    check(
      'Durable database',
      'Hosted runtime uses Supabase/Postgres, not local PGLite',
      deployment.database.ready,
      'needs_deploy',
      `${deployment.engine_kind} engine, ${deployment.database.provider} database${deployment.database.host ? ` at ${deployment.database.host}` : ''}`,
      'Deploy the tenant with CORTEX_DATABASE_URL pointing at a Supabase/Postgres database and run the web service on the postgres engine.',
    ),
    check(
      'Hosted OAuth origin',
      'Public URL is a stable HTTPS origin',
      deployment.public_url.ready,
      'needs_deploy',
      deployment.public_url.origin || 'No public URL configured',
      'Set CORTEX_PUBLIC_URL to the production HTTPS origin before handing runtime manifests to agents.',
    ),
    check(
      'Invite email delivery',
      'Owner onboarding and teammate invites have a configured provider',
      deployment.email.ready,
      'needs_setup',
      deployment.email.provider
        ? `${deployment.email.provider} provider, API key ${deployment.email.configured ? 'set' : 'missing'}, from ${deployment.email.from_configured ? 'set' : 'missing'}`
        : 'No CORTEX_EMAIL_PROVIDER configured',
      'Set CORTEX_EMAIL_PROVIDER=resend plus RESEND_API_KEY/CORTEX_RESEND_API_KEY and CORTEX_EMAIL_FROM.',
    ),
    check(
      'Billing webhook',
      'Subscription lifecycle events can reconcile tenant plan state',
      deployment.billing.ready,
      'needs_setup',
      deployment.billing.webhook_secret_configured ? 'Webhook secret configured' : 'CORTEX_BILLING_WEBHOOK_SECRET missing',
      'Set CORTEX_BILLING_WEBHOOK_SECRET and verify POST /webhooks/billing before production signup.',
    ),
    check(
      'Secret hygiene',
      'Bootstrap token is strong and suppressed from hosted logs',
      deployment.bootstrap.ready,
      'needs_hardening',
      `token ${deployment.bootstrap.token_configured ? 'configured' : 'missing/weak'}, log suppression ${deployment.bootstrap.token_suppressed ? 'on' : 'off'}`,
      'Set a 32+ character CORTEX_ADMIN_BOOTSTRAP_TOKEN and CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1.',
    ),
    check(
      'Signup and onboarding',
      'Tenant URL and connect command are generated',
      Boolean(runtimeManifest.onboarding.connect_command && runtimeManifest.endpoints.mcp_url),
      'needs_manifest',
      runtimeManifest.onboarding.connect_command ? 'Connect command present' : 'Runtime manifest fallback only',
      'Generate the runtime manifest from a public Cortex URL before handing the tenant to an agent.',
    ),
    check(
      'Agent access',
      'MCP OAuth clients can be registered',
      consoleMetrics.active_tokens > 0 || consoleMetrics.connected_agents > 0,
      'needs_data',
      `${consoleMetrics.connected_agents || 0} connected, ${consoleMetrics.active_tokens || 0} active tokens`,
      'Register an agent client or complete the owner onboarding flow so MCP access is proven.',
    ),
    check(
      'Source ingestion',
      'At least one source is available for scoped memory',
      sources.length > 0,
      'needs_data',
      `${sources.length} sources`,
      'Create a default source or connect a Composio source before demoing ingestion.',
    ),
    check(
      'Composio ingestion',
      'Webhook secret and connector hub are configured',
      composioConfigured,
      'needs_setup',
      composioConfigured
        ? `${connectedComposioConnectors} connected connector sources`
        : `Missing ${missingComposioEnv.join(', ') || 'connector setup'}`,
      'Set COMPOSIO_API_KEY and CORTEX_COMPOSIO_WEBHOOK_SECRET, then create connector-backed sources.',
    ),
    check(
      'Skill promotion',
      'Skills have source access and client policy',
      enforcedSkills.length > 0,
      'needs_policy',
      `${enforcedSkills.length}/${skills.length} enforced`,
      'Promote at least one skill with source access and allowed OAuth clients before investor demos.',
    ),
    check(
      'Queue health',
      'No failed or dead jobs in the current window',
      failedJobs === 0,
      'needs_attention',
      `${failedJobs} failed/dead jobs`,
      'Inspect the jobs queue and clear or retry failed ingestion/runtime jobs.',
    ),
    check(
      'Agent parity',
      'Manifest advertises agent-callable operations',
      agentParityOperations > 0,
      'needs_manifest',
      `${agentParityOperations || 'fallback'} operations`,
      'Publish the runtime manifest with agent-callable operations for every console workflow.',
    ),
  ];
  const passed = checks.filter(row => row.passed).length;
  const score = Math.round((passed / checks.length) * 100);

  return {
    schema: 'cortex.saas-quality-snapshot.v1',
    generated_at: new Date().toISOString(),
    version: VERSION,
    readiness: {
      score,
      passed,
      total: checks.length,
      status: passed === checks.length ? 'passing' : 'needs_attention',
    },
    metrics: {
      connected_agents: consoleMetrics.connected_agents,
      active_tokens: consoleMetrics.active_tokens,
      requests_today: consoleMetrics.requests_today,
      error_rate: consoleMetrics.error_rate,
      source_count: sources.length,
      connected_composio_connectors: connectedComposioConnectors,
      enforced_skills: enforcedSkills.length,
      total_skills: skills.length,
      waiting_jobs: consoleMetrics.jobs_by_status.waiting || 0,
      active_jobs: (consoleMetrics.jobs_by_status.active || 0) + (consoleMetrics.jobs_by_status.running || 0),
      failed_jobs: failedJobs,
      agent_parity_operations: agentParityOperations,
    },
    deployment,
    checks,
    runtime_manifest: runtimeManifest,
    integrations,
    sources,
    skills,
  };
}
