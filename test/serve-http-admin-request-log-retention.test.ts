/**
 * Admin dashboard request-log retention (#6770 rewrite).
 *
 * Authoring gate: (1) protects the Agents page's lifetime totals (total
 * requests, OAuth last-used) across a prune, and the Request Log endpoint's
 * retention fields the page shows; (2) fails when the dashboard counts only
 * the rows still in mcp_request_log, so a prune would silently shrink every
 * agent's total; (3) no existing test covers /admin/api/agents or
 * /admin/api/requests; (4) no production seam: the admin area is mounted on a
 * bare express app with a stub context, as CONTRIBUTING describes.
 *
 * Repo-less PGLite (no git checkout).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountAdminApi } from '../src/commands/serve-http-admin-api.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { MCP_LOG_RETENTION_KEY, runMcpLogRetention } from '../src/core/mcp-request-log-retention.ts';

let engine: PGLiteEngine;
let server: Server;
let base: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const app = express();
  const ctx = {
    engine, config: { engine: 'pglite' }, sql: sqlQueryForEngine(engine),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    adminSessions: new Map(), sseClients: new Set(), oauthProvider: {},
    issuerUrl: new URL('http://127.0.0.1/'), mcpResourceUrl: new URL('http://127.0.0.1/mcp'),
  } as unknown as ServeHttpContext;
  mountAdminApi(app, ctx);
  server = app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await engine.disconnect();
});

async function seed(token: string, count: number, daysAgo: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, created_at)
       VALUES ($1, $1, 'query', 5, 'success', now() - ($2::int * interval '1 day') - ($3::int * interval '1 minute'))`,
      [token, daysAgo, i]);
  }
}

const getJson = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;

describe('admin dashboard across a request-log prune', () => {
  test('Agents totals and OAuth last-used survive the prune; the Request Log reports the retention window', async () => {
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read) VALUES ('alice-client', 'alice-client', 'read', 'default', ARRAY['default'])");
    await engine.executeRaw("INSERT INTO access_tokens (name, token_hash) VALUES ('acme-key', 'hash-acme-key')");
    await seed('alice-client', 4, 90);
    await seed('alice-client', 2, 2);
    await seed('acme-key', 3, 120);

    const before = await getJson('/admin/api/agents');
    const pick = (rows: any[], name: string) => rows.find(r => r.name === name);
    expect(pick(before, 'alice-client').total_requests).toBe(6);
    expect(pick(before, 'acme-key').total_requests).toBe(3);
    const lastUsedBefore = pick(before, 'alice-client').last_used_at;
    expect((await getJson('/admin/api/requests')).retention_days).toBeNull();

    await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
    expect((await runMcpLogRetention(engine))?.deleted).toBe(7);

    const after = await getJson('/admin/api/agents');
    expect(pick(after, 'alice-client').total_requests).toBe(6);
    expect(pick(after, 'acme-key').total_requests).toBe(3);
    expect(pick(after, 'alice-client').last_used_at).toBe(lastUsedBefore);
    expect(pick(after, 'alice-client').requests_today).toBe(0);

    const log = await getJson('/admin/api/requests');
    expect(log.total).toBe(2);
    expect(log.retention_days).toBe(30);
    expect(Date.parse(log.pruned_before)).toBeLessThan(Date.now() - 30 * 86_400_000);
  }, 60_000);
});
