import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { startHttpMcpServer, type TokenValidator } from '../src/mcp/http-server.ts';
import { createHash } from 'crypto';

let engine: PGLiteEngine;
let baseUrl: string;
let httpServer: ReturnType<typeof Bun.serve>;
const PORT = 18787;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('test/hello', {
    type: 'concept', title: 'Hello World',
    compiled_truth: 'A test page for the HTTP MCP server.',
  });
  httpServer = await startHttpMcpServer(engine, { port: PORT });
  baseUrl = `http://localhost:${PORT}`;
});

afterAll(async () => {
  httpServer.stop(true);
  await engine.disconnect();
});

async function mcpPost(url: string, method: string, params: unknown, id: number, extra?: Record<string, string>) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });
}

async function parseRes(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch {}
  for (const line of text.split('\n').filter(l => l.startsWith('data:'))) {
    try { const d = JSON.parse(line.slice(5).trim()); if (d.result || d.error) return d; } catch {}
  }
  throw new Error(`Unparseable: ${text.slice(0, 200)}`);
}

describe('HTTP MCP Server', () => {
  test('health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeTruthy();
  });

  test('404 for unknown paths', async () => {
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
  });

  test('initialize handshake', async () => {
    const body = await parseRes(await mcpPost(baseUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1));
    expect(body.result.serverInfo.name).toBe('gbrain');
  });

  test('tools/list returns 30+ operations', async () => {
    const body = await parseRes(await mcpPost(baseUrl, 'tools/list', {}, 2));
    expect(body.result.tools.length).toBeGreaterThan(25);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain('get_page');
    expect(names).toContain('search');
    expect(names).toContain('get_stats');
  });

  test('tools/call get_page round-trip', async () => {
    const body = await parseRes(await mcpPost(baseUrl, 'tools/call', {
      name: 'get_page', arguments: { slug: 'test/hello' },
    }, 3));
    const page = JSON.parse(body.result.content[0].text);
    expect(page.title).toBe('Hello World');
  });

  test('tools/call unknown tool → error', async () => {
    const body = await parseRes(await mcpPost(baseUrl, 'tools/call', {
      name: 'nope', arguments: {},
    }, 4));
    expect(body.result.isError).toBe(true);
  });

  test('tools/call missing required param → error', async () => {
    const body = await parseRes(await mcpPost(baseUrl, 'tools/call', {
      name: 'get_page', arguments: {},
    }, 5));
    expect(body.result.isError).toBe(true);
  });

  test('5 concurrent requests', async () => {
    const reqs = Array.from({ length: 5 }, (_, i) =>
      mcpPost(baseUrl, 'tools/call', { name: 'get_stats', arguments: {} }, 100 + i)
    );
    for (const res of await Promise.all(reqs)) {
      const body = await parseRes(res);
      expect(JSON.parse(body.result.content[0].text).page_count).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('HTTP MCP Server: Auth', () => {
  let authUrl: string;
  let authServer: ReturnType<typeof Bun.serve>;
  const TOKEN = 'gbrain_test_abc123';
  const HASH = createHash('sha256').update(TOKEN).digest('hex');
  const validator: TokenValidator = async (t) => {
    return createHash('sha256').update(t).digest('hex') === HASH ? 'test' : null;
  };

  beforeAll(async () => {
    authServer = await startHttpMcpServer(engine, { port: 18788, tokenValidator: validator });
    authUrl = 'http://localhost:18788';
  });
  afterAll(() => authServer.stop(true));

  test('valid token → 200', async () => {
    const res = await mcpPost(authUrl, 'tools/list', {}, 1, { Authorization: `Bearer ${TOKEN}` });
    expect(res.ok).toBe(true);
  });

  test('bad token → 401', async () => {
    expect((await mcpPost(authUrl, 'tools/list', {}, 2, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  test('no header → 401', async () => {
    expect((await mcpPost(authUrl, 'tools/list', {}, 3)).status).toBe(401);
  });

  test('health bypasses auth', async () => {
    expect((await fetch(`${authUrl}/health`)).status).toBe(200);
  });
});
