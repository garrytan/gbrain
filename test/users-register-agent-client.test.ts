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

describe('users_register_agent_client', () => {
  test('is an agent-callable users_admin operation', () => {
    const op = findOp('users_register_agent_client');
    expect(op.scope).toBe('users_admin');
    expect(op.mutating).toBe(true);
    expect(op.localOnly).toBeFalsy();
  });

  test('creates a source-scoped OAuth client and returns one-time credentials', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::jsonb)`,
      ['engineering', 'Engineering', JSON.stringify({ federated: true })],
    );

    const result = await findOp('users_register_agent_client').handler(ctx(), {
      name: 'eng-agent',
      scopes: 'read write',
      source_id: 'engineering',
      federated_read: ['engineering', 'default'],
      token_ttl: 604800,
    }) as {
      client_id: string;
      client_secret: string;
      source_id: string;
      federated_read: string[];
    };

    expect(result.client_id).toStartWith('cortex_cl_');
    expect(result.client_secret).toStartWith('cortex_cs_');
    expect(result.source_id).toBe('engineering');
    expect(result.federated_read.sort()).toEqual(['default', 'engineering']);

    const rows = await engine.executeRaw<{
      client_name: string;
      scope: string;
      source_id: string;
      federated_read: string[] | string;
      token_ttl: number;
    }>(
      `SELECT client_name, scope, source_id, federated_read, token_ttl
         FROM oauth_clients WHERE client_id = $1`,
      [result.client_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_name).toBe('eng-agent');
    expect(rows[0].scope).toBe('read write');
    expect(rows[0].source_id).toBe('engineering');
    expect(Number(rows[0].token_ttl)).toBe(604800);
  });
});

describe('users_create_invite', () => {
  test('is an agent-callable users_admin operation', () => {
    const op = findOp('users_create_invite');
    expect(op.scope).toBe('users_admin');
    expect(op.mutating).toBe(true);
    expect(op.localOnly).toBeFalsy();
  });

  test('creates a persisted invite, member, OAuth client, and onboarding URL', async () => {
    const previousPublicUrl = process.env.CORTEX_PUBLIC_URL;
    process.env.CORTEX_PUBLIC_URL = 'https://cortex.example';
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::jsonb)`,
        ['engineering', 'Engineering', JSON.stringify({ federated: true })],
      );

      const result = await findOp('users_create_invite').handler(ctx(), {
        email: 'Alice@Example.com',
        role: 'member',
        source_id: 'engineering',
        federated_read: ['engineering', 'default'],
      }) as {
        invite: { id: string; email: string; role: string; oauth_client_id: string; onboarding_url: string };
        member: { id: string; email: string; role: string; status: string; oauth_client_id: string };
        onboarding_url: string;
        invite_delivery: { id: string; email: string; status: string; provider: string };
        client_id: string;
        client_secret: string;
      };

      expect(result.client_id).toStartWith('cortex_cl_');
      expect(result.client_secret).toStartWith('cortex_cs_');
      expect(result.invite.email).toBe('alice@example.com');
      expect(result.member.email).toBe('alice@example.com');
      expect(result.member.status).toBe('invited');
      expect(result.invite.oauth_client_id).toBe(result.client_id);
      expect(result.member.oauth_client_id).toBe(result.client_id);
      expect(result.invite_delivery.email).toBe('alice@example.com');
      expect(result.invite_delivery.status).toBe('queued');
      expect(result.invite_delivery.provider).toBe('outbox');
      expect(result.onboarding_url).toStartWith('https://cortex.example/admin/onboarding?invite=');

      const encoded = result.onboarding_url.split('invite=')[1];
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        email: string;
        role: string;
        source_id: string;
        federated_read: string[];
        server_url: string;
        token_url: string;
        client_id: string;
      };
      expect(payload.email).toBe('alice@example.com');
      expect(payload.role).toBe('member');
      expect(payload.source_id).toBe('engineering');
      expect(payload.federated_read.sort()).toEqual(['default', 'engineering']);
      expect(payload.server_url).toBe('https://cortex.example/mcp');
      expect(payload.token_url).toBe('https://cortex.example/token');
      expect(payload.client_id).toBe(result.client_id);

      const inviteRows = await engine.executeRaw(
        `SELECT id, email, role, status, oauth_client_id
           FROM saas_org_invites WHERE oauth_client_id = $1`,
        [result.client_id],
      );
      expect(inviteRows).toHaveLength(1);

      const memberRows = await engine.executeRaw(
        `SELECT id, email, role, status, oauth_client_id
           FROM saas_org_members WHERE oauth_client_id = $1`,
        [result.client_id],
      );
      expect(memberRows).toHaveLength(1);

      const clients = await engine.executeRaw<{ scope: string; token_ttl: number }>(
        `SELECT scope, token_ttl FROM oauth_clients WHERE client_id = $1`,
        [result.client_id],
      );
      expect(clients).toHaveLength(1);
      expect(clients[0].scope).toBe('read write');
      expect(Number(clients[0].token_ttl)).toBe(604800);
    } finally {
      if (previousPublicUrl == null) {
        delete process.env.CORTEX_PUBLIC_URL;
      } else {
        process.env.CORTEX_PUBLIC_URL = previousPublicUrl;
      }
    }
  });
});
