import type { BrainEngine } from './engine.ts';
import { ensureSaasControlPlane } from './saas-control-plane.ts';
import { VERSION } from '../version.ts';

export interface ConsoleSnapshotOptions {
  agent?: string | null;
  operation?: string | null;
  status?: string | null;
  limit?: number | null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseFloat(value) || 0;
  return 0;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // PostgreSQL text[] may serialize as "{a,b}" through some adapters.
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    return trimmed.split(/\s+/g).filter(Boolean);
  }
  return [];
}

function clampLimit(value: number | null | undefined, fallback = 20): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value as number)));
}

async function count(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(sql, params);
  return toNumber(rows[0]?.count);
}

export async function querySaasConsoleSnapshot(engine: BrainEngine, options: ConsoleSnapshotOptions = {}) {
  await ensureSaasControlPlane(engine);
  const limit = clampLimit(options.limit);
  const now = Math.floor(Date.now() / 1000);

  const connectedAgents = await count(engine, `SELECT count(*)::int as count FROM oauth_clients`);
  const activeTokens = await count(
    engine,
    `SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > $1`,
    [now],
  );
  const requestsToday = await count(
    engine,
    `SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`,
  );
  const activeApiKeys = await count(engine, `SELECT count(*)::int as count FROM access_tokens WHERE revoked_at IS NULL`);
  const expiringSoon = await count(
    engine,
    `SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN $1 AND $2`,
    [now, now + 86400],
  );
  const errorsToday = await count(
    engine,
    `SELECT count(*)::int as count FROM mcp_request_log WHERE status != 'success' AND created_at > now() - interval '24 hours'`,
  );

  const oauthClients = await engine.executeRaw<Record<string, unknown>>(
    `SELECT c.client_id as id, c.client_name as name, 'oauth' as auth_type,
            c.grant_types, c.scope, c.created_at, c.token_ttl, c.source_id, c.federated_read,
            CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
            (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
            (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
            (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
       FROM oauth_clients c
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit],
  );
  const legacyKeys = await engine.executeRaw<Record<string, unknown>>(
    `SELECT a.id::text as id, a.name, 'api_key' as auth_type,
            ARRAY['bearer'] as grant_types, 'read write admin' as scope, a.created_at, null as token_ttl,
            'default' as source_id, ARRAY['default'] as federated_read,
            CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
            a.last_used_at,
            (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
            (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
       FROM access_tokens a
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit],
  );
  const agents = [...oauthClients, ...legacyKeys].slice(0, limit).map(row => ({
    id: String(row.id),
    name: String(row.name ?? row.id),
    auth_type: String(row.auth_type),
    grant_types: parseArray(row.grant_types),
    scope: String(row.scope ?? ''),
    status: String(row.status ?? 'active'),
    source_id: String(row.source_id ?? 'default'),
    federated_read: parseArray(row.federated_read),
    token_ttl: row.token_ttl == null ? null : toNumber(row.token_ttl),
    total_requests: toNumber(row.total_requests),
    requests_today: toNumber(row.requests_today),
    created_at: toIso(row.created_at),
    last_used_at: toIso(row.last_used_at),
  }));

  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (options.agent && options.agent !== 'all') {
    filters.push(`AND token_name = $${params.length + 1}`);
    params.push(options.agent);
  }
  if (options.operation && options.operation !== 'all') {
    filters.push(`AND operation = $${params.length + 1}`);
    params.push(options.operation);
  }
  if (options.status && options.status !== 'all') {
    filters.push(`AND status = $${params.length + 1}`);
    params.push(options.status);
  }
  const filterSql = filters.join(' ');
  const limitParam = `$${params.length + 1}`;
  const requestRows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
            operation, latency_ms, status, params, error_message, created_at
       FROM mcp_request_log
      WHERE 1=1 ${filterSql}
      ORDER BY created_at DESC
      LIMIT ${limitParam}`,
    [...params, limit],
  );
  const requestTotalRows = await engine.executeRaw<{ total: number | string }>(
    `SELECT count(*)::int as total FROM mcp_request_log WHERE 1=1 ${filterSql}`,
    params,
  );

  const jobCountRows = await engine.executeRaw<{ status: string; count: number | string }>(
    `SELECT status, count(*)::int as count FROM minion_jobs GROUP BY status ORDER BY status`,
  );
  const recentJobRows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, name, queue, status, created_at, started_at, finished_at, error_text
       FROM minion_jobs
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );

  const sourceCount = await count(engine, `SELECT count(*)::int as count FROM sources WHERE COALESCE(archived, FALSE) = FALSE`);
  const skillCount = await count(engine, `SELECT count(*)::int as count FROM saas_skill_policies`);
  const inviteDeliveryCount = await count(engine, `SELECT count(*)::int as count FROM saas_email_deliveries`);
  const queuedInviteDeliveryCount = await count(engine, `SELECT count(*)::int as count FROM saas_email_deliveries WHERE status IN ('queued', 'pending_provider')`);

  return {
    schema: 'cortex.saas-console-snapshot.v1',
    generated_at: new Date().toISOString(),
    version: VERSION,
    stats: {
      connected_agents: connectedAgents,
      active_tokens: activeTokens,
      active_api_keys: activeApiKeys,
      requests_today: requestsToday,
    },
    health: {
      expiring_soon: expiringSoon,
      error_count_24h: errorsToday,
      error_rate: requestsToday > 0 ? `${((errorsToday / requestsToday) * 100).toFixed(1)}%` : '0%',
    },
    control_plane: {
      organizations: await count(engine, `SELECT count(*)::int as count FROM saas_organizations`),
      brains: await count(engine, `SELECT count(*)::int as count FROM saas_tenant_brains`),
      members: await count(engine, `SELECT count(*)::int as count FROM saas_org_members`),
      invites: await count(engine, `SELECT count(*)::int as count FROM saas_org_invites`),
      invite_deliveries: inviteDeliveryCount,
      queued_invite_deliveries: queuedInviteDeliveryCount,
      sources: sourceCount,
      skill_policies: skillCount,
    },
    agents: {
      rows: agents,
      total: await count(engine, `SELECT (SELECT count(*) FROM oauth_clients) + (SELECT count(*) FROM access_tokens) as count`),
      active: agents.filter(agent => agent.status === 'active').length,
      revoked: agents.filter(agent => agent.status === 'revoked').length,
      limit,
    },
    requests: {
      rows: requestRows.map(row => ({
        id: toNumber(row.id),
        token_name: row.token_name == null ? null : String(row.token_name),
        agent_name: row.agent_name == null ? null : String(row.agent_name),
        operation: String(row.operation),
        latency_ms: toNumber(row.latency_ms),
        status: String(row.status),
        params: parseJsonObject(row.params),
        error_message: row.error_message == null ? null : String(row.error_message),
        created_at: toIso(row.created_at),
      })),
      total: toNumber(requestTotalRows[0]?.total),
      filters: {
        agent: options.agent || 'all',
        operation: options.operation || 'all',
        status: options.status || 'all',
      },
      limit,
    },
    jobs: {
      counts_by_status: Object.fromEntries(jobCountRows.map(row => [String(row.status), toNumber(row.count)])),
      recent: recentJobRows.map(row => ({
        id: toNumber(row.id),
        name: String(row.name),
        queue: String(row.queue),
        status: String(row.status),
        error_text: row.error_text == null ? null : String(row.error_text),
        created_at: toIso(row.created_at),
        started_at: toIso(row.started_at),
        finished_at: toIso(row.finished_at),
      })),
      limit,
    },
  };
}
