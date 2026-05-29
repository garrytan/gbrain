import { VERSION } from '../version.ts';

export type RuntimeId =
  | 'cortex_cli'
  | 'claude_code'
  | 'cursor'
  | 'chatgpt'
  | 'claude_desktop'
  | 'perplexity';

export interface RuntimeSetup {
  id: RuntimeId;
  label: string;
  kind: 'cli' | 'config' | 'connector';
  install?: string;
  command?: string;
  config_path?: string;
  config?: Record<string, unknown>;
  connector?: Record<string, unknown>;
  notes: string[];
}

export type RuntimePackageId =
  | 'cortex_cli'
  | 'cursor_adapter'
  | 'claude_desktop_adapter'
  | 'claude_code_helper'
  | 'chatgpt_connector'
  | 'perplexity_connector';

export interface RuntimePackage {
  id: RuntimePackageId;
  label: string;
  kind: 'cli' | 'adapter' | 'connector_template';
  distribution: 'package' | 'built_in_cli' | 'connector_instructions';
  install: string;
  artifact: string;
  supported_runtimes: RuntimeId[];
  verification: string[];
  notes: string[];
}

export interface SaasRuntimeManifest {
  schema: 'cortex.runtime-manifest.v1';
  generated_at: string;
  product: {
    name: 'Cortex Company Brain';
    package: 'cortex';
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
    secret_delivery: 'shown_once_out_of_band';
    connect_command: string;
    env_connect_command: string;
  };
  runtimes: Record<RuntimeId, RuntimeSetup>;
  packages: Record<RuntimePackageId, RuntimePackage>;
  agent_parity: {
    principle: string;
    operations: Array<{ name: string; scope: string; purpose: string }>;
  };
  skill_policy: {
    annotation_keys: string[];
    enforcement: string;
  };
}

export interface SaasRuntimePackageIndex {
  schema: 'cortex.runtime-package-index.v1';
  generated_at: string;
  product: {
    name: 'Cortex Company Brain';
    package: 'cortex-brain';
    version: string;
  };
  endpoints: {
    runtime_manifest: string;
    runtime_package: string;
    mcp_url: string;
    token_url: string;
  };
  packages: Record<RuntimePackageId, RuntimePackage>;
  runtimes: Record<RuntimeId, RuntimeSetup>;
  verification: string[];
  agent_parity: SaasRuntimeManifest['agent_parity'];
}

export interface BuildRuntimeManifestInput {
  publicUrl?: string | null;
  mcpUrl?: string | null;
  tokenUrl?: string | null;
  onboardingUrl?: string | null;
  clientId?: string | null;
  orgId?: string | null;
  brainId?: string | null;
  email?: string | null;
  role?: string | null;
  sourceId?: string | null;
  federatedRead?: string[] | null;
  scopes?: string | string[] | null;
  clientSecretPlaceholder?: string | null;
  generatedAt?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function runtimeBaseUrl(input?: string | null): string {
  const explicit = input?.trim();
  const configured = process.env.CORTEX_PUBLIC_URL?.trim() || process.env.GBRAIN_PUBLIC_URL?.trim();
  return trimTrailingSlash(explicit || configured || 'https://<your-cortex-host>');
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.map(v => String(v).trim()).filter(Boolean);
    return items.length > 0 ? Array.from(new Set(items)) : fallback;
  }
  if (typeof value === 'string') {
    const items = value.split(/[,\s]+/g).map(v => v.trim()).filter(Boolean);
    return items.length > 0 ? Array.from(new Set(items)) : fallback;
  }
  return fallback;
}

function remoteMcpConfig(mcpUrl: string) {
  return {
    mcpServers: {
      cortex: {
        url: mcpUrl,
        transport: 'sse',
      },
    },
  };
}

export function buildSaasRuntimeManifest(input: BuildRuntimeManifestInput = {}): SaasRuntimeManifest {
  const baseUrl = runtimeBaseUrl(input.publicUrl);
  const mcpUrl = input.mcpUrl?.trim() || `${baseUrl}/mcp`;
  const tokenUrl = input.tokenUrl?.trim() || `${baseUrl}/token`;
  const onboardingUrl = input.onboardingUrl?.trim() || `${baseUrl}/admin/onboarding?invite=<invite-payload>`;
  const sourceId = input.sourceId?.trim() || 'default';
  const federatedRead = stringList(input.federatedRead, [sourceId]);
  const scopes = stringList(input.scopes, ['read', 'write']);
  const secret = input.clientSecretPlaceholder?.trim() || '<one-time-secret>';
  const connectCommand = `cortex connect '${onboardingUrl}' --client-secret '${secret}'`;
  const envConnectCommand = `CORTEX_REMOTE_CLIENT_SECRET='${secret}' cortex connect '${onboardingUrl}'`;

  const remoteRuntimeNotes = [
    'Use the hosted MCP URL directly so the runtime connects to the tenant control plane.',
    'OAuth discovery and source scoping stay on the Cortex host.',
  ];

  return {
    schema: 'cortex.runtime-manifest.v1',
    generated_at: input.generatedAt || new Date().toISOString(),
    product: {
      name: 'Cortex Company Brain',
      package: 'cortex',
      version: VERSION,
    },
    tenant: {
      org_id: input.orgId || null,
      brain_id: input.brainId || null,
      email: input.email || null,
      role: input.role || null,
    },
    endpoints: {
      base_url: baseUrl,
      mcp_url: mcpUrl,
      token_url: tokenUrl,
      oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      oauth_protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      runtime_manifest: `${baseUrl}/runtime-manifest.json`,
      runtime_package: `${baseUrl}/runtime-package.json`,
    },
    onboarding: {
      onboarding_url: onboardingUrl,
      client_id: input.clientId || null,
      source_id: sourceId,
      federated_read: federatedRead,
      scopes,
      secret_delivery: 'shown_once_out_of_band',
      connect_command: connectCommand,
      env_connect_command: envConnectCommand,
    },
    runtimes: {
      cortex_cli: {
        id: 'cortex_cli',
        label: 'Cortex CLI',
        kind: 'cli',
        install: 'Install the Cortex CLI from the onboarding bundle, then run the connect command.',
        command: connectCommand,
        notes: [
          'Creates a Cortex thin-client profile for this hosted tenant.',
          'Does not create a local database or standalone brain.',
        ],
      },
      claude_code: {
        id: 'claude_code',
        label: 'Claude Code',
        kind: 'cli',
        command: `claude mcp add --transport http cortex ${mcpUrl}`,
        notes: remoteRuntimeNotes,
      },
      cursor: {
        id: 'cursor',
        label: 'Cursor',
        kind: 'config',
        config_path: '.cursor/mcp.json',
        config: remoteMcpConfig(mcpUrl),
        notes: remoteRuntimeNotes,
      },
      chatgpt: {
        id: 'chatgpt',
        label: 'ChatGPT connector',
        kind: 'connector',
        connector: {
          server_url: mcpUrl,
          auth_type: 'oauth2_client_credentials',
          token_url: tokenUrl,
          client_id: input.clientId || '<client-id-from-invite>',
          scopes,
        },
        notes: [
          'Use the hosted MCP URL and OAuth metadata from this manifest.',
          'The client secret is delivered once by the invite or signup response.',
        ],
      },
      claude_desktop: {
        id: 'claude_desktop',
        label: 'Claude Desktop',
        kind: 'config',
        config_path: 'claude_desktop_config.json',
        config: remoteMcpConfig(mcpUrl),
        notes: remoteRuntimeNotes,
      },
      perplexity: {
        id: 'perplexity',
        label: 'Perplexity connector',
        kind: 'connector',
        connector: {
          server_url: mcpUrl,
          auth_type: 'oauth2_client_credentials',
          token_url: tokenUrl,
          client_id: input.clientId || '<client-id-from-invite>',
          scopes,
        },
        notes: [
          'Use the connector flow that accepts a remote MCP URL and OAuth client credentials.',
          'Keep source scope in Cortex; do not duplicate source filtering in the runtime.',
        ],
      },
    },
    packages: {
      cortex_cli: {
        id: 'cortex_cli',
        label: 'Cortex CLI',
        kind: 'cli',
        distribution: 'package',
        install: 'Install the Cortex CLI package that exposes the `cortex` binary.',
        artifact: 'cortex',
        supported_runtimes: ['cortex_cli', 'cursor', 'claude_desktop', 'claude_code', 'chatgpt', 'perplexity'],
        verification: [
          'cortex --version',
          'cortex connect <onboarding-url> --client-secret <secret>',
          'cortex runtime install cursor --manifest-url <runtime-manifest-url>',
        ],
        notes: [
          'The CLI creates a hosted thin-client profile and runtime configs.',
          'It must not create a local standalone database for invited users or agents.',
        ],
      },
      cursor_adapter: {
        id: 'cursor_adapter',
        label: 'Cursor adapter',
        kind: 'adapter',
        distribution: 'built_in_cli',
        install: 'Run `cortex runtime install cursor` after connecting the tenant.',
        artifact: '.cursor/mcp.json',
        supported_runtimes: ['cursor'],
        verification: ['cortex runtime install cursor --json'],
        notes: [
          'Writes mcpServers.cortex.url to the hosted MCP endpoint.',
          'Does not write OAuth client secrets into Cursor config.',
        ],
      },
      claude_desktop_adapter: {
        id: 'claude_desktop_adapter',
        label: 'Claude Desktop adapter',
        kind: 'adapter',
        distribution: 'built_in_cli',
        install: 'Run `cortex runtime install claude-desktop` after connecting the tenant.',
        artifact: 'claude_desktop_config.json',
        supported_runtimes: ['claude_desktop'],
        verification: ['cortex runtime install claude-desktop --json'],
        notes: [
          'Writes a Cortex MCP server entry for the hosted endpoint.',
          'Keeps the one-time secret out of the desktop config.',
        ],
      },
      claude_code_helper: {
        id: 'claude_code_helper',
        label: 'Claude Code helper',
        kind: 'adapter',
        distribution: 'built_in_cli',
        install: 'Run `cortex runtime install claude-code --json` and execute the emitted command if needed.',
        artifact: 'claude mcp add command',
        supported_runtimes: ['claude_code'],
        verification: ['cortex runtime install claude-code --mcp-url <mcp-url> --json'],
        notes: [
          'Emits the native Claude Code MCP registration command.',
          'The command points at the hosted MCP URL.',
        ],
      },
      chatgpt_connector: {
        id: 'chatgpt_connector',
        label: 'ChatGPT connector template',
        kind: 'connector_template',
        distribution: 'connector_instructions',
        install: 'Use the connector object from runtimes.chatgpt with the invite client id and one-time secret.',
        artifact: 'connector metadata',
        supported_runtimes: ['chatgpt'],
        verification: ['Fetch runtime manifest and confirm connector.server_url matches endpoints.mcp_url.'],
        notes: [
          'Connector setup uses OAuth metadata from the tenant.',
          'Source scoping stays enforced by Cortex.',
        ],
      },
      perplexity_connector: {
        id: 'perplexity_connector',
        label: 'Perplexity connector template',
        kind: 'connector_template',
        distribution: 'connector_instructions',
        install: 'Use the connector object from runtimes.perplexity with the invite client id and one-time secret.',
        artifact: 'connector metadata',
        supported_runtimes: ['perplexity'],
        verification: ['Fetch runtime manifest and confirm connector.server_url matches endpoints.mcp_url.'],
        notes: [
          'Connector setup uses OAuth metadata from the tenant.',
          'Source scoping stays enforced by Cortex.',
        ],
      },
    },
    agent_parity: {
      principle: 'Every tenant action available in the console has an agent-callable MCP operation.',
      operations: [
        { name: 'saas_signup_create', scope: 'users_admin', purpose: 'Create org, first brain, owner client, invite, and onboarding URL.' },
        { name: 'saas_orgs_list', scope: 'users_admin', purpose: 'List SaaS organizations.' },
        { name: 'saas_orgs_create', scope: 'users_admin', purpose: 'Create a tenant organization.' },
        { name: 'saas_brains_list', scope: 'users_admin', purpose: 'List tenant brain boundaries.' },
        { name: 'saas_brains_create', scope: 'users_admin', purpose: 'Create another brain when a hard isolation boundary is needed.' },
        { name: 'saas_sources_list', scope: 'users_admin', purpose: 'List org-scoped source boundaries available for ingestion, invites, skills, and agents.' },
        { name: 'saas_sources_create', scope: 'users_admin', purpose: 'Create and link an org-scoped source with tenant plan enforcement.' },
        { name: 'saas_integrations_status', scope: 'users_admin', purpose: 'Inspect Composio connector readiness, webhook URL, required environment, and source-link status.' },
        { name: 'saas_team_list', scope: 'users_admin', purpose: 'List teammates and scoped OAuth clients.' },
        { name: 'saas_invites_list', scope: 'users_admin', purpose: 'List onboarding invites.' },
        { name: 'saas_invite_deliveries_list', scope: 'users_admin', purpose: 'List queued and sent invite delivery records.' },
        { name: 'saas_invite_delivery_queue', scope: 'users_admin', purpose: 'Queue or re-queue an onboarding email delivery.' },
        { name: 'saas_invite_deliveries_claim', scope: 'users_admin', purpose: 'Claim invite delivery records for an email worker or agent delivery job.' },
        { name: 'saas_invite_delivery_mark', scope: 'users_admin', purpose: 'Mark invite delivery records as sent, failed, queued, or pending provider.' },
        { name: 'saas_invite_deliveries_drain', scope: 'users_admin', purpose: 'Drain claimed invite delivery records through the configured transactional email provider.' },
        { name: 'users_create_invite', scope: 'users_admin', purpose: 'Invite a teammate or agent and return one-time credentials.' },
        { name: 'users_register_agent_client', scope: 'users_admin', purpose: 'Create a scoped OAuth client without creating a teammate invite.' },
        { name: 'users_update_agent_client_ttl', scope: 'users_admin', purpose: 'Update or clear a scoped OAuth client token lifetime.' },
        { name: 'users_revoke_agent_client', scope: 'users_admin', purpose: 'Revoke a scoped OAuth client and delete its active tokens.' },
        { name: 'saas_skills_list', scope: 'users_admin', purpose: 'List skill policies.' },
        { name: 'saas_skills_upsert', scope: 'users_admin', purpose: 'Create or update source/client-scoped skill policy.' },
        { name: 'saas_runtime_manifest', scope: 'users_admin', purpose: 'Return this runtime packaging contract for agents and UI.' },
        { name: 'saas_runtime_package_index', scope: 'users_admin', purpose: 'Return the hosted runtime package index for CLI/plugin/runtime distribution.' },
        { name: 'saas_plan_get', scope: 'users_admin', purpose: 'Inspect tenant plan usage, remaining capacity, and hard-limit violations.' },
        { name: 'saas_plan_update', scope: 'users_admin', purpose: 'Update tenant plan tier, billing metadata, and explicit usage limits.' },
        { name: 'saas_console_snapshot', scope: 'users_admin', purpose: 'Return the operator console snapshot: stats, token health, agents, recent requests, and jobs.' },
        { name: 'saas_quality_snapshot', scope: 'users_admin', purpose: 'Return the investor/demo readiness gates shared by the Quality console page and agent workflows.' },
      ],
    },
    skill_policy: {
      annotation_keys: ['_skill_id', 'skill_id', '_meta.skill_id'],
      enforcement: 'Runtime adapters must pass a skill id on skill-backed MCP calls; dispatch blocks draft or disallowed skill policies before the operation runs.',
    },
  };
}

export function buildSaasRuntimePackageIndex(input: BuildRuntimeManifestInput = {}): SaasRuntimePackageIndex {
  const manifest = buildSaasRuntimeManifest(input);
  return {
    schema: 'cortex.runtime-package-index.v1',
    generated_at: manifest.generated_at,
    product: {
      name: 'Cortex Company Brain',
      package: 'cortex-brain',
      version: VERSION,
    },
    endpoints: {
      runtime_manifest: manifest.endpoints.runtime_manifest,
      runtime_package: manifest.endpoints.runtime_package,
      mcp_url: manifest.endpoints.mcp_url,
      token_url: manifest.endpoints.token_url,
    },
    packages: manifest.packages,
    runtimes: manifest.runtimes,
    verification: [
      'cortex --version',
      'cortex connect <onboarding-url> --client-secret <one-time-secret>',
      `cortex runtime install cursor --manifest-url ${manifest.endpoints.runtime_manifest} --json`,
      `cortex runtime install claude-code --mcp-url ${manifest.endpoints.mcp_url} --json`,
    ],
    agent_parity: manifest.agent_parity,
  };
}
