import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  createInviteRecord,
  createOrganization,
  createTenantBrain,
  ensureSaasControlPlane,
  getSaasPlan,
  claimEmailDeliveries,
  listInvites,
  listEmailDeliveries,
  markEmailDeliveryResult,
  listMembers,
  listOrganizations,
  listSkillPolicies,
  listTenantBrains,
  normalizeOrgSlug,
  queueInviteEmailDelivery,
  reconcileSaasBillingEvent,
  SaasPlanLimitError,
  updateSaasPlan,
  upsertSkillPolicy,
  upsertMember,
} from '../src/core/saas-control-plane.ts';
import { drainInviteEmailDeliveries } from '../src/core/saas-email-delivery.ts';
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
  await ensureSaasControlPlane(engine);
});

describe('saas control plane', () => {
  test('normalizes organization slugs for signup URLs', () => {
    expect(normalizeOrgSlug('Acme AI, Inc.')).toBe('acme-ai-inc');
  });

  test('persists org, brain, member, and invite records', async () => {
    const org = await createOrganization(engine, { name: 'Acme AI', domain: 'acme.ai' });
    const brain = await createTenantBrain(engine, {
      orgId: org.id,
      name: 'Company Brain',
      publicUrl: 'https://acme.example.com',
      status: 'online',
    });
    const member = await upsertMember(engine, {
      orgId: org.id,
      email: 'owner@acme.ai',
      role: 'owner',
      sourceId: 'default',
      federatedRead: ['default'],
      oauthClientId: 'cortex_cl_owner',
    });
    const invite = await createInviteRecord(engine, {
      orgId: org.id,
      email: 'teammate@acme.ai',
      role: 'member',
      sourceId: 'default',
      federatedRead: ['default'],
      oauthClientId: 'cortex_cl_teammate',
      onboardingUrl: 'https://acme.example.com/admin/onboarding?invite=x',
    });
    const delivery = await queueInviteEmailDelivery(engine, {
      orgId: org.id,
      inviteId: invite.id,
      email: invite.email,
      onboardingUrl: invite.onboarding_url,
      kind: 'teammate_invite',
    });

    expect(org.slug).toBe('acme-ai');
    expect(brain.org_id).toBe(org.id);
    expect(member.oauth_client_id).toBe('cortex_cl_owner');
    expect(invite.onboarding_url).toContain('/admin/onboarding');
    expect(delivery.status).toBe('queued');
    expect(delivery.provider).toBe('outbox');
    expect(await listOrganizations(engine)).toHaveLength(1);
    expect(await listTenantBrains(engine, org.id)).toHaveLength(1);
    expect(await listMembers(engine, org.id)).toHaveLength(1);
    const invites = await listInvites(engine, org.id);
    expect(invites).toHaveLength(1);
    expect(invites[0].delivery_status).toBe('queued');
    expect(await listEmailDeliveries(engine, { orgId: org.id })).toHaveLength(1);

    const claimed = await claimEmailDeliveries(engine, { orgId: org.id, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('sending');
    expect(claimed[0].attempts).toBe(1);

    const sent = await markEmailDeliveryResult(engine, {
      id: claimed[0].id,
      status: 'sent',
      providerMessageId: 'provider_msg_123',
    });
    expect(sent.status).toBe('sent');
    expect(sent.provider_message_id).toBe('provider_msg_123');
    expect(sent.sent_at).not.toBeNull();
    const sentInvites = await listInvites(engine, org.id);
    expect(sentInvites[0].delivery_status).toBe('sent');
  });

  test('drains queued invite deliveries through a configured provider', async () => {
    const org = await createOrganization(engine, { name: 'Provider Co' });
    const invite = await createInviteRecord(engine, {
      orgId: org.id,
      email: 'teammate@provider.example',
      role: 'member',
      sourceId: 'default',
      federatedRead: ['default'],
      onboardingUrl: 'https://provider.example/admin/onboarding?invite=x',
    });
    await queueInviteEmailDelivery(engine, {
      orgId: org.id,
      inviteId: invite.id,
      email: invite.email,
      onboardingUrl: invite.onboarding_url,
      kind: 'teammate_invite',
    });

    const sentBodies: Array<Record<string, unknown>> = [];
    const result = await drainInviteEmailDeliveries(engine, {
      orgId: org.id,
      provider: 'resend',
      apiKey: 're_test_key',
      from: 'Cortex <onboarding@example.com>',
      fetcher: async (url, init) => {
        expect(url).toBe('https://api.resend.com/emails');
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer re_test_key');
        expect(String(headers['idempotency-key']).startsWith('cortex-invite-msg_')).toBe(true);
        sentBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 'resend_msg_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.configured).toBe(true);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sentBodies[0].from).toBe('Cortex <onboarding@example.com>');
    expect(sentBodies[0].to).toEqual(['teammate@provider.example']);
    expect(String(sentBodies[0].html)).toContain('https://provider.example/admin/onboarding?invite=x');
    const deliveries = await listEmailDeliveries(engine, { orgId: org.id });
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].provider).toBe('resend');
    expect(deliveries[0].provider_message_id).toBe('resend_msg_1');
  });

  test('does not claim invite deliveries until provider credentials are configured', async () => {
    const org = await createOrganization(engine, { name: 'Missing Provider Co' });
    await queueInviteEmailDelivery(engine, {
      orgId: org.id,
      email: 'owner@missing-provider.example',
      onboardingUrl: 'https://missing-provider.example/admin/onboarding?invite=x',
      kind: 'owner_onboarding',
    });

    const previous = {
      CORTEX_RESEND_API_KEY: process.env.CORTEX_RESEND_API_KEY,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      CORTEX_EMAIL_FROM: process.env.CORTEX_EMAIL_FROM,
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
      RESEND_FROM: process.env.RESEND_FROM,
    };
    delete process.env.CORTEX_RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.CORTEX_EMAIL_FROM;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.RESEND_FROM;
    let result: Awaited<ReturnType<typeof drainInviteEmailDeliveries>> | null = null;
    try {
      result = await drainInviteEmailDeliveries(engine, {
        orgId: org.id,
        provider: 'resend',
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(result?.configured).toBe(false);
    expect(result?.claimed).toBe(0);
    expect(result?.required_env).toContain('RESEND_API_KEY or CORTEX_RESEND_API_KEY');
    const deliveries = await listEmailDeliveries(engine, { orgId: org.id });
    expect(deliveries[0].status).toBe('queued');
    expect(deliveries[0].attempts).toBe(0);
  });

  test('creates a launch plan and reports tenant-scoped usage', async () => {
    const org = await createOrganization(engine, { name: 'Usage Co' });
    await createTenantBrain(engine, { orgId: org.id, name: 'Company Brain' });
    await upsertMember(engine, {
      orgId: org.id,
      email: 'owner@usage.example',
      role: 'owner',
      sourceId: 'default',
      federatedRead: ['default'],
      oauthClientId: 'cortex_cl_owner',
    });

    const plan = await getSaasPlan(engine, org.id);

    expect(plan.plan_key).toBe('launch');
    expect(plan.limits.brains).toBe(3);
    expect(plan.usage.brains).toBe(1);
    expect(plan.usage.members).toBe(1);
    expect(plan.usage.sources).toBeGreaterThanOrEqual(1);
    expect(plan.remaining.brains).toBe(2);
    expect(plan.violations).toEqual([]);
  });

  test('plan usage tolerates scalar source_access from older skill rows', async () => {
    const org = await createOrganization(engine, { name: 'Legacy Skill Co' });
    await engine.executeRaw(
      `INSERT INTO saas_skill_policies
         (id, name, owner, status, triggers, allowed_clients, source_access, description, enforcement_status, metadata)
       VALUES
         ('legacy-scalar-skill', 'Legacy Scalar Skill', 'workspace', 'installed',
          '[]'::jsonb, '[]'::jsonb, '"default"'::jsonb, '', 'not_enforced', '{}'::jsonb)`,
    );

    const plan = await getSaasPlan(engine, org.id);

    expect(plan.usage.skill_policies).toBe(1);
  });

  test('blocks tenant brain creation when a hard plan limit is reached', async () => {
    const org = await createOrganization(engine, { name: 'Limit Co' });
    await updateSaasPlan(engine, org.id, { limits: { brains: 1 } });
    await createTenantBrain(engine, { orgId: org.id, name: 'First Brain' });

    await expect(createTenantBrain(engine, { orgId: org.id, name: 'Second Brain' }))
      .rejects.toBeInstanceOf(SaasPlanLimitError);
  });

  test('reconciles billing webhooks into tenant plans idempotently', async () => {
    const org = await createOrganization(engine, { name: 'Billing Co' });
    const first = await reconcileSaasBillingEvent(engine, {
      provider: 'stripe',
      eventId: 'evt_billing_test',
      eventType: 'customer.subscription.updated',
      orgId: org.id,
      billingCustomerId: 'cus_billing_test',
      billingSubscriptionId: 'sub_billing_test',
      planKey: 'business',
      status: 'active',
      billingPlanRef: 'price_business',
      billingCurrentPeriodEnd: '2026-06-30T00:00:00.000Z',
      raw: { id: 'evt_billing_test' },
    });

    expect(first.applied).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.plan.plan_key).toBe('business');
    expect(first.plan.billing_provider).toBe('stripe');
    expect(first.plan.billing_customer_id).toBe('cus_billing_test');
    expect(first.plan.billing_subscription_id).toBe('sub_billing_test');
    expect(first.plan.billing_plan_ref).toBe('price_business');
    expect(first.plan.billing_current_period_end).toBe('2026-06-30T00:00:00.000Z');

    const duplicate = await reconcileSaasBillingEvent(engine, {
      provider: 'stripe',
      eventId: 'evt_billing_test',
      billingSubscriptionId: 'sub_billing_test',
      planKey: 'launch',
      raw: { id: 'evt_billing_test' },
    });

    expect(duplicate.applied).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.plan.plan_key).toBe('business');
  });

  test('allows duplicate organization names by suffixing the slug', async () => {
    const first = await createOrganization(engine, { name: 'Acme AI' });
    const second = await createOrganization(engine, { name: 'Acme AI' });

    expect(first.slug).toBe('acme-ai');
    expect(second.slug).toStartWith('acme-ai-');
    expect(second.slug).not.toBe(first.slug);
    expect(await listOrganizations(engine)).toHaveLength(2);
  });

  test('persists skill policy customization', async () => {
    const policy = await upsertSkillPolicy(engine, {
      id: 'Customer Brief',
      name: 'Customer Brief',
      owner: 'growth',
      status: 'needs-enforcement',
      triggers: ['brief customer', 'prep account'],
      allowedClients: ['cortex_cl_sales'],
      sourceAccess: ['default'],
      description: 'Draft customer briefing workflow.',
      enforcementStatus: 'needs_enforcement',
    });

    expect(policy.id).toBe('customer-brief');
    expect(policy.allowed_clients).toEqual(['cortex_cl_sales']);
    expect(policy.source_access).toEqual(['default']);
    expect(policy.enforcement_status).toBe('enforced');

    const policies = await listSkillPolicies(engine);
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('Customer Brief');
  });
});
