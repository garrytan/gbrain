import { describe, expect, test } from 'bun:test';
import {
  parseMcpResponse,
  readArgs,
  runLiveSmoke,
} from '../scripts/saas-live-smoke.ts';

const baseUrl = 'https://cortex.example.test';

function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

function text(data: string, status = 200, headers?: HeadersInit) {
  return new Response(data, { status, headers });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function createFetchMock(): typeof fetch {
  const orgId = 'org_smoke';
  const sourceId = 'smoke-source';
  const inviteClientId = 'cortex_cl_invite';
  const ownerClientId = 'cortex_cl_owner';
  const ownerClientSecret = 'owner-secret';
  const agentClientId = 'cortex_cl_agent';
  const agentClientSecret = 'smoke-agent-secret-0123456789';
  const accessToken = 'cortex_access_token';
  const ownerAccessToken = 'cortex_owner_access_token';
  let billingSeen = false;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = init?.method?.toUpperCase() || 'GET';

    if (method === 'GET' && path === '/') {
      return text('<html><body>Cortex Brain hosted MCP control plane</body></html>');
    }

    if (method === 'GET' && path === '/admin/signup') {
      return text('<html><body>Create a Cortex tenant</body></html>');
    }

    if (method === 'POST' && (path === '/admin/api/signup' || path === '/api/signup')) {
      const onboarding = `${baseUrl}/admin/onboarding?invite=owner`;
      return json({
        org: { id: orgId, name: 'Smoke Org' },
        brain: { id: 'brain_smoke', name: 'Company Brain' },
        onboarding_url: onboarding,
        connectCommand: `cortex connect '${onboarding}' --client-secret '${ownerClientSecret}'`,
        clientId: ownerClientId,
        clientSecret: ownerClientSecret,
        invite_delivery: { id: 'msg_owner', status: 'queued' },
        runtime_manifest: { schema: 'cortex.runtime-manifest.v1' },
      });
    }

    if (method === 'GET' && path === '/runtime-package.json') {
      return json({
        schema: 'cortex.runtime-package-index.v1',
        endpoints: {
          runtime_manifest: `${baseUrl}/runtime-manifest.json`,
          runtime_package: `${baseUrl}/runtime-package.json`,
          mcp_url: `${baseUrl}/mcp`,
        },
        packages: {
          cortex_cli: { artifact: 'cortex' },
        },
        verification: [
          `cortex runtime install cursor --manifest-url ${baseUrl}/runtime-manifest.json --json`,
        ],
      });
    }

    if (method === 'POST' && path === '/admin/api/issue-magic-link') {
      expect(header(init, 'authorization')).toBe('Bearer admin-token');
      return json({ url: `${baseUrl}/admin/auth/smoke` });
    }

    if (method === 'GET' && path === '/admin/auth/smoke') {
      return text('', 302, {
        location: '/admin/overview',
        'set-cookie': 'cortex_admin=session; Path=/; HttpOnly',
      });
    }

    if (method === 'GET' && path === '/admin/api/orgs') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      return json([{ id: orgId, name: 'Smoke Org' }]);
    }

    if (method === 'GET' && path === '/admin/api/plan') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      expect(url.searchParams.get('orgId')).toBe(orgId);
      return json({
        org_id: orgId,
        plan_key: 'launch',
        usage: { brains: 1 },
        limits: { brains: 3 },
        remaining: { brains: 2 },
        violations: [],
      });
    }

    if (method === 'POST' && path === '/admin/api/plan') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.orgId).toBe(orgId);
      return json({
        org_id: orgId,
        plan_key: body.planKey,
        usage: { brains: 1 },
        limits: { brains: 5 },
        remaining: { brains: 4 },
        violations: [],
      });
    }

    if (method === 'POST' && path === '/webhooks/billing') {
      expect(header(init, 'x-cortex-billing-secret')).toBe('billing-secret');
      const body = JSON.parse(bodyText(init));
      if (billingSeen) {
        return json({ received: true, applied: false, duplicate: true, event_id: body.eventId, plan: { plan_key: 'business' } });
      }
      billingSeen = true;
      return json({
        received: true,
        applied: true,
        duplicate: false,
        event_id: body.eventId,
        plan: {
          org_id: orgId,
          plan_key: 'business',
          billing_subscription_id: body.billingSubscriptionId,
        },
      }, 202);
    }

    if (method === 'POST' && path === '/admin/api/invites') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      return json({
        invite: { id: 'invite_smoke' },
        onboardingUrl: `${baseUrl}/admin/onboarding?invite=teammate`,
        clientId: inviteClientId,
        clientSecret: 'invite-secret',
        inviteDelivery: { id: 'msg_invite', status: 'queued' },
      });
    }

    if (method === 'GET' && path === '/admin/api/invite-deliveries') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      return json([
        { id: 'msg_owner', org_id: orgId, email: 'owner@example.test', status: 'queued', provider: 'outbox' },
        { id: 'msg_invite', org_id: orgId, email: 'teammate@example.test', status: 'queued', provider: 'outbox' },
      ]);
    }

    if (method === 'POST' && path === '/admin/api/invite-deliveries/claim') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.orgId).toBe(orgId);
      return json([
        { id: 'msg_owner', org_id: orgId, email: 'owner@example.test', status: 'sending', provider: 'outbox' },
        { id: 'msg_invite', org_id: orgId, email: 'teammate@example.test', status: 'sending', provider: 'outbox' },
      ]);
    }

    if (method === 'POST' && path === '/admin/api/invite-deliveries/msg_invite/result') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.status).toBe('sent');
      return json({
        id: 'msg_invite',
        org_id: orgId,
        email: 'teammate@example.test',
        status: 'sent',
        provider: 'outbox',
        provider_message_id: body.providerMessageId,
      });
    }

    if (method === 'POST' && path === '/admin/api/invite-deliveries/drain') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.orgId).toBe(orgId);
      return json({
        provider: 'resend',
        configured: false,
        claimed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        required_env: ['RESEND_API_KEY or CORTEX_RESEND_API_KEY', 'CORTEX_EMAIL_FROM or RESEND_FROM_EMAIL'],
        message: 'Set a Resend API key and Cortex sender address before draining invite delivery.',
        deliveries: [],
        results: [],
      });
    }

    if (method === 'POST' && path === '/admin/api/sources') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      return json({ id: body.id ?? sourceId, name: body.name ?? 'Smoke Source' });
    }

    if (method === 'POST' && path === '/admin/api/skills') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.allowedClients).toContain(inviteClientId);
      return json({ id: body.id, status: body.status });
    }

    if (method === 'POST' && path === '/admin/api/register-client') {
      expect(header(init, 'cookie')).toContain('cortex_admin=');
      const body = JSON.parse(bodyText(init));
      expect(body.federatedRead).toContain('default');
      return json({ clientId: agentClientId, clientSecret: agentClientSecret });
    }

    if (method === 'POST' && path === '/webhooks/composio') {
      expect(header(init, 'x-cortex-webhook-secret')).toBe('composio-secret');
      return json({ job_id: 42, source_id: 'composio-slack' }, 202);
    }

    if (method === 'POST' && path === '/token') {
      const form = new URLSearchParams(bodyText(init));
      const clientId = form.get('client_id');
      if (clientId === ownerClientId) {
        expect(form.get('client_secret')).toBe(ownerClientSecret);
        expect(form.get('scope')).toBe('users_admin');
        return json({ access_token: ownerAccessToken, token_type: 'Bearer' });
      }
      expect(clientId).toBe(agentClientId);
      expect(form.get('client_secret')).toBe(agentClientSecret);
      return json({ access_token: accessToken, token_type: 'Bearer' });
    }

    if (method === 'POST' && path === '/mcp') {
      expect(header(init, 'accept')).toContain('text/event-stream');
      const body = JSON.parse(bodyText(init));
      if (body.method === 'tools/call') {
        expect(header(init, 'authorization')).toBe(`Bearer ${ownerAccessToken}`);
        expect(body.params.arguments.public_url).toBe(baseUrl);
        if (body.params.name === 'saas_integrations_status') {
          return text(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [
            { type: 'text', text: JSON.stringify({
              provider: 'Composio',
              webhookUrl: `${baseUrl}/webhooks/composio`,
              connectors: [
                { id: 'slack', sourceId: 'composio-slack', connected: true },
              ],
            }) },
          ] } })}\n\n`, 200, {
            'content-type': 'text/event-stream',
          });
        }
        expect(body.params.name).toBe('saas_quality_snapshot');
        return text(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [
          { type: 'text', text: JSON.stringify({
            schema: 'cortex.saas-quality-snapshot.v1',
            readiness: { score: 100, passed: 7, total: 7, status: 'passing' },
            checks: [
              { area: 'Signup and onboarding', status: 'passing' },
              { area: 'Agent access', status: 'passing' },
              { area: 'Source ingestion', status: 'passing' },
              { area: 'Composio ingestion', status: 'passing' },
              { area: 'Skill promotion', status: 'passing' },
              { area: 'Queue health', status: 'passing' },
              { area: 'Agent parity', status: 'passing' },
            ],
            runtime_manifest: {
              agent_parity: {
                operations: [{ name: 'saas_quality_snapshot' }],
              },
            },
          }) },
        ] } })}\n\n`, 200, {
          'content-type': 'text/event-stream',
        });
      }
      expect(header(init, 'authorization')).toBe(`Bearer ${accessToken}`);
      return text(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [
        { name: 'saas_signup_create', description: 'Create Cortex tenants' },
        { name: 'saas_sources_list', description: 'List Cortex sources' },
        { name: 'saas_sources_create', description: 'Create Cortex sources' },
        { name: 'saas_integrations_status', description: 'Inspect Cortex integrations' },
        { name: 'saas_runtime_package_index', description: 'Inspect Cortex runtime packages' },
        { name: 'saas_quality_snapshot', description: 'Inspect Cortex readiness' },
      ] } })}\n\n`, 200, {
        'content-type': 'text/event-stream',
      });
    }

    return json({ error: `unhandled ${method} ${path}` }, 404);
  }) as typeof fetch;
}

describe('saas live smoke script', () => {
  test('parses CLI flags with Cortex env defaults', () => {
    expect(readArgs(['--json'], {
      CORTEX_PUBLIC_URL: baseUrl,
      CORTEX_ADMIN_BOOTSTRAP_TOKEN: 'admin-token',
      CORTEX_COMPOSIO_WEBHOOK_SECRET: 'composio-secret',
      CORTEX_BILLING_WEBHOOK_SECRET: 'billing-secret',
    })).toEqual({
      baseUrl,
      adminToken: 'admin-token',
      composioSecret: 'composio-secret',
      billingSecret: 'billing-secret',
      skipComposio: false,
      skipBilling: false,
      json: true,
      help: false,
    });
  });

  test('parses MCP event-stream responses', () => {
    expect(parseMcpResponse('event: message\ndata: {"result":{"tools":[{"name":"x"}]}}\n\n'))
      .toEqual({ result: { tools: [{ name: 'x' }] } });
  });

  test('runs the full public SaaS flow without leaking legacy brand copy', async () => {
    const result = await runLiveSmoke({
      baseUrl,
      adminToken: 'admin-token',
      composioSecret: 'composio-secret',
      billingSecret: 'billing-secret',
      skipComposio: false,
      skipBilling: false,
      json: false,
      help: false,
    }, createFetchMock());

    expect(result.ok).toBe(true);
    expect(result.checks.every(check => check.ok)).toBe(true);
    expect(result.artifacts.signupUrl).toBe(`${baseUrl}/admin/signup`);
    expect(result.artifacts.onboardingUrl).toBe(`${baseUrl}/admin/onboarding?invite=owner`);
    expect(result.artifacts.inviteOnboardingUrl).toBe(`${baseUrl}/admin/onboarding?invite=teammate`);
    expect(result.artifacts.agentClientId).toBe('cortex_cl_agent');
    expect(result.artifacts.ownerInviteDeliveryId).toBe('msg_owner');
    expect(result.artifacts.inviteDeliveryId).toBe('msg_invite');
    expect(result.artifacts.composioJobId).toBe(42);
    expect(result.artifacts.billingEventId).toStartWith('evt_cortex_smoke_');
    expect(result.artifacts.mcpIntegrationProvider).toBe('Composio');
    expect(result.artifacts.mcpQualityScore).toBe(100);
    expect(result.artifacts.mcpToolCount).toBe(6);
  });
});
