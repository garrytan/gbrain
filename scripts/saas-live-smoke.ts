#!/usr/bin/env bun

export interface LiveSmokeArgs {
  baseUrl?: string;
  adminToken?: string;
  composioSecret?: string;
  billingSecret?: string;
  skipComposio: boolean;
  skipBilling: boolean;
  json: boolean;
  help: boolean;
}

export interface LiveSmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface LiveSmokeResult {
  ok: boolean;
  baseUrl: string;
  checks: LiveSmokeCheck[];
  artifacts: {
    marketingUrl: string;
    signupUrl: string;
    onboardingUrl?: string;
    inviteOnboardingUrl?: string;
    ownerInviteDeliveryId?: string;
    inviteDeliveryId?: string;
    orgId?: string;
    sourceId?: string;
    skillId?: string;
    agentClientId?: string;
    composioJobId?: number | string;
    billingEventId?: string;
    mcpToolCount?: number;
    mcpIntegrationProvider?: string;
    mcpQualityScore?: number;
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LEGACY_RE = /GBrain|GBRAIN|gbrain|garrytan\/gbrain|\/admin\/#/;

export function usageText(): string {
  return `Usage: bun run smoke:saas-live -- --base-url <url> --admin-token <token> [options]

Options:
  --base-url <url>          Hosted Cortex base URL. Also reads CORTEX_SMOKE_BASE_URL or CORTEX_PUBLIC_URL.
  --admin-token <token>     Admin bootstrap token. Also reads CORTEX_ADMIN_BOOTSTRAP_TOKEN.
  --composio-secret <val>   Composio webhook secret. Also reads CORTEX_COMPOSIO_WEBHOOK_SECRET.
  --billing-secret <val>    Billing webhook secret. Also reads CORTEX_BILLING_WEBHOOK_SECRET.
  --skip-composio           Skip the Composio webhook leg.
  --skip-billing            Skip the billing webhook leg.
  --json                    Print machine-readable JSON.
  -h, --help                Show this help`;
}

export function readArgs(argv: string[], env: Record<string, string | undefined> = process.env): LiveSmokeArgs {
  const out: LiveSmokeArgs = {
    baseUrl: env.CORTEX_SMOKE_BASE_URL || env.CORTEX_PUBLIC_URL || env.PUBLIC_URL,
    adminToken: env.CORTEX_ADMIN_BOOTSTRAP_TOKEN,
    composioSecret: env.CORTEX_COMPOSIO_WEBHOOK_SECRET || env.COMPOSIO_WEBHOOK_SECRET,
    billingSecret: env.CORTEX_BILLING_WEBHOOK_SECRET || env.BILLING_WEBHOOK_SECRET,
    skipComposio: false,
    skipBilling: false,
    json: false,
    help: false,
  };
  const flagsWithValues = new Set(['--base-url', '--admin-token', '--composio-secret', '--billing-secret']);
  const boolFlags = new Set(['--skip-composio', '--skip-billing', '--json', '--help', '-h']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValues.has(arg)) {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--base-url') out.baseUrl = val;
      if (arg === '--admin-token') out.adminToken = val;
      if (arg === '--composio-secret') out.composioSecret = val;
      if (arg === '--billing-secret') out.billingSecret = val;
      i += 1;
      continue;
    }
    if (boolFlags.has(arg)) {
      if (arg === '--skip-composio') out.skipComposio = true;
      if (arg === '--skip-billing') out.skipBilling = true;
      if (arg === '--json') out.json = true;
      if (arg === '--help' || arg === '-h') out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function assertNoLegacyBrand(text: string, label: string): void {
  const match = text.match(LEGACY_RE);
  if (match) throw new Error(`${label} contains legacy brand/copy: ${match[0]}`);
}

export function parseMcpResponse(text: string): unknown {
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:'));
  const payload = dataLines.length
    ? dataLines.map(line => line.replace(/^data:\s?/, '')).join('\n')
    : text;
  return JSON.parse(payload);
}

function checkOnboardingUrl(value: unknown, baseUrl: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} missing`);
  const escapedBase = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escapedBase}/admin/onboarding/?\\?invite=`);
  if (!re.test(value)) throw new Error(`${label} must start with ${baseUrl}/admin/onboarding?invite=`);
  return value;
}

function cookieFrom(headers: Headers): string {
  const maybeGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof maybeGetSetCookie.getSetCookie === 'function'
    ? maybeGetSetCookie.getSetCookie()
    : [];
  const raw = setCookies[0] || headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  if (!cookie) throw new Error('admin magic link did not set a session cookie');
  return cookie;
}

async function expectText(fetchImpl: FetchLike, url: string, init: RequestInit | undefined, expected: number): Promise<string> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (res.status !== expected) throw new Error(`${url} returned ${res.status}: ${text.slice(0, 500)}`);
  return text;
}

async function expectJson<T = any>(fetchImpl: FetchLike, url: string, init: RequestInit, expected: number): Promise<{ json: T; text: string; headers: Headers; status: number }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (res.status !== expected) throw new Error(`${url} returned ${res.status}: ${text.slice(0, 500)}`);
  return { json: JSON.parse(text) as T, text, headers: res.headers, status: res.status };
}

export async function runLiveSmoke(args: LiveSmokeArgs, fetchImpl: FetchLike = fetch): Promise<LiveSmokeResult> {
  if (!args.baseUrl) throw new Error('Missing --base-url or CORTEX_SMOKE_BASE_URL/CORTEX_PUBLIC_URL');
  if (!args.adminToken) throw new Error('Missing --admin-token or CORTEX_ADMIN_BOOTSTRAP_TOKEN');
  if (!args.skipComposio && !args.composioSecret) {
    throw new Error('Missing --composio-secret or CORTEX_COMPOSIO_WEBHOOK_SECRET. Pass --skip-composio only for non-ingestion smoke.');
  }
  if (!args.skipBilling && !args.billingSecret) {
    throw new Error('Missing --billing-secret or CORTEX_BILLING_WEBHOOK_SECRET. Pass --skip-billing only for non-billing smoke.');
  }

  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const stamp = Date.now().toString(36);
  const checks: LiveSmokeCheck[] = [];
  const artifacts: LiveSmokeResult['artifacts'] = {
    marketingUrl: `${baseUrl}/`,
    signupUrl: `${baseUrl}/admin/signup`,
  };

  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    const started = Date.now();
    try {
      if (process.env.CORTEX_SMOKE_PROGRESS === '1') console.error(`[smoke:saas-live] start ${name}`);
      await fn();
      checks.push({ name, ok: true, ms: Date.now() - started });
      if (process.env.CORTEX_SMOKE_PROGRESS === '1') console.error(`[smoke:saas-live] ok ${name} (${Date.now() - started}ms)`);
    } catch (e) {
      checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
      if (process.env.CORTEX_SMOKE_PROGRESS === '1') console.error(`[smoke:saas-live] fail ${name}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  let adminCookie = '';
  let signup: any;
  let invite: any;
  let agentClient: any;
  let accessToken = '';
  let ownerAccessToken = '';

  await step('marketing page is public and Cortex-branded', async () => {
    const text = await expectText(fetchImpl, `${baseUrl}/`, undefined, 200);
    assertNoLegacyBrand(text, 'marketing page');
  });

  await step('signup page is public and Cortex-branded', async () => {
    const text = await expectText(fetchImpl, `${baseUrl}/admin/signup`, undefined, 200);
    assertNoLegacyBrand(text, 'signup page');
  });

  await step('public signup creates org, brain, owner client, and onboarding URL', async () => {
    const result = await expectJson(fetchImpl, `${baseUrl}/admin/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgName: `Cortex Smoke ${stamp}`,
        email: `smoke-${stamp}@example.com`,
        domain: `smoke-${stamp}.example.com`,
      }),
    }, 200);
    assertNoLegacyBrand(result.text, 'signup response');
    signup = result.json;
    artifacts.onboardingUrl = checkOnboardingUrl(signup.onboarding_url, baseUrl, 'signup onboarding_url');
    artifacts.orgId = signup.org?.id;
    if (typeof signup.connectCommand !== 'string' || !signup.connectCommand.startsWith('cortex connect ')) {
      throw new Error('signup response did not include a cortex connect command');
    }
    if (typeof signup.clientId !== 'string' || !signup.clientId.startsWith('cortex_cl_')) {
      throw new Error('signup response did not include a Cortex OAuth client id');
    }
    if (signup.runtime_manifest?.schema !== 'cortex.runtime-manifest.v1') {
      throw new Error('signup response did not include the Cortex runtime manifest');
    }
    if (signup.invite_delivery?.status !== 'queued') {
      throw new Error('signup response did not queue owner invite delivery');
    }
    artifacts.ownerInviteDeliveryId = signup.invite_delivery?.id;
  });

  await step('public runtime package index advertises CLI and plugin channels', async () => {
    const result = await expectJson(fetchImpl, `${baseUrl}/runtime-package.json`, {}, 200);
    assertNoLegacyBrand(result.text, 'runtime-package.json');
    const payload = result.json as {
      schema?: string;
      endpoints?: { runtime_manifest?: string; runtime_package?: string; mcp_url?: string };
      packages?: Record<string, { artifact?: string }>;
      verification?: string[];
    };
    if (payload.schema !== 'cortex.runtime-package-index.v1') {
      throw new Error(`runtime package index had unexpected schema: ${payload.schema}`);
    }
    if (payload.endpoints?.runtime_manifest !== `${baseUrl}/runtime-manifest.json`) {
      throw new Error('runtime package index did not point at the hosted runtime manifest');
    }
    if (payload.endpoints?.runtime_package !== `${baseUrl}/runtime-package.json`) {
      throw new Error('runtime package index did not point at itself');
    }
    if (payload.packages?.cortex_cli?.artifact !== 'cortex') {
      throw new Error('runtime package index did not advertise the Cortex CLI package');
    }
    if (!payload.verification?.some(cmd => cmd.startsWith('cortex runtime install cursor'))) {
      throw new Error('runtime package index did not include runtime install verification');
    }
  });

  await step('admin magic link creates an authenticated console session', async () => {
    const magic = await expectJson<{ url: string }>(fetchImpl, `${baseUrl}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${args.adminToken}` },
      body: '{}',
    }, 200);
    if (!magic.json.url?.startsWith(`${baseUrl}/admin/auth/`)) throw new Error('magic link URL has the wrong host/path');
    const res = await fetchImpl(magic.json.url, { redirect: 'manual' });
    const text = await res.text();
    if (res.status < 300 || res.status >= 400) throw new Error(`magic link returned ${res.status}: ${text.slice(0, 500)}`);
    adminCookie = cookieFrom(res.headers);
    const orgText = await expectText(fetchImpl, `${baseUrl}/admin/api/orgs`, { headers: { cookie: adminCookie } }, 200);
    const orgs = JSON.parse(orgText) as Array<{ id: string }>;
    if (!orgs.some(org => org.id === signup.org?.id)) throw new Error('created org is missing from admin org list');
  });

  await step('tenant plan endpoint reports usage and accepts plan updates', async () => {
    const plan = await expectJson<any>(fetchImpl, `${baseUrl}/admin/api/plan?orgId=${encodeURIComponent(signup.org.id)}`, {
      headers: { cookie: adminCookie },
    }, 200);
    assertNoLegacyBrand(plan.text, 'plan response');
    if (plan.json.org_id !== signup.org.id) throw new Error('plan response is for the wrong org');
    if (plan.json.plan_key !== 'launch') throw new Error(`unexpected initial plan: ${plan.json.plan_key}`);
    if ((plan.json.usage?.brains ?? 0) < 1) throw new Error('plan usage did not count signup brain');

    const updated = await expectJson<any>(fetchImpl, `${baseUrl}/admin/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ orgId: signup.org.id, planKey: 'team' }),
    }, 200);
    assertNoLegacyBrand(updated.text, 'plan update response');
    if (updated.json.plan_key !== 'team') throw new Error('plan update did not persist');
  });

  if (!args.skipBilling) {
    await step('billing webhook reconciles tenant plan and is idempotent', async () => {
      const eventId = `evt_cortex_smoke_${stamp}`;
      const result = await expectJson<any>(fetchImpl, `${baseUrl}/webhooks/billing`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cortex-billing-secret': args.billingSecret!,
        },
        body: JSON.stringify({
          provider: 'stripe',
          eventId,
          eventType: 'customer.subscription.updated',
          orgId: signup.org.id,
          billingCustomerId: `cus_${stamp}`,
          billingSubscriptionId: `sub_${stamp}`,
          planKey: 'business',
          status: 'active',
          billingPlanRef: 'price_cortex_business',
          billingCurrentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      }, 202);
      assertNoLegacyBrand(result.text, 'billing webhook response');
      if (result.json.plan?.plan_key !== 'business') throw new Error('billing webhook did not update the tenant plan');
      if (result.json.plan?.billing_subscription_id !== `sub_${stamp}`) throw new Error('billing webhook did not persist subscription id');
      artifacts.billingEventId = result.json.event_id;

      const duplicate = await expectJson<any>(fetchImpl, `${baseUrl}/webhooks/billing`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cortex-billing-secret': args.billingSecret!,
        },
        body: JSON.stringify({
          provider: 'stripe',
          eventId,
          orgId: signup.org.id,
          billingCustomerId: `cus_${stamp}`,
        }),
      }, 200);
      if (duplicate.json.duplicate !== true) throw new Error('billing webhook duplicate was not idempotent');
    });
  }

  await step('admin invite returns teammate onboarding URL and source-scoped client', async () => {
    const result = await expectJson(fetchImpl, `${baseUrl}/admin/api/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        orgId: signup.org.id,
        email: `teammate-${stamp}@example.com`,
        role: 'member',
        sourceId: 'default',
        federatedRead: ['default'],
      }),
    }, 200);
    assertNoLegacyBrand(result.text, 'invite response');
    invite = result.json;
    artifacts.inviteOnboardingUrl = checkOnboardingUrl(invite.onboardingUrl, baseUrl, 'invite onboardingUrl');
    if (typeof invite.clientId !== 'string' || !invite.clientId.startsWith('cortex_cl_')) {
      throw new Error('invite response did not include a Cortex OAuth client id');
    }
    if (invite.inviteDelivery?.status !== 'queued') {
      throw new Error('invite response did not queue teammate invite delivery');
    }
    artifacts.inviteDeliveryId = invite.inviteDelivery?.id;
  });

  await step('invite delivery outbox exposes and processes owner and teammate records', async () => {
    const result = await expectJson<any[]>(fetchImpl, `${baseUrl}/admin/api/invite-deliveries?orgId=${encodeURIComponent(signup.org.id)}`, {
      headers: { cookie: adminCookie },
    }, 200);
    assertNoLegacyBrand(result.text, 'invite delivery response');
    const ids = new Set(result.json.map(row => row.id));
    if (!ids.has(artifacts.ownerInviteDeliveryId) || !ids.has(artifacts.inviteDeliveryId)) {
      throw new Error('invite delivery outbox did not include both owner and teammate records');
    }
    const claimed = await expectJson<any[]>(fetchImpl, `${baseUrl}/admin/api/invite-deliveries/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ orgId: signup.org.id, limit: 10 }),
    }, 200);
    assertNoLegacyBrand(claimed.text, 'invite delivery claim response');
    const claimedIds = new Set(claimed.json.map(row => row.id));
    if (!claimedIds.has(artifacts.ownerInviteDeliveryId) || !claimedIds.has(artifacts.inviteDeliveryId)) {
      throw new Error('invite delivery claim did not claim both owner and teammate records');
    }
    if (!claimed.json.every(row => row.status === 'sending')) {
      throw new Error('claimed delivery records were not moved to sending');
    }
    const marked = await expectJson<any>(fetchImpl, `${baseUrl}/admin/api/invite-deliveries/${encodeURIComponent(String(artifacts.inviteDeliveryId))}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'sent', providerMessageId: `smoke-${stamp}` }),
    }, 200);
    assertNoLegacyBrand(marked.text, 'invite delivery mark response');
    if (marked.json.status !== 'sent' || marked.json.provider_message_id !== `smoke-${stamp}`) {
      throw new Error('invite delivery mark did not persist sent status');
    }
  });

  await step('invite delivery provider drain endpoint reports readiness', async () => {
    const drained = await expectJson<any>(fetchImpl, `${baseUrl}/admin/api/invite-deliveries/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ orgId: signup.org.id, limit: 1 }),
    }, 200);
    assertNoLegacyBrand(drained.text, 'invite delivery drain response');
    if (typeof drained.json.configured !== 'boolean') {
      throw new Error('invite delivery drain did not report provider configuration');
    }
    if (!Array.isArray(drained.json.results) || !Array.isArray(drained.json.deliveries)) {
      throw new Error('invite delivery drain response is missing result arrays');
    }
  });

  await step('source and skill policy APIs accept SaaS control-plane updates', async () => {
    const sourceId = `smoke-${stamp}`.slice(0, 32);
    const skillId = `smoke-skill-${stamp}`.slice(0, 32);
    await expectJson(fetchImpl, `${baseUrl}/admin/api/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ id: sourceId, name: `Smoke Source ${stamp}`, federated: true }),
    }, 200);
    await expectJson(fetchImpl, `${baseUrl}/admin/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        id: skillId,
        name: `Smoke Skill ${stamp}`,
        owner: 'Cortex Smoke',
        status: 'enabled',
        triggers: ['manual', 'ingest'],
        allowedClients: [invite.clientId],
        sourceAccess: ['default', sourceId],
        enforcementStatus: 'enforced',
      }),
    }, 200);
    artifacts.sourceId = sourceId;
    artifacts.skillId = skillId;
  });

  await step('agent OAuth client can be registered for federated reads', async () => {
    const result = await expectJson(fetchImpl, `${baseUrl}/admin/api/register-client`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        name: `agent-smoke-${stamp}`,
        scopes: 'read write',
        sourceId: 'default',
        federatedRead: ['default', artifacts.sourceId],
        tokenEndpointAuthMethod: 'client_secret_post',
        tokenTtl: 3600,
      }),
    }, 200);
    agentClient = result.json;
    if (typeof agentClient.clientId !== 'string' || !agentClient.clientId.startsWith('cortex_cl_')) {
      throw new Error('agent client id is not Cortex-prefixed');
    }
    if (typeof agentClient.clientSecret !== 'string' || agentClient.clientSecret.length < 16) {
      throw new Error('agent client secret missing from one-time registration response');
    }
    artifacts.agentClientId = agentClient.clientId;
  });

  if (!args.skipComposio) {
    await step('Composio webhook queues ingestion into a Cortex source', async () => {
      const result = await expectJson(fetchImpl, `${baseUrl}/webhooks/composio`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cortex-webhook-secret': args.composioSecret!,
        },
        body: JSON.stringify({
          tool: 'slack',
          text: `Cortex SaaS live smoke ${stamp}`,
          url: `https://example.com/cortex-smoke/${stamp}`,
          slug: `smoke-${stamp}`,
        }),
      }, 202);
      if (result.json.source_id !== 'composio-slack') throw new Error(`unexpected Composio source: ${result.json.source_id}`);
      artifacts.composioJobId = result.json.job_id;
    });
  }

  await step('OAuth token endpoint mints an agent access token', async () => {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: agentClient.clientId,
      client_secret: agentClient.clientSecret,
      scope: 'read',
    });
    const result = await expectJson<{ access_token: string }>(fetchImpl, `${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }, 200);
    if (!result.json.access_token) throw new Error('token response missing access_token');
    accessToken = result.json.access_token;
  });

  await step('MCP integrations status call is reachable for owner agents', async () => {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: signup.clientId,
      client_secret: signup.clientSecret,
      scope: 'users_admin',
    });
    const tokenResult = await expectJson<{ access_token: string }>(fetchImpl, `${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }, 200);
    if (!tokenResult.json.access_token) throw new Error('owner token response missing access_token');
    ownerAccessToken = tokenResult.json.access_token;

    const res = await fetchImpl(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'saas_integrations_status',
          arguments: { public_url: baseUrl },
        },
      }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`/mcp tools/call returned ${res.status}: ${text.slice(0, 500)}`);
    assertNoLegacyBrand(text, 'MCP saas_integrations_status');
    const parsed = parseMcpResponse(text) as { result?: { content?: Array<{ type?: string; text?: string }> } };
    const payloadText = parsed.result?.content?.find(part => part.type === 'text')?.text;
    if (!payloadText) throw new Error('MCP integrations status returned no text payload');
    const payload = JSON.parse(payloadText) as {
      provider?: string;
      webhookUrl?: string;
      connectors?: Array<{ id?: string; sourceId?: string; connected?: boolean }>;
    };
    if (payload.provider !== 'Composio') throw new Error(`unexpected integration provider: ${payload.provider}`);
    if (!payload.webhookUrl?.startsWith(`${baseUrl}/webhooks/composio`)) {
      throw new Error('MCP integrations status returned the wrong Composio webhook URL');
    }
    if (!Array.isArray(payload.connectors) || payload.connectors.length < 1) {
      throw new Error('MCP integrations status returned no connectors');
    }
    if (!args.skipComposio) {
      const slack = payload.connectors.find(connector => connector.id === 'slack' || connector.sourceId === 'composio-slack');
      if (!slack?.connected) throw new Error('MCP integrations status did not show the Composio Slack source as connected');
    }
    artifacts.mcpIntegrationProvider = payload.provider;
  });

  await step('MCP quality snapshot matches investor-readiness contract', async () => {
    const res = await fetchImpl(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'saas_quality_snapshot',
          arguments: { public_url: baseUrl },
        },
      }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`/mcp quality snapshot returned ${res.status}: ${text.slice(0, 500)}`);
    assertNoLegacyBrand(text, 'MCP saas_quality_snapshot');
    const parsed = parseMcpResponse(text) as { result?: { content?: Array<{ type?: string; text?: string }> } };
    const payloadText = parsed.result?.content?.find(part => part.type === 'text')?.text;
    if (!payloadText) throw new Error('MCP quality snapshot returned no text payload');
    const payload = JSON.parse(payloadText) as {
      schema?: string;
      readiness?: { score?: number; total?: number };
      checks?: Array<{ area?: string; status?: string }>;
      runtime_manifest?: { agent_parity?: { operations?: Array<{ name?: string }> } };
    };
    if (payload.schema !== 'cortex.saas-quality-snapshot.v1') throw new Error(`unexpected quality schema: ${payload.schema}`);
    if (!payload.readiness || typeof payload.readiness.score !== 'number') throw new Error('quality snapshot missing readiness score');
    if (!Array.isArray(payload.checks) || payload.checks.length < 7) throw new Error('quality snapshot missing readiness checks');
    const opNames = new Set(payload.runtime_manifest?.agent_parity?.operations?.map(op => op.name) || []);
    if (!opNames.has('saas_quality_snapshot')) throw new Error('quality snapshot manifest is missing saas_quality_snapshot parity op');
    artifacts.mcpQualityScore = payload.readiness.score;
  });

  await step('MCP tools/list is reachable, non-empty, and Cortex-branded', async () => {
    const res = await fetchImpl(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`/mcp returned ${res.status}: ${text.slice(0, 500)}`);
    assertNoLegacyBrand(text, 'MCP tools/list');
    const parsed = parseMcpResponse(text) as { result?: { tools?: unknown[] } };
    const tools = Array.isArray(parsed.result?.tools) ? parsed.result.tools : [];
    const count = tools.length;
    if (count < 1) throw new Error('MCP tools/list returned no tools');
    const names = new Set(tools.map((tool) => {
      if (tool && typeof tool === 'object' && 'name' in tool) return String((tool as { name?: unknown }).name);
      return '';
    }));
    for (const required of ['saas_sources_list', 'saas_sources_create', 'saas_integrations_status', 'saas_runtime_package_index', 'saas_quality_snapshot']) {
      if (!names.has(required)) throw new Error(`MCP tools/list missing ${required}`);
    }
    artifacts.mcpToolCount = count;
  });

  return { ok: true, baseUrl, checks, artifacts };
}

function printHuman(result: LiveSmokeResult): void {
  console.log(`Cortex SaaS live smoke passed for ${result.baseUrl}`);
  for (const check of result.checks) {
    console.log(`  ok ${check.name} (${check.ms}ms)`);
  }
  console.log(`Signup: ${result.artifacts.signupUrl}`);
  if (result.artifacts.onboardingUrl) console.log(`Onboarding: ${result.artifacts.onboardingUrl}`);
  if (result.artifacts.agentClientId) console.log(`Agent client: ${result.artifacts.agentClientId}`);
  if (result.artifacts.inviteDeliveryId) console.log(`Invite delivery: ${result.artifacts.inviteDeliveryId}`);
  if (result.artifacts.billingEventId) console.log(`Billing event: ${result.artifacts.billingEventId}`);
  if (result.artifacts.mcpIntegrationProvider) console.log(`MCP integration provider: ${result.artifacts.mcpIntegrationProvider}`);
  if (result.artifacts.mcpQualityScore !== undefined) console.log(`MCP quality score: ${result.artifacts.mcpQualityScore}%`);
  if (result.artifacts.mcpToolCount !== undefined) console.log(`MCP tools: ${result.artifacts.mcpToolCount}`);
}

if (import.meta.main) {
  try {
    const args = readArgs(Bun.argv.slice(2));
    if (args.help) {
      console.log(usageText());
      process.exit(0);
    }
    const result = await runLiveSmoke(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[smoke:saas-live] ${message}`);
    process.exit(1);
  }
}
