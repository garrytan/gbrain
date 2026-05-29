import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type AuthInfo, type Operation, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function findOp(name: string): Operation {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`op not found: ${name}`);
  return op;
}

function ctx(): OperationContext {
  const auth: AuthInfo = {
    token: 'cortex_at_users_admin',
    clientId: 'cortex_cl_admin',
    clientName: 'admin-agent',
    scopes: ['users_admin'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  return {
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    auth,
    sourceId: 'default',
  };
}

describe('saas control-plane agent operations', () => {
  test('are users_admin-scoped and remote-callable', () => {
    for (const name of [
      'saas_signup_create',
      'saas_orgs_list',
      'saas_orgs_create',
      'saas_brains_list',
      'saas_brains_create',
      'saas_sources_list',
      'saas_sources_create',
      'saas_integrations_status',
      'saas_team_list',
      'saas_invites_list',
      'saas_invite_deliveries_list',
      'saas_invite_delivery_queue',
      'saas_invite_deliveries_claim',
      'saas_invite_delivery_mark',
      'saas_invite_deliveries_drain',
      'saas_skills_list',
      'saas_skills_upsert',
      'saas_runtime_manifest',
      'saas_runtime_package_index',
      'saas_plan_get',
      'saas_plan_update',
      'saas_console_snapshot',
      'saas_quality_snapshot',
      'users_register_agent_client',
      'users_update_agent_client_ttl',
      'users_revoke_agent_client',
      'users_create_invite',
    ]) {
      const op = findOp(name);
      expect(op.scope).toBe('users_admin');
      expect(op.localOnly).toBeFalsy();
    }
    expect(findOp('saas_signup_create').mutating).toBe(true);
    expect(findOp('saas_orgs_create').mutating).toBe(true);
    expect(findOp('saas_brains_create').mutating).toBe(true);
    expect(findOp('saas_sources_create').mutating).toBe(true);
    expect(findOp('saas_skills_upsert').mutating).toBe(true);
    expect(findOp('saas_plan_update').mutating).toBe(true);
    expect(findOp('saas_invite_delivery_queue').mutating).toBe(true);
    expect(findOp('saas_invite_deliveries_claim').mutating).toBe(true);
    expect(findOp('saas_invite_delivery_mark').mutating).toBe(true);
    expect(findOp('saas_invite_deliveries_drain').mutating).toBe(true);
    expect(findOp('users_register_agent_client').mutating).toBe(true);
    expect(findOp('users_update_agent_client_ttl').mutating).toBe(true);
    expect(findOp('users_revoke_agent_client').mutating).toBe(true);
    expect(findOp('users_create_invite').mutating).toBe(true);
  });

  test('creates a full signup and returns an onboarding URL', async () => {
    const result = await findOp('saas_signup_create').handler(ctx(), {
      org_name: 'Acme AI',
      email: 'Founder@Acme.ai',
      domain: 'acme.ai',
      brain_name: 'Acme Company Brain',
      public_url: 'https://cortex.example',
      region: 'iad',
    }) as {
      org: { id: string; slug: string; name: string };
      brain: { id: string; org_id: string; name: string; status: string; metadata: Record<string, unknown> };
      member: { email: string; role: string; status: string; oauth_client_id: string };
      invite: { email: string; role: string; onboarding_url: string; oauth_client_id: string };
      invite_delivery: { email: string; status: string; provider: string };
      onboarding_url: string;
      client_id: string;
      client_secret: string;
      runtime_manifest: { schema: string; endpoints: { mcp_url: string }; onboarding: { connect_command: string } };
      provisioning_required: boolean;
    };

    expect(result.org.slug).toBe('acme-ai');
    expect(result.brain.org_id).toBe(result.org.id);
    expect(result.brain.status).toBe('online');
    expect(result.brain.metadata.signup_source).toBe('agent');
    expect(result.member.email).toBe('founder@acme.ai');
    expect(result.member.role).toBe('owner');
    expect(result.member.status).toBe('active');
    expect(result.member.oauth_client_id).toBe(result.client_id);
    expect(result.invite.onboarding_url).toBe(result.onboarding_url);
    expect(result.invite.oauth_client_id).toBe(result.client_id);
    expect(result.invite_delivery.email).toBe('founder@acme.ai');
    expect(result.invite_delivery.status).toBe('queued');
    expect(result.invite_delivery.provider).toBe('outbox');
    expect(result.client_id).toStartWith('cortex_cl_');
    expect(result.client_secret).toStartWith('cortex_cs_');
    expect(result.runtime_manifest.schema).toBe('cortex.runtime-manifest.v1');
    expect(result.runtime_manifest.endpoints.mcp_url).toBe('https://cortex.example/mcp');
    expect(result.runtime_manifest.onboarding.connect_command).toContain(result.client_secret);
    expect(result.provisioning_required).toBe(false);
    expect(result.onboarding_url).toStartWith('https://cortex.example/admin/onboarding?invite=');

    const encoded = result.onboarding_url.split('invite=')[1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      org_id: string;
      brain_id: string;
      email: string;
      server_url: string;
      token_url: string;
      client_id: string;
      status: string;
    };
    expect(payload.org_id).toBe(result.org.id);
    expect(payload.brain_id).toBe(result.brain.id);
    expect(payload.email).toBe('founder@acme.ai');
    expect(payload.server_url).toBe('https://cortex.example/mcp');
    expect(payload.token_url).toBe('https://cortex.example/token');
    expect(payload.client_id).toBe(result.client_id);
    expect(payload.status).toBe('ready');

    const clients = await engine.executeRaw<{ client_name: string; scope: string }>(
      `SELECT client_name, scope FROM oauth_clients WHERE client_id = $1`,
      [result.client_id],
    );
    expect(clients[0].client_name).toBe('founder@acme.ai');
    expect(clients[0].scope).toContain('users_admin');
  });

  test('lets agents create/list orgs, brains, sources, members, and invites', async () => {
    const createdOrg = await findOp('saas_orgs_create').handler(ctx(), {
      name: 'Example Corp',
      domain: 'example.com',
      owner_email: 'owner@example.com',
    }) as {
      org: { id: string; name: string; domain: string };
      owner: { email: string; role: string; status: string };
    };
    expect(createdOrg.org.name).toBe('Example Corp');
    expect(createdOrg.owner.email).toBe('owner@example.com');
    expect(createdOrg.owner.status).toBe('active');

    const createdBrain = await findOp('saas_brains_create').handler(ctx(), {
      org_id: createdOrg.org.id,
      name: 'Engineering Brain',
      public_url: 'https://engineering.example.com',
      region: 'iad',
      status: 'online',
      metadata: { tier: 'team' },
    }) as {
      id: string;
      org_id: string;
      name: string;
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(createdBrain.org_id).toBe(createdOrg.org.id);
    expect(createdBrain.name).toBe('Engineering Brain');
    expect(createdBrain.status).toBe('online');
    expect(createdBrain.metadata.tier).toBe('team');

    const createdSource = await findOp('saas_sources_create').handler(ctx(), {
      org_id: createdOrg.org.id,
      id: 'engineering',
      name: 'Engineering',
      federated: true,
    }) as {
      org_id: string;
      id: string;
      name: string;
      federated: boolean;
      remote_url: string | null;
    };
    expect(createdSource.org_id).toBe(createdOrg.org.id);
    expect(createdSource.id).toBe('engineering');
    expect(createdSource.name).toBe('Engineering');
    expect(createdSource.federated).toBe(true);
    expect(createdSource.remote_url).toBeNull();

    const sources = await findOp('saas_sources_list').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as Array<{ id: string; org_id: string; federated: boolean }>;
    expect(sources.some(source => source.id === 'engineering' && source.org_id === createdOrg.org.id)).toBe(true);

    await findOp('saas_sources_create').handler(ctx(), {
      org_id: createdOrg.org.id,
      id: 'composio-github',
      name: 'GitHub via Composio',
      federated: true,
    });
    const integrations = await findOp('saas_integrations_status').handler(ctx(), {
      public_url: 'https://cortex.example',
    }) as {
      provider: string;
      webhookUrl: string;
      connectors: Array<{ id: string; sourceId: string; connected: boolean; status: string }>;
    };
    expect(integrations.provider).toBe('Composio');
    expect(integrations.webhookUrl).toBe('https://cortex.example/webhooks/composio');
    expect(integrations.connectors.some(connector => (
      connector.id === 'github' &&
      connector.sourceId === 'composio-github' &&
      connector.connected
    ))).toBe(true);

    const invite = await findOp('users_create_invite').handler(ctx(), {
      org_id: createdOrg.org.id,
      email: 'teammate@example.com',
      role: 'viewer',
      source_id: 'engineering',
      federated_read: ['engineering', 'default'],
      public_url: 'https://ignored.example',
    }) as {
      client_id: string;
      onboarding_url: string;
      invite: { id: string; email: string; role: string; oauth_client_id: string };
      invite_delivery: { id: string; email: string; status: string };
      member: { email: string; role: string; status: string };
    };
    expect(invite.invite.oauth_client_id).toBe(invite.client_id);
    expect(invite.onboarding_url).toStartWith('https://ignored.example/admin/onboarding?invite=');
    expect(invite.invite_delivery.email).toBe('teammate@example.com');
    expect(invite.invite_delivery.status).toBe('queued');
    expect(invite.member.status).toBe('invited');

    const orgs = await findOp('saas_orgs_list').handler(ctx(), {}) as Array<{ id: string }>;
    expect(orgs.some(org => org.id === createdOrg.org.id)).toBe(true);

    const brains = await findOp('saas_brains_list').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as Array<{ id: string }>;
    expect(brains.map(brain => brain.id)).toContain(createdBrain.id);

    const team = await findOp('saas_team_list').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as Array<{ email: string; role: string; status: string }>;
    expect(team.map(member => member.email).sort()).toEqual(['owner@example.com', 'teammate@example.com']);

    const invites = await findOp('saas_invites_list').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as Array<{ email: string; role: string }>;
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: 'teammate@example.com', role: 'viewer' });

    const deliveries = await findOp('saas_invite_deliveries_list').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as Array<{ id: string; email: string; status: string; provider: string }>;
    expect(deliveries.some(row => row.email === 'teammate@example.com' && row.status === 'queued')).toBe(true);

    const queued = await findOp('saas_invite_delivery_queue').handler(ctx(), {
      org_id: createdOrg.org.id,
      invite_id: invite.invite.id,
      email: 'teammate@example.com',
      onboarding_url: invite.onboarding_url,
      welcome: 'Your Cortex invite is ready.',
    }) as { email: string; status: string; provider: string };
    expect(queued.email).toBe('teammate@example.com');
    expect(queued.status).toBe('queued');
    expect(queued.provider).toBe('outbox');

    const claimed = await findOp('saas_invite_deliveries_claim').handler(ctx(), {
      org_id: createdOrg.org.id,
      limit: 5,
    }) as Array<{ id: string; status: string; attempts: number }>;
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    expect(claimed[0].status).toBe('sending');
    expect(claimed[0].attempts).toBe(1);

    const marked = await findOp('saas_invite_delivery_mark').handler(ctx(), {
      delivery_id: claimed[0].id,
      status: 'sent',
      provider_message_id: 'agent-worker-msg-1',
    }) as { status: string; provider_message_id: string; sent_at: string | null };
    expect(marked.status).toBe('sent');
    expect(marked.provider_message_id).toBe('agent-worker-msg-1');
    expect(marked.sent_at).not.toBeNull();
  });

  test('lets agents inspect and update tenant plan limits', async () => {
    const createdOrg = await findOp('saas_orgs_create').handler(ctx(), {
      name: 'Plan Co',
      owner_email: 'owner@plan.example',
    }) as { org: { id: string } };

    const initial = await findOp('saas_plan_get').handler(ctx(), {
      org_id: createdOrg.org.id,
    }) as {
      org_id: string;
      plan_key: string;
      limits: { brains: number | null };
      usage: { brains: number };
      remaining: { brains: number | null };
    };
    expect(initial.org_id).toBe(createdOrg.org.id);
    expect(initial.plan_key).toBe('launch');
    expect(initial.limits.brains).toBe(3);

    const updated = await findOp('saas_plan_update').handler(ctx(), {
      org_id: createdOrg.org.id,
      plan_key: 'team',
      billing_customer_id: 'cus_plan_test',
      limits: { brains: 1 },
    }) as {
      plan_key: string;
      billing_customer_id: string;
      limits: { brains: number };
    };
    expect(updated.plan_key).toBe('team');
    expect(updated.billing_customer_id).toBe('cus_plan_test');
    expect(updated.limits.brains).toBe(1);

    await findOp('saas_brains_create').handler(ctx(), {
      org_id: createdOrg.org.id,
      name: 'Only Brain',
    });
    await expect(findOp('saas_brains_create').handler(ctx(), {
      org_id: createdOrg.org.id,
      name: 'Blocked Brain',
    })).rejects.toThrow('plan_limit_exceeded:brains');
  });

  test('lets agents manage OAuth client lifecycle', async () => {
    const registered = await findOp('users_register_agent_client').handler(ctx(), {
      name: 'runtime-agent',
      scopes: 'read write',
      token_ttl: 3600,
    }) as {
      client_id: string;
      client_secret: string;
      scopes: string;
      source_id: string;
      federated_read: string[];
    };

    expect(registered.client_id).toStartWith('cortex_cl_');
    expect(registered.client_secret).toStartWith('cortex_cs_');
    expect(registered.scopes).toBe('read write');
    expect(registered.source_id).toBe('default');
    expect(registered.federated_read).toEqual(['default']);

    let clients = await engine.executeRaw<{ token_ttl: number | null; deleted_at: string | null }>(
      `SELECT token_ttl, deleted_at FROM oauth_clients WHERE client_id = $1`,
      [registered.client_id],
    );
    expect(Number(clients[0].token_ttl)).toBe(3600);
    expect(clients[0].deleted_at).toBeNull();

    const ttlUpdate = await findOp('users_update_agent_client_ttl').handler(ctx(), {
      client_id: registered.client_id,
      token_ttl: 604800,
    }) as { client_id: string; updated: boolean; token_ttl: number; status: string };
    expect(ttlUpdate).toMatchObject({
      client_id: registered.client_id,
      updated: true,
      token_ttl: 604800,
      status: 'active',
    });

    const ttlClear = await findOp('users_update_agent_client_ttl').handler(ctx(), {
      client_id: registered.client_id,
      token_ttl: 0,
    }) as { token_ttl: number | null };
    expect(ttlClear.token_ttl).toBeNull();

    await engine.executeRaw(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
       VALUES ($1, 'access', $2, ARRAY['read'], $3)`,
      ['runtime-agent-token', registered.client_id, Math.floor(Date.now() / 1000) + 3600],
    );

    const revoked = await findOp('users_revoke_agent_client').handler(ctx(), {
      client_id: registered.client_id,
    }) as { client_id: string; revoked: boolean; already_revoked: boolean; tokens_deleted: number };
    expect(revoked).toMatchObject({
      client_id: registered.client_id,
      revoked: true,
      already_revoked: false,
      tokens_deleted: 1,
    });

    clients = await engine.executeRaw<{ token_ttl: number | null; deleted_at: string | null }>(
      `SELECT token_ttl, deleted_at FROM oauth_clients WHERE client_id = $1`,
      [registered.client_id],
    );
    expect(clients[0].deleted_at).not.toBeNull();

    const tokens = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int as count FROM oauth_tokens WHERE client_id = $1`,
      [registered.client_id],
    );
    expect(Number(tokens[0].count)).toBe(0);
  });

  test('lets agents list and update skill policies', async () => {
    const saved = await findOp('saas_skills_upsert').handler(ctx(), {
      id: 'customer-brief',
      name: 'Customer Brief',
      owner: 'growth',
      status: 'needs-enforcement',
      triggers: ['brief customer'],
      allowed_clients: ['gbrain_cl_sales'],
      source_access: ['default'],
      description: 'Scoped GBrain/OpenClaw workflow in ~/.gbrain with gbrain.yml.',
      enforcement_status: 'needs_enforcement',
    }) as {
      id: string;
      name: string;
      allowedClients: string[];
      sourceAccess: string[];
      description: string;
      enforcementStatus: string;
      persisted: boolean;
    };

    expect(saved.id).toBe('customer-brief');
    expect(saved.allowedClients).toEqual(['cortex_cl_sales']);
    expect(saved.sourceAccess).toEqual(['default']);
    expect(saved.description).toBe('Scoped Cortex workflow in ~/.cortex with cortex.yml.');
    expect(saved.enforcementStatus).toBe('enforced');
    expect(saved.persisted).toBe(true);

    const listed = await findOp('saas_skills_list').handler(ctx(), {}) as {
      skills: Array<{ id: string; name: string; persisted: boolean }>;
    };
    expect(listed.skills.some(skill => skill.id === 'customer-brief' && skill.persisted)).toBe(true);
  });

  test('returns runtime packaging manifest for agents', async () => {
    const manifest = await findOp('saas_runtime_manifest').handler(ctx(), {
      public_url: 'https://cortex.example',
      onboarding_url: 'https://cortex.example/admin/onboarding?invite=abc',
      client_id: 'cortex_cl_owner',
      org_id: 'org_123',
      brain_id: 'brain_123',
      email: 'owner@example.com',
      role: 'owner',
      source_id: 'engineering',
      federated_read: ['engineering', 'default'],
      scopes: 'admin users_admin read write',
    }) as {
      schema: string;
      tenant: { org_id: string; brain_id: string; email: string; role: string };
      endpoints: { base_url: string; mcp_url: string; token_url: string; runtime_package: string };
      onboarding: { client_id: string; source_id: string; federated_read: string[]; connect_command: string };
      runtimes: Record<string, { label: string; command?: string; config?: { mcpServers?: Record<string, { url?: string; transport?: string }> } }>;
      packages: Record<string, { label: string; artifact: string; supported_runtimes: string[]; verification: string[] }>;
      agent_parity: { operations: Array<{ name: string }> };
      skill_policy: { annotation_keys: string[] };
    };

    expect(manifest.schema).toBe('cortex.runtime-manifest.v1');
    expect(manifest.tenant.org_id).toBe('org_123');
    expect(manifest.tenant.brain_id).toBe('brain_123');
    expect(manifest.tenant.email).toBe('owner@example.com');
    expect(manifest.tenant.role).toBe('owner');
    expect(manifest.endpoints.base_url).toBe('https://cortex.example');
    expect(manifest.endpoints.mcp_url).toBe('https://cortex.example/mcp');
    expect(manifest.endpoints.token_url).toBe('https://cortex.example/token');
    expect(manifest.endpoints.runtime_package).toBe('https://cortex.example/runtime-package.json');
    expect(manifest.onboarding.client_id).toBe('cortex_cl_owner');
    expect(manifest.onboarding.source_id).toBe('engineering');
    expect(manifest.onboarding.federated_read).toEqual(['engineering', 'default']);
    expect(manifest.onboarding.connect_command).toContain('cortex connect');
    expect(Object.keys(manifest.runtimes).sort()).toEqual([
      'chatgpt',
      'claude_code',
      'claude_desktop',
      'cortex_cli',
      'cursor',
      'perplexity',
    ]);
    expect(manifest.runtimes.claude_code.command).toBe('claude mcp add --transport http cortex https://cortex.example/mcp');
    expect(manifest.runtimes.cursor.config?.mcpServers?.cortex).toEqual({
      url: 'https://cortex.example/mcp',
      transport: 'sse',
    });
    expect(manifest.runtimes.claude_desktop.config?.mcpServers?.cortex).toEqual({
      url: 'https://cortex.example/mcp',
      transport: 'sse',
    });
    expect(Object.keys(manifest.packages).sort()).toEqual([
      'chatgpt_connector',
      'claude_code_helper',
      'claude_desktop_adapter',
      'cortex_cli',
      'cursor_adapter',
      'perplexity_connector',
    ]);
    expect(manifest.packages.cortex_cli.artifact).toBe('cortex');
    expect(manifest.packages.cursor_adapter.supported_runtimes).toEqual(['cursor']);
    expect(manifest.packages.cursor_adapter.verification).toContain('cortex runtime install cursor --json');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_runtime_manifest');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_runtime_package_index');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_plan_get');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_plan_update');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_quality_snapshot');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_sources_list');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_sources_create');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_integrations_status');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_invite_deliveries_list');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_invite_delivery_queue');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_invite_deliveries_claim');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_invite_delivery_mark');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('saas_invite_deliveries_drain');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('users_register_agent_client');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('users_update_agent_client_ttl');
    expect(manifest.agent_parity.operations.map(op => op.name)).toContain('users_revoke_agent_client');
    expect(manifest.skill_policy.annotation_keys).toContain('_skill_id');
  });

  test('returns hosted runtime package index for agents', async () => {
    const index = await findOp('saas_runtime_package_index').handler(ctx(), {
      public_url: 'https://cortex.example',
    }) as {
      schema: string;
      endpoints: { runtime_manifest: string; runtime_package: string; mcp_url: string };
      packages: Record<string, { artifact: string; supported_runtimes: string[] }>;
      verification: string[];
      agent_parity: { operations: Array<{ name: string }> };
    };

    expect(index.schema).toBe('cortex.runtime-package-index.v1');
    expect(index.endpoints.runtime_manifest).toBe('https://cortex.example/runtime-manifest.json');
    expect(index.endpoints.runtime_package).toBe('https://cortex.example/runtime-package.json');
    expect(index.endpoints.mcp_url).toBe('https://cortex.example/mcp');
    expect(index.packages.cortex_cli.artifact).toBe('cortex');
    expect(index.packages.cursor_adapter.supported_runtimes).toEqual(['cursor']);
    expect(index.verification).toContain('cortex --version');
    expect(index.agent_parity.operations.map(op => op.name)).toContain('saas_runtime_package_index');
  });

  test('returns the shared quality snapshot used by console and agents', async () => {
    const envKeys = [
      'COMPOSIO_API_KEY',
      'CORTEX_COMPOSIO_WEBHOOK_SECRET',
      'CORTEX_DATABASE_URL',
      'CORTEX_EMAIL_PROVIDER',
      'CORTEX_RESEND_API_KEY',
      'CORTEX_EMAIL_FROM',
      'CORTEX_BILLING_WEBHOOK_SECRET',
      'CORTEX_ADMIN_BOOTSTRAP_TOKEN',
      'CORTEX_SUPPRESS_BOOTSTRAP_TOKEN',
    ];
    const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.COMPOSIO_API_KEY = 'test-composio-key';
    process.env.CORTEX_COMPOSIO_WEBHOOK_SECRET = 'test-composio-secret';
    process.env.CORTEX_DATABASE_URL = 'postgresql://postgres.test:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
    process.env.CORTEX_EMAIL_PROVIDER = 'resend';
    process.env.CORTEX_RESEND_API_KEY = 're_quality_test';
    process.env.CORTEX_EMAIL_FROM = 'Cortex <onboarding@quality.test>';
    process.env.CORTEX_BILLING_WEBHOOK_SECRET = 'billing_secret_quality_test_1234567890';
    process.env.CORTEX_ADMIN_BOOTSTRAP_TOKEN = 'bootstrap_quality_test_token_1234567890';
    process.env.CORTEX_SUPPRESS_BOOTSTRAP_TOKEN = '1';
    try {
      const signup = await findOp('saas_signup_create').handler(ctx(), {
        org_name: 'Quality Co',
        email: 'owner@quality.example',
        public_url: 'https://quality.example',
      }) as { client_id: string };

      await findOp('saas_skills_upsert').handler(ctx(), {
        id: 'quality-brief',
        name: 'Quality Brief',
        allowed_clients: [signup.client_id],
        source_access: ['default'],
        enforcement_status: 'enforced',
      });

      const quality = await findOp('saas_quality_snapshot').handler(ctx(), {
        public_url: 'https://quality.example',
      }) as {
        schema: string;
        readiness: { score: number; passed: number; total: number; status: string };
        metrics: { connected_agents: number; source_count: number; enforced_skills: number; failed_jobs: number; agent_parity_operations: number };
        deployment: { engine_kind: string; production_ready: boolean; database: { provider: string; ready: boolean }; email: { ready: boolean }; billing: { ready: boolean }; bootstrap: { ready: boolean } };
        checks: Array<{ area: string; status: string; passed: boolean; remediation: string | null }>;
        runtime_manifest: { endpoints: { mcp_url: string }; agent_parity: { operations: Array<{ name: string }> } };
        integrations: { provider: string; webhookUrl: string; apiKeyConfigured: boolean; webhookSecretConfigured: boolean };
      };

      expect(quality.schema).toBe('cortex.saas-quality-snapshot.v1');
      expect(quality.runtime_manifest.endpoints.mcp_url).toBe('https://quality.example/mcp');
      expect(quality.runtime_manifest.agent_parity.operations.map(op => op.name)).toContain('saas_quality_snapshot');
      expect(quality.integrations.provider).toBe('Composio');
      expect(quality.integrations.webhookUrl).toBe('https://quality.example/webhooks/composio');
      expect(quality.integrations.apiKeyConfigured).toBe(true);
      expect(quality.integrations.webhookSecretConfigured).toBe(true);
      expect(quality.deployment.engine_kind).toBe('pglite');
      expect(quality.deployment.production_ready).toBe(false);
      expect(quality.deployment.database.provider).toBe('supabase');
      expect(quality.deployment.database.ready).toBe(false);
      expect(quality.deployment.email.ready).toBe(true);
      expect(quality.deployment.billing.ready).toBe(true);
      expect(quality.deployment.bootstrap.ready).toBe(true);
      expect(quality.metrics.connected_agents).toBeGreaterThanOrEqual(1);
      expect(quality.metrics.source_count).toBeGreaterThanOrEqual(1);
      expect(quality.metrics.enforced_skills).toBeGreaterThanOrEqual(1);
      expect(quality.metrics.failed_jobs).toBe(0);
      expect(quality.metrics.agent_parity_operations).toBeGreaterThan(0);
      expect(quality.checks.map(check => check.area)).toEqual([
        'Durable database',
        'Hosted OAuth origin',
        'Invite email delivery',
        'Billing webhook',
        'Secret hygiene',
        'Signup and onboarding',
        'Agent access',
        'Source ingestion',
        'Composio ingestion',
        'Skill promotion',
        'Queue health',
        'Agent parity',
      ]);
      expect(quality.checks.find(check => check.area === 'Durable database')).toMatchObject({
        passed: false,
        status: 'needs_deploy',
      });
      expect(quality.checks.filter(check => check.area !== 'Durable database').every(check => check.passed)).toBe(true);
      expect(quality.readiness).toMatchObject({ passed: quality.checks.length - 1, total: quality.checks.length, status: 'needs_attention' });
      expect(quality.readiness.score).toBeGreaterThan(80);
      expect(quality.readiness.score).toBeLessThan(100);
    } finally {
      for (const key of envKeys) {
        const previous = previousEnv[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  test('returns an agent-callable console snapshot with agents, requests, and jobs', async () => {
    const signup = await findOp('saas_signup_create').handler(ctx(), {
      org_name: 'Snapshot Co',
      email: 'owner@snapshot.example',
      public_url: 'https://snapshot.example',
    }) as { org: { id: string }; client_id: string };

    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params, error_message, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6::jsonb, NULL, now()),
         ($1, $2, $7, $8, $9, $10::jsonb, $11, now())`,
      [
        signup.client_id,
        'owner-agent',
        'search',
        42,
        'success',
        JSON.stringify({ declared_params: ['query'] }),
        'whoami',
        9,
        'error',
        JSON.stringify({ declared_params: [] }),
        'boom',
      ],
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      ['sync', 'default', 'waiting', JSON.stringify({ reason: 'snapshot-test' })],
    );

    const snapshot = await findOp('saas_console_snapshot').handler(ctx(), {
      agent: signup.client_id,
      limit: 10,
    }) as {
      schema: string;
      stats: { connected_agents: number; requests_today: number };
      health: { error_count_24h: number; error_rate: string };
      control_plane: { organizations: number; brains: number; members: number; invites: number };
      agents: { rows: Array<{ id: string; auth_type: string; requests_today: number }> };
      requests: { rows: Array<{ token_name: string; operation: string; status: string }>; total: number; filters: { agent: string } };
      jobs: { counts_by_status: Record<string, number>; recent: Array<{ name: string; status: string }> };
      plan: { org_id: string; plan_key: string; usage: { brains: number } } | null;
    };

    expect(snapshot.schema).toBe('cortex.saas-console-snapshot.v1');
    expect(snapshot.stats.connected_agents).toBeGreaterThanOrEqual(1);
    expect(snapshot.stats.requests_today).toBeGreaterThanOrEqual(2);
    expect(snapshot.health.error_count_24h).toBeGreaterThanOrEqual(1);
    expect(snapshot.health.error_rate).toContain('%');
    expect(snapshot.control_plane.organizations).toBeGreaterThanOrEqual(1);
    expect(snapshot.control_plane.brains).toBeGreaterThanOrEqual(1);
    expect(snapshot.control_plane.members).toBeGreaterThanOrEqual(1);
    expect(snapshot.control_plane.invites).toBeGreaterThanOrEqual(1);
    expect(snapshot.plan?.org_id).toBe(signup.org.id);
    expect(snapshot.plan?.plan_key).toBe('launch');
    expect(snapshot.plan?.usage.brains).toBeGreaterThanOrEqual(1);
    expect(snapshot.agents.rows.some(agent => agent.id === signup.client_id && agent.auth_type === 'oauth')).toBe(true);
    expect(snapshot.requests.filters.agent).toBe(signup.client_id);
    expect(snapshot.requests.total).toBe(2);
    expect(snapshot.requests.rows.map(row => row.operation).sort()).toEqual(['search', 'whoami']);
    expect(snapshot.jobs.counts_by_status.waiting).toBeGreaterThanOrEqual(1);
    expect(snapshot.jobs.recent.some(job => job.name === 'sync')).toBe(true);
  });
});
