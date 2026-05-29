export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: string;
  created_at: string;
}

export interface BrainSummary {
  id: string;
  org_id: string;
  name: string;
  public_url: string | null;
  region: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SourceSummary {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  writeSource: string;
  readableSources: string[];
  status: 'active' | 'invited';
  lastActive: string;
}

export interface ControlPlaneMember {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  status: 'active' | 'invited' | 'pending_provisioning' | string;
  source_id: string;
  federated_read: string[];
  oauth_client_id: string | null;
  last_active_at: string | null;
  created_at: string;
}

export interface InviteDelivery {
  id: string;
  org_id: string;
  invite_id: string | null;
  email: string;
  kind: 'owner_onboarding' | 'teammate_invite';
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

export interface InviteDeliveryDrainResult {
  provider: string;
  configured: boolean;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  required_env: string[];
  message?: string;
  deliveries: InviteDelivery[];
  results: Array<{
    delivery_id: string;
    email: string;
    status: 'sent' | 'failed';
    provider: string;
    provider_message_id: string | null;
    last_error: string | null;
  }>;
}

export interface SkillSummary {
  id: string;
  name: string;
  owner: string;
  status: 'installed' | 'draft' | 'needs-enforcement';
  triggers: string[];
  allowedClients: string[];
  sourceAccess: string[];
  lastRun: string;
  description: string;
  enforcementStatus: 'enforced' | 'not_enforced' | 'needs_enforcement';
  persisted?: boolean;
}

export type PlanUsageKey =
  | 'brains'
  | 'sources'
  | 'members'
  | 'pending_invites'
  | 'agent_clients'
  | 'skill_policies'
  | 'requests_today'
  | 'waiting_jobs';

export type PlanKey = 'launch' | 'team' | 'business' | 'enterprise';

export interface PlanSummary {
  org_id: string;
  plan_key: PlanKey;
  status: string;
  billing_customer_id: string | null;
  billing_provider: string | null;
  billing_subscription_id: string | null;
  billing_plan_ref: string | null;
  billing_current_period_end: string | null;
  billing_event_id: string | null;
  billing_synced_at: string | null;
  limits: Record<PlanUsageKey, number | null>;
  usage: Record<PlanUsageKey, number>;
  remaining: Record<PlanUsageKey, number | null>;
  violations: PlanUsageKey[];
  created_at: string;
  updated_at: string;
}

export interface InviteDraft {
  email: string;
  role: OrgRole;
  writeSource: string;
  readableSources: string[];
  welcome: string;
}

export interface RuntimeSetup {
  id: string;
  label: string;
  kind: 'cli' | 'config' | 'connector';
  install?: string;
  command?: string;
  config_path?: string;
  config?: Record<string, unknown>;
  connector?: Record<string, unknown>;
  notes: string[];
}

export interface RuntimePackage {
  id: string;
  label: string;
  kind: 'cli' | 'adapter' | 'connector_template';
  distribution: 'package' | 'built_in_cli' | 'connector_instructions';
  install: string;
  artifact: string;
  supported_runtimes: string[];
  verification: string[];
  notes: string[];
}

export interface RuntimeManifest {
  schema: string;
  generated_at: string;
  product: {
    name: string;
    package: string;
    version: string;
  };
  tenant: {
    org_id: string | null;
    brain_id: string | null;
    email: string | null;
    role: string | null;
  };
  endpoints: {
    base_url: string;
    mcp_url: string;
    token_url: string;
    oauth_authorization_server: string;
    oauth_protected_resource: string;
    runtime_manifest: string;
    runtime_package: string;
  };
  onboarding: {
    onboarding_url: string;
    client_id: string | null;
    source_id: string;
    federated_read: string[];
    scopes: string[];
    secret_delivery: string;
    connect_command: string;
    env_connect_command: string;
  };
  runtimes: Record<string, RuntimeSetup>;
  packages?: Record<string, RuntimePackage>;
  agent_parity: {
    principle: string;
    operations: Array<{ name: string; scope: string; purpose: string }>;
  };
  skill_policy: {
    annotation_keys: string[];
    enforcement: string;
  };
}

export interface QualityCheck {
  area: string;
  signal: string;
  status: string;
  detail: string;
  passed: boolean;
  remediation: string | null;
}

export interface QualitySnapshot {
  schema: string;
  generated_at: string;
  version: string;
  readiness: {
    score: number;
    passed: number;
    total: number;
    status: string;
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
  deployment?: {
    engine_kind: 'postgres' | 'pglite';
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
  };
  checks: QualityCheck[];
  runtime_manifest: RuntimeManifest;
  integrations: {
    configured: boolean;
    apiKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    webhookUrl: string;
    connectors: Array<{ id: string; connected: boolean }>;
  };
  sources: SourceSummary[];
  skills: SkillSummary[];
}

export function sanitizeCortexCopy(value: string): string {
  return value;
}

function sanitizeCortexList(values: string[]): string[] {
  return values.map(sanitizeCortexCopy);
}

export function sanitizeSkillSummary(skill: SkillSummary): SkillSummary {
  return {
    ...skill,
    name: sanitizeCortexCopy(skill.name),
    triggers: sanitizeCortexList(skill.triggers || []),
    allowedClients: sanitizeCortexList(skill.allowedClients || []),
    description: sanitizeCortexCopy(skill.description || ''),
  };
}

export const roleScopes: Record<OrgRole, string> = {
  owner: 'admin sources_admin users_admin read write',
  admin: 'admin sources_admin users_admin read write',
  member: 'read write',
  viewer: 'read',
};

export const seedSources: SourceSummary[] = [
  {
    id: 'default',
    name: 'Company Core',
    local_path: null,
    remote_url: null,
    federated: true,
    page_count: 0,
    last_sync_at: null,
  },
  {
    id: 'engineering',
    name: 'Engineering',
    local_path: null,
    remote_url: null,
    federated: true,
    page_count: 0,
    last_sync_at: null,
  },
  {
    id: 'customers',
    name: 'Customers',
    local_path: null,
    remote_url: null,
    federated: false,
    page_count: 0,
    last_sync_at: null,
  },
];

export const seedMembers: TeamMember[] = [
  {
    id: 'owner',
    name: 'Workspace Owner',
    email: 'owner@company.com',
    role: 'owner',
    writeSource: 'default',
    readableSources: ['default', 'engineering', 'customers'],
    status: 'active',
    lastActive: 'now',
  },
  {
    id: 'agent-admin',
    name: 'Cortex Setup Agent',
    email: 'agent@company.com',
    role: 'admin',
    writeSource: 'default',
    readableSources: ['default'],
    status: 'active',
    lastActive: '5m ago',
  },
];

export const seedSkills: SkillSummary[] = [
  {
    id: 'company-research',
    name: 'Company Research',
    owner: 'growth',
    status: 'installed',
    triggers: ['research customer', 'summarize company', 'prep account'],
    allowedClients: ['sales-agent', 'exec-assistant'],
    sourceAccess: ['customers', 'default'],
    lastRun: '18m ago',
    description: 'Turns account notes, meeting history, and external research into a cited brief.',
    enforcementStatus: 'needs_enforcement',
    persisted: false,
  },
  {
    id: 'engineering-incident',
    name: 'Incident Brief',
    owner: 'engineering',
    status: 'installed',
    triggers: ['what broke', 'incident summary', 'postmortem draft'],
    allowedClients: ['eng-agent'],
    sourceAccess: ['engineering'],
    lastRun: '2h ago',
    description: 'Reads runbooks and recent changes before drafting incident context.',
    enforcementStatus: 'needs_enforcement',
    persisted: false,
  },
  {
    id: 'board-pack',
    name: 'Board Pack Assistant',
    owner: 'finance',
    status: 'needs-enforcement',
    triggers: ['board packet', 'monthly metrics', 'investor update'],
    allowedClients: ['exec-agent'],
    sourceAccess: ['default'],
    lastRun: 'not run',
    description: 'Requires the agent runtime to pass skill_id on MCP calls before production use.',
    enforcementStatus: 'needs_enforcement',
    persisted: false,
  },
];

export function sourceOptions(sources: SourceSummary[]): SourceSummary[] {
  return sources.length > 0 ? sources : seedSources;
}

export function mapControlMember(member: ControlPlaneMember): TeamMember {
  return {
    id: member.id,
    name: member.email.split('@')[0],
    email: member.email,
    role: member.role,
    writeSource: member.source_id,
    readableSources: member.federated_read,
    status: member.status === 'active' ? 'active' : 'invited',
    lastActive: member.last_active_at ? new Date(member.last_active_at).toLocaleString() : member.status,
  };
}

export function encodeOnboardingPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function buildOnboardingUrl(payload: Record<string, unknown>): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/admin/onboarding?invite=${encodeOnboardingPayload(payload)}`;
}

export function mcpServerUrl(): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/mcp`;
}

export function tokenUrl(): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/token`;
}
