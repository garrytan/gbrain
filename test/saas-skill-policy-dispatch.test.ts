import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { ensureSaasControlPlane, upsertSkillPolicy } from '../src/core/saas-control-plane.ts';
import type { AuthInfo } from '../src/core/operations.ts';
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

function auth(clientId: string, sourceId = 'default'): AuthInfo {
  return {
    token: 'cortex_at_test',
    clientId,
    clientName: clientId,
    scopes: ['read'],
    sourceId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('SaaS skill policy dispatch enforcement', () => {
  test('allows an annotated skill call from an allowed client', async () => {
    await upsertSkillPolicy(engine, {
      id: 'customer-brief',
      name: 'Customer Brief',
      status: 'installed',
      allowedClients: ['cortex_cl_allowed'],
      sourceAccess: ['default'],
    });

    const result = await dispatchToolCall(engine, 'whoami', { _skill_id: 'customer-brief' }, {
      remote: true,
      sourceId: 'default',
      auth: auth('cortex_cl_allowed'),
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.client_id).toBe('cortex_cl_allowed');
  });

  test('denies an annotated skill call from a disallowed client', async () => {
    await upsertSkillPolicy(engine, {
      id: 'customer-brief',
      name: 'Customer Brief',
      status: 'installed',
      allowedClients: ['cortex_cl_allowed'],
      sourceAccess: ['default'],
    });

    const result = await dispatchToolCall(engine, 'whoami', { skill_id: 'customer-brief' }, {
      remote: true,
      sourceId: 'default',
      auth: auth('cortex_cl_denied'),
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('skill_policy_denied');
    expect(body.message).toContain('not allowed');
  });

  test('denies an annotated skill call outside the policy source access', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::jsonb)`,
      ['sales', 'Sales', JSON.stringify({ federated: true })],
    );
    await upsertSkillPolicy(engine, {
      id: 'customer-brief',
      name: 'Customer Brief',
      status: 'installed',
      allowedClients: ['cortex_cl_sales'],
      sourceAccess: ['default'],
    });

    const result = await dispatchToolCall(engine, 'whoami', { _meta: { skill_id: 'customer-brief' } }, {
      remote: true,
      sourceId: 'sales',
      auth: auth('cortex_cl_sales', 'sales'),
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('skill_policy_denied');
    expect(body.message).toContain('source sales');
  });

  test('denies draft skill policies even when the client is listed', async () => {
    await upsertSkillPolicy(engine, {
      id: 'draft-workflow',
      name: 'Draft Workflow',
      status: 'draft',
      allowedClients: ['cortex_cl_allowed'],
      sourceAccess: ['default'],
    });

    const result = await dispatchToolCall(engine, 'whoami', { _skill_id: 'draft-workflow' }, {
      remote: true,
      sourceId: 'default',
      auth: auth('cortex_cl_allowed'),
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('skill_policy_denied');
    expect(body.message).toContain('draft');
  });
});
