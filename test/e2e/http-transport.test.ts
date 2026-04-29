/**
 * E2E tests for src/mcp/http-transport.ts against real Postgres.
 *
 * Catches schema drift (column-name typos that would slip past the unit suite's
 * stubbed engine.sql) and proves the F1+F2+F3 dispatch pipeline works against a
 * real handler doing real DB work. Also exercises the SQL-level last_used_at
 * debounce against real Postgres semantics.
 *
 * Run: DATABASE_URL=... bun test test/e2e/http-transport.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E http-transport tests (DATABASE_URL not set)');
}

interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

function generateToken(): string {
  return 'gbrain_test_' + randomBytes(16).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function startServer(): Promise<ServerHandle> {
  const engine = getEngine();
  const server = await startHttpTransport({ port: 0, engine: engine as any });
  return {
    port: (server as any).port,
    stop: async () => { (server as any).stop(true); },
  };
}

function rpc(method: string, params?: unknown, id: number = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

describeE2E('http-transport E2E (real Postgres)', () => {
  let srv: ServerHandle;
  let validToken: string;
  let revokedToken: string;
  let validTokenName: string;

  beforeAll(async () => {
    await setupDB();
    const conn = getConn();

    // Seed a valid + revoked token directly via SQL (mirrors auth.ts's create path).
    validToken = generateToken();
    validTokenName = 'e2e-valid-' + randomBytes(4).toString('hex');
    await conn.unsafe(
      'INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)',
      [validTokenName, hashToken(validToken)],
    );
    revokedToken = generateToken();
    await conn.unsafe(
      'INSERT INTO access_tokens (name, token_hash, revoked_at) VALUES ($1, $2, now())',
      ['e2e-revoked-' + randomBytes(4).toString('hex'), hashToken(revokedToken)],
    );

    srv = await startServer();
  });

  afterAll(async () => {
    if (srv) await srv.stop();
    await teardownDB();
  });

  test('1. /health → 200 with expected JSON shape', async () => {
    const r = await fetch(`http://localhost:${srv.port}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.transport).toBe('http');
    expect(body.version).toBeString();
  });

  test('2. /mcp tools/list with valid Bearer → 200 + ops list', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.tools).toBeArray();
    expect(body.result.tools.length).toBeGreaterThan(5);
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  test('3. /mcp tools/call (real op: list_pages) round-trips successfully — F1+F2+F3 guard', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'list_pages', arguments: { limit: 5 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.content).toBeArray();
    // Should NOT be an error — handler ran successfully against the real engine.
    expect(body.result.isError).toBeUndefined();
    // Result text should parse as JSON (list_pages returns an object/array)
    const resultText = body.result.content[0].text;
    const parsed = JSON.parse(resultText);
    expect(parsed).toBeDefined();
  });

  test('4. revoked token → 401', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${revokedToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('5. last_used_at debounce: two consecutive valid calls → only one UPDATE within 60s', async () => {
    const conn = getConn();

    // Reset last_used_at to NULL so the first call definitely updates
    await conn.unsafe('UPDATE access_tokens SET last_used_at = NULL WHERE name = $1', [validTokenName]);

    // First request — should update last_used_at
    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    // Give the fire-and-forget UPDATE a moment to land
    await new Promise(r => setTimeout(r, 50));

    const [row1] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    expect(row1.last_used_at).not.toBeNull();
    const firstUpdate = row1.last_used_at;

    // Second request immediately — should NOT trigger another UPDATE (debounced by SQL WHERE)
    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    await new Promise(r => setTimeout(r, 50));

    const [row2] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    // Same timestamp = same UPDATE = debounce held
    expect(row2.last_used_at?.getTime()).toBe(firstUpdate?.getTime());
  });

  test('6. last_used_at debounce: simulating 65s gap → second request DOES update', async () => {
    const conn = getConn();

    // Set last_used_at to 65 seconds ago — simulates the time gap without waiting in real time
    await conn.unsafe(
      `UPDATE access_tokens SET last_used_at = now() - interval '65 seconds' WHERE name = $1`,
      [validTokenName],
    );
    const [before] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];

    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    await new Promise(r => setTimeout(r, 50));

    const [after] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    expect(after.last_used_at?.getTime()).toBeGreaterThan(before.last_used_at!.getTime());
  });

  test('7. mcp_request_log gets a row per request', async () => {
    const conn = getConn();
    const beforeRows = await conn.unsafe('SELECT count(*)::int AS n FROM mcp_request_log') as { n: number }[];
    const beforeN = beforeRows[0].n;

    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    // Fire-and-forget audit insert — give it a tick
    await new Promise(r => setTimeout(r, 100));

    const afterRows = await conn.unsafe('SELECT count(*)::int AS n FROM mcp_request_log') as { n: number }[];
    expect(afterRows[0].n).toBeGreaterThan(beforeN);

    const [row] = await conn.unsafe(
      `SELECT token_name, operation, status, latency_ms FROM mcp_request_log
       WHERE token_name = $1 ORDER BY created_at DESC LIMIT 1`,
      [validTokenName],
    ) as { token_name: string; operation: string; status: string; latency_ms: number }[];
    expect(row.token_name).toBe(validTokenName);
    expect(row.operation).toBe('tools/list');
    expect(row.status).toBe('success');
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('8. tools/call with malformed params → isError result with invalid_params', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'get_page', arguments: { slug: 42 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('invalid_params');
  });
});
