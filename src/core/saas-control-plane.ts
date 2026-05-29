import { randomBytes, createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';

export type SaasRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface SaasOrganization {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: string;
  created_at: string;
}

export interface SaasTenantBrain {
  id: string;
  org_id: string;
  name: string;
  public_url: string | null;
  region: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SaasMember {
  id: string;
  org_id: string;
  email: string;
  role: SaasRole;
  status: string;
  source_id: string;
  federated_read: string[];
  oauth_client_id: string | null;
  last_active_at: string | null;
  created_at: string;
}

export interface SaasInvite {
  id: string;
  org_id: string;
  email: string;
  role: SaasRole;
  status: string;
  source_id: string;
  federated_read: string[];
  oauth_client_id: string | null;
  onboarding_url: string | null;
  expires_at: string | null;
  delivery_status?: string | null;
  delivery_provider?: string | null;
  delivery_last_error?: string | null;
  delivery_updated_at?: string | null;
  created_at: string;
}

export type SaasEmailDeliveryKind = 'owner_onboarding' | 'teammate_invite';

export interface SaasEmailDelivery {
  id: string;
  org_id: string;
  invite_id: string | null;
  email: string;
  kind: SaasEmailDeliveryKind;
  status: string;
  provider: string;
  provider_message_id: string | null;
  subject: string;
  body_text: string;
  onboarding_url: string | null;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SaasEmailDeliveryClaimStatus = 'queued' | 'pending_provider' | 'failed' | 'sending';
export type SaasEmailDeliveryResultStatus = 'sent' | 'failed' | 'queued' | 'pending_provider' | 'sending';

export type SaasSkillStatus = 'installed' | 'draft' | 'needs-enforcement';
export type SaasSkillEnforcementStatus = 'enforced' | 'not_enforced' | 'needs_enforcement';

export interface SaasSkillPolicy {
  id: string;
  name: string;
  owner: string;
  status: SaasSkillStatus;
  triggers: string[];
  allowed_clients: string[];
  source_access: string[];
  last_run_at: string | null;
  description: string;
  enforcement_status: SaasSkillEnforcementStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SaasOrgAgentClient {
  org_id: string;
  client_id: string;
  display_name: string | null;
  source_id: string;
  federated_read: string[];
  created_at: string;
}

export type SaasPlanKey = 'launch' | 'team' | 'business' | 'enterprise';
export type SaasPlanUsageKey =
  | 'brains'
  | 'sources'
  | 'members'
  | 'pending_invites'
  | 'agent_clients'
  | 'skill_policies'
  | 'requests_today'
  | 'waiting_jobs';

export type SaasPlanLimits = Record<SaasPlanUsageKey, number | null>;

export interface SaasPlanSummary {
  org_id: string;
  plan_key: SaasPlanKey;
  status: string;
  billing_customer_id: string | null;
  billing_provider: string | null;
  billing_subscription_id: string | null;
  billing_plan_ref: string | null;
  billing_current_period_end: string | null;
  billing_event_id: string | null;
  billing_synced_at: string | null;
  limits: SaasPlanLimits;
  usage: Record<SaasPlanUsageKey, number>;
  remaining: Record<SaasPlanUsageKey, number | null>;
  violations: SaasPlanUsageKey[];
  created_at: string;
  updated_at: string;
}

export interface SaasBillingReconcileInput {
  provider?: string | null;
  eventId?: string | null;
  eventType?: string | null;
  orgId?: string | null;
  orgSlug?: string | null;
  billingCustomerId?: string | null;
  billingSubscriptionId?: string | null;
  planKey?: unknown;
  status?: string | null;
  billingPlanRef?: string | null;
  billingCurrentPeriodEnd?: Date | string | number | null;
  limits?: Partial<Record<SaasPlanUsageKey, number | null>>;
  raw?: unknown;
}

export interface SaasBillingReconcileResult {
  applied: boolean;
  duplicate: boolean;
  event_id: string;
  plan: SaasPlanSummary;
}

export class SaasPlanLimitError extends Error {
  code = 'plan_limit_exceeded' as const;

  constructor(
    public orgId: string,
    public metric: SaasPlanUsageKey,
    public limit: number,
    public current: number,
  ) {
    super(`plan_limit_exceeded:${metric}:${current}/${limit}`);
    this.name = 'SaasPlanLimitError';
  }
}

const DEFAULT_PLAN_KEY: SaasPlanKey = 'launch';
const PLAN_LIMITS: Record<SaasPlanKey, SaasPlanLimits> = {
  launch: {
    brains: 3,
    sources: 12,
    members: 25,
    pending_invites: 50,
    agent_clients: 50,
    skill_policies: 100,
    requests_today: 5000,
    waiting_jobs: 200,
  },
  team: {
    brains: 5,
    sources: 25,
    members: 75,
    pending_invites: 150,
    agent_clients: 150,
    skill_policies: 250,
    requests_today: 25000,
    waiting_jobs: 1000,
  },
  business: {
    brains: 20,
    sources: 100,
    members: 500,
    pending_invites: 1000,
    agent_clients: 1000,
    skill_policies: 1000,
    requests_today: 250000,
    waiting_jobs: 10000,
  },
  enterprise: {
    brains: null,
    sources: null,
    members: null,
    pending_invites: null,
    agent_clients: null,
    skill_policies: null,
    requests_today: null,
    waiting_jobs: null,
  },
};

export function makeSaasId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function normalizeOrgSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .slice(0, 48) || `org-${randomBytes(3).toString('hex')}`;
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

export function normalizeRole(input: unknown): SaasRole {
  if (input === 'owner' || input === 'admin' || input === 'member' || input === 'viewer') return input;
  return 'member';
}

export function normalizeSkillId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .slice(0, 80);
}

export function normalizeSkillStatus(input: unknown): SaasSkillStatus {
  if (input === 'installed' || input === 'draft' || input === 'needs-enforcement') return input;
  return 'draft';
}

export function normalizeSkillEnforcementStatus(input: unknown): SaasSkillEnforcementStatus {
  if (input === 'enforced' || input === 'not_enforced' || input === 'needs_enforcement') return input;
  return 'needs_enforcement';
}

export function normalizePlanKey(input: unknown): SaasPlanKey {
  if (input === 'team' || input === 'business' || input === 'enterprise' || input === 'launch') return input;
  return DEFAULT_PLAN_KEY;
}

function maybePlanKey(input: unknown): SaasPlanKey | undefined {
  return input === 'team' || input === 'business' || input === 'enterprise' || input === 'launch'
    ? input
    : undefined;
}

function stringOrNull(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function normalizeBillingProvider(input: unknown): string | null {
  const value = stringOrNull(input);
  if (!value) return null;
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || null;
}

function normalizePlanStatus(input: unknown): string | null {
  const value = stringOrNull(input);
  if (!value) return null;
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 48) || null;
}

function optionalIso(value: unknown): string | null {
  if (value == null) return null;
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value > 1_000_000_000_000 ? value : value * 1000);
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value);
  } else {
    return null;
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stableBillingEventId(input: SaasBillingReconcileInput): string {
  const explicit = stringOrNull(input.eventId);
  if (explicit) return explicit.slice(0, 128);
  return createHash('sha256').update(JSON.stringify(input.raw ?? input)).digest('hex');
}

export function defaultPlanLimits(planKey: SaasPlanKey = DEFAULT_PLAN_KEY): SaasPlanLimits {
  return { ...PLAN_LIMITS[planKey] };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseLimits(value: unknown, planKey: SaasPlanKey): SaasPlanLimits {
  const base = defaultPlanLimits(planKey);
  const parsed = parseJsonObject(value);
  for (const key of Object.keys(base) as SaasPlanUsageKey[]) {
    const raw = parsed[key];
    if (raw === null) {
      base[key] = null;
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      base[key] = Math.floor(raw);
    } else if (typeof raw === 'string' && raw.trim()) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) base[key] = Math.floor(n);
    }
  }
  return base;
}

function mapOrg(row: Record<string, unknown>): SaasOrganization {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    domain: row.domain == null ? null : String(row.domain),
    status: String(row.status),
    created_at: asIso(row.created_at),
  };
}

async function scalarCount(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(sql, params);
  const raw = rows[0]?.count ?? 0;
  return typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10) || 0;
}

async function planUsage(engine: BrainEngine, orgId: string): Promise<Record<SaasPlanUsageKey, number>> {
  const now = Math.floor(Date.now() / 1000);
  void now;
  return {
    brains: await scalarCount(engine, `SELECT count(*)::int as count FROM saas_tenant_brains WHERE org_id = $1`, [orgId]),
    sources: await scalarCount(
      engine,
      `SELECT count(DISTINCT s.id)::int as count
         FROM saas_org_sources os
         JOIN sources s ON s.id = os.source_id
        WHERE os.org_id = $1 AND COALESCE(s.archived, FALSE) = FALSE`,
      [orgId],
    ),
    members: await scalarCount(engine, `SELECT count(*)::int as count FROM saas_org_members WHERE org_id = $1`, [orgId]),
    pending_invites: await scalarCount(engine, `SELECT count(*)::int as count FROM saas_org_invites WHERE org_id = $1 AND status = 'pending' AND revoked_at IS NULL`, [orgId]),
    agent_clients: await scalarCount(
      engine,
      `SELECT count(DISTINCT linked.client_id)::int as count
         FROM (
           SELECT oauth_client_id AS client_id FROM saas_org_members WHERE org_id = $1 AND oauth_client_id IS NOT NULL
           UNION ALL
           SELECT oauth_client_id AS client_id FROM saas_org_invites WHERE org_id = $1 AND oauth_client_id IS NOT NULL
           UNION ALL
           SELECT client_id FROM saas_org_agent_clients WHERE org_id = $1
         ) linked
         JOIN oauth_clients oc ON oc.client_id = linked.client_id
        WHERE oc.deleted_at IS NULL`,
      [orgId],
    ),
    skill_policies: await scalarCount(
      engine,
      `SELECT count(*)::int as count
         FROM saas_skill_policies sp
        WHERE EXISTS (
          SELECT 1
            FROM saas_org_sources os
           WHERE os.org_id = $1
             AND os.source_id IN (
               SELECT jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(sp.source_access) = 'array' THEN sp.source_access
                   WHEN jsonb_typeof(sp.source_access) = 'string' THEN jsonb_build_array(sp.source_access)
                   ELSE '[]'::jsonb
                 END
               )
             )
        )`,
      [orgId],
    ),
    requests_today: await scalarCount(engine, `SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`),
    waiting_jobs: await scalarCount(engine, `SELECT count(*)::int as count FROM minion_jobs WHERE status IN ('waiting', 'active', 'waiting-children')`),
  };
}

function planSummaryFromRow(row: Record<string, unknown>, usage: Record<SaasPlanUsageKey, number>): SaasPlanSummary {
  const planKey = normalizePlanKey(row.plan_key);
  const limits = parseLimits(row.limits, planKey);
  const remaining = Object.fromEntries(
    (Object.keys(limits) as SaasPlanUsageKey[]).map((key) => {
      const limit = limits[key];
      return [key, limit === null ? null : Math.max(0, limit - usage[key])];
    }),
  ) as Record<SaasPlanUsageKey, number | null>;
  const violations = (Object.keys(limits) as SaasPlanUsageKey[]).filter((key) => {
    const limit = limits[key];
    return limit !== null && usage[key] > limit;
  });
  return {
    org_id: String(row.org_id),
    plan_key: planKey,
    status: String(row.status ?? 'active'),
    billing_customer_id: row.billing_customer_id == null ? null : String(row.billing_customer_id),
    billing_provider: row.billing_provider == null ? null : String(row.billing_provider),
    billing_subscription_id: row.billing_subscription_id == null ? null : String(row.billing_subscription_id),
    billing_plan_ref: row.billing_plan_ref == null ? null : String(row.billing_plan_ref),
    billing_current_period_end: row.billing_current_period_end == null ? null : asIso(row.billing_current_period_end),
    billing_event_id: row.billing_event_id == null ? null : String(row.billing_event_id),
    billing_synced_at: row.billing_synced_at == null ? null : asIso(row.billing_synced_at),
    limits,
    usage,
    remaining,
    violations,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function mapBrain(row: Record<string, unknown>): SaasTenantBrain {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    name: String(row.name),
    public_url: row.public_url == null ? null : String(row.public_url),
    region: row.region == null ? null : String(row.region),
    status: String(row.status),
    metadata: parseJsonObject(row.metadata),
    created_at: asIso(row.created_at),
  };
}

function mapMember(row: Record<string, unknown>): SaasMember {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    email: String(row.email),
    role: normalizeRole(row.role),
    status: String(row.status),
    source_id: String(row.source_id ?? 'default'),
    federated_read: parseJsonArray(row.federated_read),
    oauth_client_id: row.oauth_client_id == null ? null : String(row.oauth_client_id),
    last_active_at: row.last_active_at == null ? null : asIso(row.last_active_at),
    created_at: asIso(row.created_at),
  };
}

function mapInvite(row: Record<string, unknown>): SaasInvite {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    email: String(row.email),
    role: normalizeRole(row.role),
    status: String(row.status),
    source_id: String(row.source_id ?? 'default'),
    federated_read: parseJsonArray(row.federated_read),
    oauth_client_id: row.oauth_client_id == null ? null : String(row.oauth_client_id),
    onboarding_url: row.onboarding_url == null ? null : String(row.onboarding_url),
    expires_at: row.expires_at == null ? null : asIso(row.expires_at),
    delivery_status: row.delivery_status == null ? null : String(row.delivery_status),
    delivery_provider: row.delivery_provider == null ? null : String(row.delivery_provider),
    delivery_last_error: row.delivery_last_error == null ? null : String(row.delivery_last_error),
    delivery_updated_at: row.delivery_updated_at == null ? null : asIso(row.delivery_updated_at),
    created_at: asIso(row.created_at),
  };
}

function normalizeEmailDeliveryKind(input: unknown): SaasEmailDeliveryKind {
  return input === 'owner_onboarding' ? 'owner_onboarding' : 'teammate_invite';
}

function normalizeEmailDeliveryClaimStatus(input: unknown): SaasEmailDeliveryClaimStatus | null {
  return input === 'queued' || input === 'pending_provider' || input === 'failed' || input === 'sending'
    ? input
    : null;
}

function normalizeEmailDeliveryResultStatus(input: unknown): SaasEmailDeliveryResultStatus {
  if (
    input === 'sent' ||
    input === 'failed' ||
    input === 'queued' ||
    input === 'pending_provider' ||
    input === 'sending'
  ) {
    return input;
  }
  throw new Error('invalid_delivery_status');
}

function mapEmailDelivery(row: Record<string, unknown>): SaasEmailDelivery {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    invite_id: row.invite_id == null ? null : String(row.invite_id),
    email: String(row.email),
    kind: normalizeEmailDeliveryKind(row.kind),
    status: String(row.status ?? 'queued'),
    provider: String(row.provider ?? 'outbox'),
    provider_message_id: row.provider_message_id == null ? null : String(row.provider_message_id),
    subject: String(row.subject ?? ''),
    body_text: String(row.body_text ?? ''),
    onboarding_url: row.onboarding_url == null ? null : String(row.onboarding_url),
    attempts: typeof row.attempts === 'number' ? row.attempts : Number(row.attempts ?? 0),
    last_error: row.last_error == null ? null : String(row.last_error),
    sent_at: row.sent_at == null ? null : asIso(row.sent_at),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function mapSkillPolicy(row: Record<string, unknown>): SaasSkillPolicy {
  return {
    id: String(row.id),
    name: String(row.name),
    owner: String(row.owner ?? 'workspace'),
    status: normalizeSkillStatus(row.status),
    triggers: parseJsonArray(row.triggers),
    allowed_clients: parseJsonArray(row.allowed_clients),
    source_access: parseJsonArray(row.source_access),
    last_run_at: row.last_run_at == null ? null : asIso(row.last_run_at),
    description: String(row.description ?? ''),
    enforcement_status: normalizeSkillEnforcementStatus(row.enforcement_status),
    metadata: parseJsonObject(row.metadata),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function mapOrgAgentClient(row: Record<string, unknown>): SaasOrgAgentClient {
  return {
    org_id: String(row.org_id),
    client_id: String(row.client_id),
    display_name: row.display_name == null ? null : String(row.display_name),
    source_id: String(row.source_id ?? 'default'),
    federated_read: parseJsonArray(row.federated_read),
    created_at: asIso(row.created_at),
  };
}

export async function ensureSaasControlPlane(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_organizations (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      domain      TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_tenant_brains (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      public_url  TEXT,
      region      TEXT,
      status      TEXT NOT NULL DEFAULT 'provisioning',
      metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_org_members (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email           TEXT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      status          TEXT NOT NULL DEFAULT 'active',
      source_id       TEXT NOT NULL DEFAULT 'default',
      federated_read  JSONB NOT NULL DEFAULT '["default"]'::jsonb,
      oauth_client_id TEXT,
      last_active_at  TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, email)
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_org_invites (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      email              TEXT NOT NULL,
      role               TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      status             TEXT NOT NULL DEFAULT 'pending',
      source_id          TEXT NOT NULL DEFAULT 'default',
      federated_read     JSONB NOT NULL DEFAULT '["default"]'::jsonb,
      oauth_client_id    TEXT,
      invite_token_hash  TEXT,
      onboarding_url     TEXT,
      expires_at         TIMESTAMPTZ,
      accepted_at        TIMESTAMPTZ,
      revoked_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_email_deliveries (
      id                   TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      invite_id            TEXT REFERENCES saas_org_invites(id) ON DELETE SET NULL,
      email                TEXT NOT NULL,
      kind                 TEXT NOT NULL DEFAULT 'teammate_invite',
      status               TEXT NOT NULL DEFAULT 'queued',
      provider             TEXT NOT NULL DEFAULT 'outbox',
      provider_message_id  TEXT,
      subject              TEXT NOT NULL,
      body_text            TEXT NOT NULL,
      onboarding_url       TEXT,
      attempts             INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      sent_at              TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_skill_policies (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      owner               TEXT NOT NULL DEFAULT 'workspace',
      status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('installed', 'draft', 'needs-enforcement')),
      triggers            JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_clients     JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_access       JSONB NOT NULL DEFAULT '["default"]'::jsonb,
      last_run_at         TIMESTAMPTZ,
      description         TEXT NOT NULL DEFAULT '',
      enforcement_status  TEXT NOT NULL DEFAULT 'needs_enforcement' CHECK (enforcement_status IN ('enforced', 'not_enforced', 'needs_enforcement')),
      metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_org_sources (
      org_id      TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, source_id)
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_org_agent_clients (
      org_id          TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      client_id       TEXT NOT NULL UNIQUE,
      display_name    TEXT,
      source_id       TEXT NOT NULL DEFAULT 'default',
      federated_read  JSONB NOT NULL DEFAULT '["default"]'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, client_id)
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_org_plans (
      org_id               TEXT PRIMARY KEY REFERENCES saas_organizations(id) ON DELETE CASCADE,
      plan_key             TEXT NOT NULL DEFAULT 'launch',
      status               TEXT NOT NULL DEFAULT 'active',
      billing_customer_id  TEXT,
      billing_provider     TEXT,
      billing_subscription_id TEXT,
      billing_plan_ref     TEXT,
      billing_current_period_end TIMESTAMPTZ,
      billing_event_id     TEXT,
      billing_synced_at    TIMESTAMPTZ,
      limits               JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_provider TEXT`);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_subscription_id TEXT`);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_plan_ref TEXT`);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_current_period_end TIMESTAMPTZ`);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_event_id TEXT`);
  await engine.executeRaw(`ALTER TABLE saas_org_plans ADD COLUMN IF NOT EXISTS billing_synced_at TIMESTAMPTZ`);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS saas_billing_events (
      provider    TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      org_id      TEXT NOT NULL REFERENCES saas_organizations(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL DEFAULT 'unknown',
      payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, event_id)
    )
  `);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_members_org_idx ON saas_org_members(org_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_invites_org_idx ON saas_org_invites(org_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_email_deliveries_org_idx ON saas_email_deliveries(org_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_email_deliveries_invite_idx ON saas_email_deliveries(invite_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_email_deliveries_status_idx ON saas_email_deliveries(status)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_brains_org_idx ON saas_tenant_brains(org_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_skill_policies_status_idx ON saas_skill_policies(status)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_org_sources_source_idx ON saas_org_sources(source_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_org_agent_clients_org_idx ON saas_org_agent_clients(org_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_org_plans_status_idx ON saas_org_plans(status)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_org_plans_customer_idx ON saas_org_plans(billing_customer_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_org_plans_subscription_idx ON saas_org_plans(billing_subscription_id)`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS saas_billing_events_org_idx ON saas_billing_events(org_id)`);
}

export async function ensurePlanForOrg(
  engine: BrainEngine,
  orgId: string,
  planKey: SaasPlanKey = normalizePlanKey(process.env.CORTEX_DEFAULT_PLAN),
): Promise<SaasPlanSummary> {
  await ensureSaasControlPlane(engine);
  const normalized = normalizePlanKey(planKey);
  const rows = await engine.executeRaw(
    `INSERT INTO saas_org_plans (org_id, plan_key, limits)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (org_id) DO NOTHING`,
    [orgId, normalized, JSON.stringify(defaultPlanLimits(normalized))],
  );
  void rows;
  return getSaasPlan(engine, orgId);
}

export async function getSaasPlan(engine: BrainEngine, orgId: string): Promise<SaasPlanSummary> {
  await ensureSaasControlPlane(engine);
  const existing = await engine.executeRaw(
    `SELECT org_id, plan_key, status, billing_customer_id, billing_provider, billing_subscription_id,
            billing_plan_ref, billing_current_period_end, billing_event_id, billing_synced_at,
            limits, created_at, updated_at
       FROM saas_org_plans WHERE org_id = $1`,
    [orgId],
  );
  if (existing.length === 0) {
    const planKey = normalizePlanKey(process.env.CORTEX_DEFAULT_PLAN);
    await engine.executeRaw(
      `INSERT INTO saas_org_plans (org_id, plan_key, limits)
         VALUES ($1, $2, $3::jsonb)`,
      [orgId, planKey, JSON.stringify(defaultPlanLimits(planKey))],
    );
    return getSaasPlan(engine, orgId);
  }
  return planSummaryFromRow(existing[0], await planUsage(engine, orgId));
}

export async function updateSaasPlan(
  engine: BrainEngine,
  orgId: string,
  input: {
    planKey?: unknown;
    status?: string | null;
    billingCustomerId?: string | null;
    billingProvider?: string | null;
    billingSubscriptionId?: string | null;
    billingPlanRef?: string | null;
    billingCurrentPeriodEnd?: Date | string | number | null;
    billingEventId?: string | null;
    billingSyncedAt?: Date | string | number | null;
    limits?: Partial<Record<SaasPlanUsageKey, number | null>>;
  },
): Promise<SaasPlanSummary> {
  await ensureSaasControlPlane(engine);
  const current = await getSaasPlan(engine, orgId);
  const planKey = input.planKey === undefined ? current.plan_key : normalizePlanKey(input.planKey);
  const baseLimits = input.planKey === undefined ? current.limits : defaultPlanLimits(planKey);
  const limits = { ...baseLimits };
  if (input.limits) {
    for (const [key, value] of Object.entries(input.limits) as Array<[SaasPlanUsageKey, number | null | undefined]>) {
      if (!(key in limits)) continue;
      if (value === null) limits[key] = null;
      else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value);
    }
  }
  const rows = await engine.executeRaw(
    `UPDATE saas_org_plans
       SET plan_key = $2,
           status = $3,
           billing_customer_id = $4,
           billing_provider = $5,
           billing_subscription_id = $6,
           billing_plan_ref = $7,
           billing_current_period_end = $8,
           billing_event_id = $9,
           billing_synced_at = $10,
           limits = $11::jsonb,
           updated_at = now()
     WHERE org_id = $1
     RETURNING org_id, plan_key, status, billing_customer_id, billing_provider, billing_subscription_id,
               billing_plan_ref, billing_current_period_end, billing_event_id, billing_synced_at,
               limits, created_at, updated_at`,
    [
      orgId,
      planKey,
      normalizePlanStatus(input.status) || current.status,
      input.billingCustomerId === undefined ? current.billing_customer_id : (input.billingCustomerId?.trim() || null),
      input.billingProvider === undefined ? current.billing_provider : normalizeBillingProvider(input.billingProvider),
      input.billingSubscriptionId === undefined ? current.billing_subscription_id : (input.billingSubscriptionId?.trim() || null),
      input.billingPlanRef === undefined ? current.billing_plan_ref : (input.billingPlanRef?.trim() || null),
      input.billingCurrentPeriodEnd === undefined ? current.billing_current_period_end : optionalIso(input.billingCurrentPeriodEnd),
      input.billingEventId === undefined ? current.billing_event_id : (input.billingEventId?.trim() || null),
      input.billingSyncedAt === undefined ? current.billing_synced_at : optionalIso(input.billingSyncedAt),
      JSON.stringify(limits),
    ],
  );
  return planSummaryFromRow(rows[0], await planUsage(engine, orgId));
}

async function resolveBillingOrgId(
  engine: BrainEngine,
  input: SaasBillingReconcileInput,
  provider: string,
  eventId: string,
): Promise<string | null> {
  const orgId = stringOrNull(input.orgId);
  if (orgId) {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM saas_organizations WHERE id = $1 LIMIT 1`,
      [orgId],
    );
    if (rows[0]?.id) return rows[0].id;
  }

  const orgSlug = stringOrNull(input.orgSlug);
  if (orgSlug) {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM saas_organizations WHERE slug = $1 LIMIT 1`,
      [orgSlug],
    );
    if (rows[0]?.id) return rows[0].id;
  }

  const billingCustomerId = stringOrNull(input.billingCustomerId);
  if (billingCustomerId) {
    const rows = await engine.executeRaw<{ org_id: string }>(
      `SELECT org_id FROM saas_org_plans WHERE billing_customer_id = $1 LIMIT 1`,
      [billingCustomerId],
    );
    if (rows[0]?.org_id) return rows[0].org_id;
  }

  const billingSubscriptionId = stringOrNull(input.billingSubscriptionId);
  if (billingSubscriptionId) {
    const rows = await engine.executeRaw<{ org_id: string }>(
      `SELECT org_id FROM saas_org_plans WHERE billing_subscription_id = $1 LIMIT 1`,
      [billingSubscriptionId],
    );
    if (rows[0]?.org_id) return rows[0].org_id;
  }

  const existing = await engine.executeRaw<{ org_id: string }>(
    `SELECT org_id FROM saas_billing_events WHERE provider = $1 AND event_id = $2 LIMIT 1`,
    [provider, eventId],
  );
  return existing[0]?.org_id ?? null;
}

export async function reconcileSaasBillingEvent(
  engine: BrainEngine,
  input: SaasBillingReconcileInput,
): Promise<SaasBillingReconcileResult> {
  await ensureSaasControlPlane(engine);
  const provider = normalizeBillingProvider(input.provider) || 'billing';
  const eventId = stableBillingEventId(input);
  const orgId = await resolveBillingOrgId(engine, input, provider, eventId);
  if (!orgId) throw new Error('billing_org_not_found');

  const eventType = normalizePlanStatus(input.eventType) || 'unknown';
  const rawPayload = input.raw ?? input;
  const inserted = await engine.executeRaw<{ event_id: string }>(
    `INSERT INTO saas_billing_events (provider, event_id, org_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING event_id`,
    [provider, eventId, orgId, eventType, JSON.stringify(rawPayload ?? {})],
  );

  if (inserted.length === 0) {
    return {
      applied: false,
      duplicate: true,
      event_id: eventId,
      plan: await getSaasPlan(engine, orgId),
    };
  }

  const planKey = maybePlanKey(input.planKey);
  const plan = await updateSaasPlan(engine, orgId, {
    ...(planKey ? { planKey } : {}),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.billingCustomerId === undefined ? {} : { billingCustomerId: input.billingCustomerId }),
    billingProvider: provider,
    ...(input.billingSubscriptionId === undefined ? {} : { billingSubscriptionId: input.billingSubscriptionId }),
    ...(input.billingPlanRef === undefined ? {} : { billingPlanRef: input.billingPlanRef }),
    ...(input.billingCurrentPeriodEnd === undefined ? {} : { billingCurrentPeriodEnd: input.billingCurrentPeriodEnd }),
    billingEventId: eventId,
    billingSyncedAt: new Date(),
    ...(input.limits ? { limits: input.limits } : {}),
  });

  return {
    applied: true,
    duplicate: false,
    event_id: eventId,
    plan,
  };
}

export async function assertSaasPlanAllows(
  engine: BrainEngine,
  orgId: string,
  metric: SaasPlanUsageKey,
  increment = 1,
): Promise<SaasPlanSummary> {
  const plan = await getSaasPlan(engine, orgId);
  const limit = plan.limits[metric];
  const current = plan.usage[metric];
  if (limit !== null && current + increment > limit) {
    throw new SaasPlanLimitError(orgId, metric, limit, current);
  }
  return plan;
}

export async function firstOrganizationId(engine: BrainEngine): Promise<string | null> {
  const orgs = await listOrganizations(engine);
  return orgs[0]?.id || null;
}

export async function linkSourceToOrg(engine: BrainEngine, orgId: string, sourceId = 'default'): Promise<void> {
  await ensureSaasControlPlane(engine);
  await engine.executeRaw(
    `INSERT INTO saas_org_sources (org_id, source_id)
     SELECT $1, id FROM sources WHERE id = $2 AND COALESCE(archived, FALSE) = FALSE
     ON CONFLICT (org_id, source_id) DO NOTHING`,
    [orgId, sourceId],
  );
}

export async function linkDefaultSourceToOrg(engine: BrainEngine, orgId: string): Promise<void> {
  await linkSourceToOrg(engine, orgId, 'default');
}

export async function linkAgentClientToOrg(
  engine: BrainEngine,
  input: {
    orgId: string;
    clientId: string;
    displayName?: string | null;
    sourceId?: string | null;
    federatedRead?: string[] | null;
  },
): Promise<SaasOrgAgentClient> {
  await ensureSaasControlPlane(engine);
  const sourceId = input.sourceId?.trim() || 'default';
  const federatedRead = input.federatedRead && input.federatedRead.length > 0 ? input.federatedRead : [sourceId];
  await linkSourceToOrg(engine, input.orgId, sourceId);
  for (const readable of federatedRead) {
    await linkSourceToOrg(engine, input.orgId, readable);
  }
  const rows = await engine.executeRaw(
    `INSERT INTO saas_org_agent_clients (org_id, client_id, display_name, source_id, federated_read)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (client_id) DO UPDATE SET
         org_id = excluded.org_id,
         display_name = excluded.display_name,
         source_id = excluded.source_id,
         federated_read = excluded.federated_read,
         updated_at = now()
       RETURNING org_id, client_id, display_name, source_id, federated_read, created_at`,
    [
      input.orgId,
      input.clientId,
      input.displayName?.trim() || null,
      sourceId,
      JSON.stringify(federatedRead),
    ],
  );
  return mapOrgAgentClient(rows[0]);
}

export async function listOrganizations(engine: BrainEngine): Promise<SaasOrganization[]> {
  await ensureSaasControlPlane(engine);
  const rows = await engine.executeRaw(`SELECT id, slug, name, domain, status, created_at FROM saas_organizations ORDER BY created_at DESC`);
  return rows.map(mapOrg);
}

export async function createOrganization(
  engine: BrainEngine,
  input: { name: string; domain?: string | null; slug?: string | null },
): Promise<SaasOrganization> {
  await ensureSaasControlPlane(engine);
  const name = input.name.trim();
  const baseSlug = normalizeOrgSlug(input.slug || name);
  const domain = input.domain?.trim() || null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const suffix = attempt === 0 ? '' : `-${randomBytes(3).toString('hex')}`;
    const slug = suffix ? `${baseSlug.slice(0, Math.max(1, 48 - suffix.length))}${suffix}` : baseSlug;
    try {
      const rows = await engine.executeRaw(
        `INSERT INTO saas_organizations (id, slug, name, domain)
           VALUES ($1, $2, $3, $4)
           RETURNING id, slug, name, domain, status, created_at`,
        [makeSaasId('org'), slug, name, domain],
      );
      const org = mapOrg(rows[0]);
      await ensurePlanForOrg(engine, org.id);
      await linkDefaultSourceToOrg(engine, org.id);
      return org;
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
      const code = typeof e === 'object' && e && 'code' in e ? String((e as { code?: unknown }).code) : '';
      if (code !== '23505' && !message.includes('duplicate') && !message.includes('unique')) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('organization_slug_conflict');
}

export async function listTenantBrains(engine: BrainEngine, orgId?: string): Promise<SaasTenantBrain[]> {
  await ensureSaasControlPlane(engine);
  const rows = orgId
    ? await engine.executeRaw(
      `SELECT id, org_id, name, public_url, region, status, metadata, created_at
         FROM saas_tenant_brains WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    )
    : await engine.executeRaw(
      `SELECT id, org_id, name, public_url, region, status, metadata, created_at
         FROM saas_tenant_brains ORDER BY created_at DESC`,
    );
  return rows.map(mapBrain);
}

export async function createTenantBrain(
  engine: BrainEngine,
  input: { orgId: string; name: string; publicUrl?: string | null; region?: string | null; status?: string; metadata?: Record<string, unknown> },
): Promise<SaasTenantBrain> {
  await ensureSaasControlPlane(engine);
  await assertSaasPlanAllows(engine, input.orgId, 'brains');
  const id = makeSaasId('brain');
  const rows = await engine.executeRaw(
    `INSERT INTO saas_tenant_brains (id, org_id, name, public_url, region, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, org_id, name, public_url, region, status, metadata, created_at`,
    [
      id,
      input.orgId,
      input.name.trim(),
      input.publicUrl?.trim() || null,
      input.region?.trim() || null,
      input.status || 'provisioning',
      JSON.stringify(input.metadata || {}),
    ],
  );
  return mapBrain(rows[0]);
}

export async function upsertMember(
  engine: BrainEngine,
  input: {
    orgId: string;
    email: string;
    role: SaasRole;
    status?: string;
    sourceId?: string;
    federatedRead?: string[];
    oauthClientId?: string | null;
  },
): Promise<SaasMember> {
  await ensureSaasControlPlane(engine);
  const existing = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM saas_org_members WHERE org_id = $1 AND email = $2`,
    [input.orgId, input.email.trim().toLowerCase()],
  );
  if (existing.length === 0) await assertSaasPlanAllows(engine, input.orgId, 'members');
  const id = makeSaasId('mem');
  const sourceId = input.sourceId || 'default';
  const federatedRead = input.federatedRead && input.federatedRead.length > 0 ? input.federatedRead : [sourceId];
  await linkSourceToOrg(engine, input.orgId, sourceId);
  for (const readable of federatedRead) {
    await linkSourceToOrg(engine, input.orgId, readable);
  }
  const rows = await engine.executeRaw(
    `INSERT INTO saas_org_members (id, org_id, email, role, status, source_id, federated_read, oauth_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (org_id, email) DO UPDATE SET
         role = excluded.role,
         status = excluded.status,
         source_id = excluded.source_id,
         federated_read = excluded.federated_read,
         oauth_client_id = excluded.oauth_client_id,
         updated_at = now()
       RETURNING id, org_id, email, role, status, source_id, federated_read, oauth_client_id, last_active_at, created_at`,
    [
      id,
      input.orgId,
      input.email.trim().toLowerCase(),
      input.role,
      input.status || 'active',
      sourceId,
      JSON.stringify(federatedRead),
      input.oauthClientId || null,
    ],
  );
  return mapMember(rows[0]);
}

export async function listMembers(engine: BrainEngine, orgId: string): Promise<SaasMember[]> {
  await ensureSaasControlPlane(engine);
  const rows = await engine.executeRaw(
    `SELECT id, org_id, email, role, status, source_id, federated_read, oauth_client_id, last_active_at, created_at
       FROM saas_org_members WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(mapMember);
}

export async function createInviteRecord(
  engine: BrainEngine,
  input: {
    orgId: string;
    email: string;
    role: SaasRole;
    sourceId?: string;
    federatedRead?: string[];
    oauthClientId?: string | null;
    onboardingUrl?: string | null;
    inviteToken?: string | null;
    expiresAt?: Date | null;
  },
): Promise<SaasInvite> {
  await ensureSaasControlPlane(engine);
  await assertSaasPlanAllows(engine, input.orgId, 'pending_invites');
  const id = makeSaasId('inv');
  const sourceId = input.sourceId || 'default';
  const federatedRead = input.federatedRead && input.federatedRead.length > 0 ? input.federatedRead : [sourceId];
  await linkSourceToOrg(engine, input.orgId, sourceId);
  for (const readable of federatedRead) {
    await linkSourceToOrg(engine, input.orgId, readable);
  }
  const rows = await engine.executeRaw(
    `INSERT INTO saas_org_invites
       (id, org_id, email, role, source_id, federated_read, oauth_client_id, invite_token_hash, onboarding_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING id, org_id, email, role, status, source_id, federated_read, oauth_client_id, onboarding_url, expires_at, created_at`,
    [
      id,
      input.orgId,
      input.email.trim().toLowerCase(),
      input.role,
      sourceId,
      JSON.stringify(federatedRead),
      input.oauthClientId || null,
      input.inviteToken ? hashInviteToken(input.inviteToken) : null,
      input.onboardingUrl || null,
      input.expiresAt || null,
    ],
  );
  return mapInvite(rows[0]);
}

export async function listInvites(engine: BrainEngine, orgId: string): Promise<SaasInvite[]> {
  await ensureSaasControlPlane(engine);
  const rows = await engine.executeRaw(
    `SELECT i.id, i.org_id, i.email, i.role, i.status, i.source_id, i.federated_read, i.oauth_client_id,
            i.onboarding_url, i.expires_at, i.created_at,
            d.status as delivery_status,
            d.provider as delivery_provider,
            d.last_error as delivery_last_error,
            d.updated_at as delivery_updated_at
       FROM saas_org_invites i
       LEFT JOIN LATERAL (
         SELECT status, provider, last_error, updated_at
           FROM saas_email_deliveries
          WHERE invite_id = i.id
          ORDER BY created_at DESC
          LIMIT 1
       ) d ON TRUE
      WHERE i.org_id = $1
      ORDER BY i.created_at DESC`,
    [orgId],
  );
  return rows.map(mapInvite);
}

export async function queueInviteEmailDelivery(
  engine: BrainEngine,
  input: {
    orgId: string;
    inviteId?: string | null;
    email: string;
    kind?: SaasEmailDeliveryKind | null;
    onboardingUrl?: string | null;
    welcome?: string | null;
    provider?: string | null;
  },
): Promise<SaasEmailDelivery> {
  await ensureSaasControlPlane(engine);
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error('valid_email_required');
  const orgRows = await engine.executeRaw<{ name: string }>(
    `SELECT name FROM saas_organizations WHERE id = $1 LIMIT 1`,
    [input.orgId],
  );
  if (orgRows.length === 0) throw new Error('unknown_org');
  if (input.inviteId) {
    const inviteRows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM saas_org_invites WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [input.inviteId, input.orgId],
    );
    if (inviteRows.length === 0) throw new Error('unknown_invite');
  }

  const kind = normalizeEmailDeliveryKind(input.kind);
  const orgName = String(orgRows[0].name);
  const subject = kind === 'owner_onboarding'
    ? `Your Cortex workspace for ${orgName} is ready`
    : `${orgName} invited you to Cortex`;
  const welcome = input.welcome?.trim() || 'Your Cortex brain is ready. Connect your agent with the link below.';
  const bodyText = [
    welcome,
    '',
    input.onboardingUrl ? `Onboarding URL: ${input.onboardingUrl}` : 'Open the Cortex onboarding page from your admin console.',
    'The OAuth client secret is shown once in Cortex and is not included in this email.',
  ].join('\n');
  const provider = input.provider?.trim() || process.env.CORTEX_EMAIL_PROVIDER?.trim() || 'outbox';
  const status = provider === 'outbox' ? 'queued' : 'pending_provider';
  const rows = await engine.executeRaw(
    `INSERT INTO saas_email_deliveries
       (id, org_id, invite_id, email, kind, status, provider, subject, body_text, onboarding_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, org_id, invite_id, email, kind, status, provider, provider_message_id,
                 subject, body_text, onboarding_url, attempts, last_error, sent_at, created_at, updated_at`,
    [
      makeSaasId('msg'),
      input.orgId,
      input.inviteId || null,
      email,
      kind,
      status,
      provider,
      subject,
      bodyText,
      input.onboardingUrl || null,
    ],
  );
  return mapEmailDelivery(rows[0]);
}

export async function listEmailDeliveries(
  engine: BrainEngine,
  input: { orgId?: string | null; inviteId?: string | null; limit?: number | null } = {},
): Promise<SaasEmailDelivery[]> {
  await ensureSaasControlPlane(engine);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (input.orgId) {
    params.push(input.orgId);
    filters.push(`org_id = $${params.length}`);
  }
  if (input.inviteId) {
    params.push(input.inviteId);
    filters.push(`invite_id = $${params.length}`);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  params.push(limit);
  const rows = await engine.executeRaw(
    `SELECT id, org_id, invite_id, email, kind, status, provider, provider_message_id,
            subject, body_text, onboarding_url, attempts, last_error, sent_at, created_at, updated_at
       FROM saas_email_deliveries
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapEmailDelivery);
}

export async function claimEmailDeliveries(
  engine: BrainEngine,
  input: {
    orgId?: string | null;
    inviteId?: string | null;
    provider?: string | null;
    statuses?: unknown[] | null;
    limit?: number | null;
  } = {},
): Promise<SaasEmailDelivery[]> {
  await ensureSaasControlPlane(engine);
  const filters: string[] = [];
  const params: unknown[] = [];
  const statuses = (input.statuses || [])
    .map(normalizeEmailDeliveryClaimStatus)
    .filter((status): status is SaasEmailDeliveryClaimStatus => Boolean(status));
  const effectiveStatuses = statuses.length > 0 ? Array.from(new Set(statuses)) : ['queued', 'pending_provider'] as SaasEmailDeliveryClaimStatus[];
  const statusPlaceholders = effectiveStatuses.map((status) => {
    params.push(status);
    return `$${params.length}`;
  });
  filters.push(`status IN (${statusPlaceholders.join(', ')})`);
  if (input.orgId) {
    params.push(input.orgId);
    filters.push(`org_id = $${params.length}`);
  }
  if (input.inviteId) {
    params.push(input.inviteId);
    filters.push(`invite_id = $${params.length}`);
  }
  if (input.provider) {
    params.push(input.provider);
    filters.push(`provider = $${params.length}`);
  }
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  params.push(limit);
  const rows = await engine.executeRaw(
    `WITH picked AS (
       SELECT id
         FROM saas_email_deliveries
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT $${params.length}
     )
     UPDATE saas_email_deliveries d
        SET status = 'sending',
            attempts = d.attempts + 1,
            last_error = NULL,
            updated_at = now()
       FROM picked
      WHERE d.id = picked.id
      RETURNING d.id, d.org_id, d.invite_id, d.email, d.kind, d.status, d.provider, d.provider_message_id,
                d.subject, d.body_text, d.onboarding_url, d.attempts, d.last_error, d.sent_at, d.created_at, d.updated_at`,
    params,
  );
  return rows.map(mapEmailDelivery);
}

export async function markEmailDeliveryResult(
  engine: BrainEngine,
  input: {
    id: string;
    status: SaasEmailDeliveryResultStatus | string;
    provider?: string | null;
    providerMessageId?: string | null;
    lastError?: string | null;
  },
): Promise<SaasEmailDelivery> {
  await ensureSaasControlPlane(engine);
  const id = input.id.trim();
  if (!id) throw new Error('delivery_id_required');
  const status = normalizeEmailDeliveryResultStatus(input.status);
  const rows = await engine.executeRaw(
    `UPDATE saas_email_deliveries
        SET status = $2,
            provider = COALESCE($3, provider),
            provider_message_id = COALESCE($4, provider_message_id),
            last_error = $5,
            sent_at = CASE
              WHEN $2 = 'sent' THEN now()
              WHEN $2 = 'failed' THEN NULL
              ELSE sent_at
            END,
            updated_at = now()
      WHERE id = $1
      RETURNING id, org_id, invite_id, email, kind, status, provider, provider_message_id,
                subject, body_text, onboarding_url, attempts, last_error, sent_at, created_at, updated_at`,
    [
      id,
      status,
      input.provider?.trim() || null,
      input.providerMessageId?.trim() || null,
      status === 'failed' ? (input.lastError?.trim() || 'delivery_failed') : null,
    ],
  );
  if (!rows[0]) throw new Error('unknown_delivery');
  return mapEmailDelivery(rows[0]);
}

export async function listSkillPolicies(engine: BrainEngine): Promise<SaasSkillPolicy[]> {
  await ensureSaasControlPlane(engine);
  const rows = await engine.executeRaw(
    `SELECT id, name, owner, status, triggers, allowed_clients, source_access, last_run_at,
            description, enforcement_status, metadata, created_at, updated_at
       FROM saas_skill_policies
      ORDER BY updated_at DESC, name ASC`,
  );
  return rows.map(mapSkillPolicy);
}

export async function getSkillPolicy(engine: BrainEngine, id: string): Promise<SaasSkillPolicy | null> {
  await ensureSaasControlPlane(engine);
  const normalized = normalizeSkillId(id);
  if (!normalized) return null;
  const rows = await engine.executeRaw(
    `SELECT id, name, owner, status, triggers, allowed_clients, source_access, last_run_at,
            description, enforcement_status, metadata, created_at, updated_at
       FROM saas_skill_policies
      WHERE id = $1`,
    [normalized],
  );
  return rows[0] ? mapSkillPolicy(rows[0]) : null;
}

export async function upsertSkillPolicy(
  engine: BrainEngine,
  input: {
    id: string;
    name: string;
    owner?: string | null;
    status?: SaasSkillStatus;
    triggers?: string[];
    allowedClients?: string[];
    sourceAccess?: string[];
    lastRunAt?: Date | string | null;
    description?: string | null;
    enforcementStatus?: SaasSkillEnforcementStatus;
    metadata?: Record<string, unknown>;
  },
): Promise<SaasSkillPolicy> {
  await ensureSaasControlPlane(engine);
  const id = normalizeSkillId(input.id);
  if (!id) throw new Error('skill id is required');
  const existing = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM saas_skill_policies WHERE id = $1`,
    [id],
  );
  const firstOrg = await firstOrganizationId(engine);
  if (existing.length === 0 && firstOrg) await assertSaasPlanAllows(engine, firstOrg, 'skill_policies');
  const name = input.name.trim();
  if (!name) throw new Error('skill name is required');
  const owner = input.owner?.trim() || 'workspace';
  const status = input.status || 'draft';
  const triggers = Array.from(new Set((input.triggers || []).map(v => v.trim()).filter(Boolean)));
  const allowedClients = Array.from(new Set((input.allowedClients || []).map(v => v.trim()).filter(Boolean)));
  const sourceAccess = Array.from(new Set((input.sourceAccess && input.sourceAccess.length > 0 ? input.sourceAccess : ['default']).map(v => v.trim()).filter(Boolean)));
  const description = input.description?.trim() || '';
  const enforcementStatus = allowedClients.length > 0
    ? 'enforced'
    : (input.enforcementStatus === 'needs_enforcement' ? 'needs_enforcement' : 'not_enforced');
  const rows = await engine.executeRaw(
    `INSERT INTO saas_skill_policies
       (id, name, owner, status, triggers, allowed_clients, source_access, last_run_at, description, enforcement_status, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         owner = excluded.owner,
         status = excluded.status,
         triggers = excluded.triggers,
         allowed_clients = excluded.allowed_clients,
         source_access = excluded.source_access,
         last_run_at = excluded.last_run_at,
         description = excluded.description,
         enforcement_status = excluded.enforcement_status,
         metadata = excluded.metadata,
         updated_at = now()
       RETURNING id, name, owner, status, triggers, allowed_clients, source_access,
                 last_run_at, description, enforcement_status, metadata, created_at, updated_at`,
    [
      id,
      name,
      owner,
      status,
      JSON.stringify(triggers),
      JSON.stringify(allowedClients),
      JSON.stringify(sourceAccess),
      input.lastRunAt || null,
      description,
      enforcementStatus,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return mapSkillPolicy(rows[0]);
}
