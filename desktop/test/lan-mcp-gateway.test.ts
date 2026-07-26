import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { createConnection } from 'node:net';
import {
  LAN_MCP_MAX_BATCH_ITEMS,
  LAN_MCP_MAX_BODY_BYTES,
  LanMcpGateway,
  type LanMcpGatewayOptions,
} from '../src/main/lan-mcp-gateway.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port.');
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return address.port;
}

function createGateway(options: Omit<LanMcpGatewayOptions, 'verifyBearerToken'>): LanMcpGateway {
  return new LanMcpGateway({
    ...options,
    verifyBearerToken: async () => true,
  });
}

function call(
  port: number,
  method: string,
  path: string,
  body = '',
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('desktop LAN MCP gateway', () => {
  test('forwards tool and source authorization decisions to the canonical sidecar', async () => {
    let targetHits = 0;
    const target = createServer((req, res) => {
      targetHits += 1;
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const canonicalCalls = [
      { id: 'query-snake', name: 'query', arguments: { query: '计划', source_id: 'secret' } },
      { id: 'recall', name: 'recall', arguments: { query: '上次讨论' } },
      { id: 'unknown', name: 'future_unreviewed_tool', arguments: {} },
    ];

    for (const item of canonicalCalls) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: item.id,
        method: 'tools/call',
        params: { name: item.name, arguments: item.arguments },
      });
      const response = await call(status.port, 'POST', '/mcp', body, {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe(body);
    }
    expect(targetHits).toBe(canonicalCalls.length);
  });

  test('allows ordinary scoped calls, tools/list, and safe JSON-RPC batches', async () => {
    let targetHits = 0;
    const target = createServer((req, res) => {
      targetHits += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const safePayloads = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: '刘慈欣' } },
      },
      [
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'get_page', arguments: { slug: 'wiki/safe' } },
        },
      ],
    ];
    for (const payload of safePayloads) {
      const body = JSON.stringify(payload);
      const response = await call(status.port, 'POST', '/mcp', body, {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe(body);
    }
    expect(targetHits).toBe(3);
  });

  test('returns the canonical sidecar tools/list response without a second allowlist', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          result: {
            tools: [
              { name: 'search' },
              { name: 'put_page' },
              { name: 'takes_list' },
              { name: 'get_stats' },
            ],
          },
        }));
      });
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const response = await call(status.port, 'POST', '/mcp', JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/list', params: {},
    }), {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search',
      'put_page',
      'takes_list',
      'get_stats',
    ]);
  });

  test('streams the canonical tools/list response unchanged when MCP uses SSE framing', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', id: 8, result: { tools: [{ name: 'search' }, { name: 'query' }, { name: 'takes_list' }] },
        })}\n\n`);
      });
    });
    const targetPort = await listen(target);
    const gateway = createGateway({ bindAddress: '127.0.0.1', sidecarPort: targetPort, listenPort: 0 });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const response = await call(status.port, 'POST', '/mcp', JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/list', params: {},
    }), { authorization: 'Bearer test-key', 'content-type': 'application/json' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const data = response.body.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim();
    expect(JSON.parse(data).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search',
      'query',
      'takes_list',
    ]);
  });

  test('does not parse or rewrite sidecar SSE responses', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {not-json}\n\n');
      });
    });
    const targetPort = await listen(target);
    const gateway = createGateway({ bindAddress: '127.0.0.1', sidecarPort: targetPort, listenPort: 0 });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();
    const response = await call(status.port, 'POST', '/mcp', JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'tools/list', params: {},
    }), { authorization: 'Bearer test-key', 'content-type': 'application/json' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('data: {not-json}\n\n');
  });

  test('rejects an entire batch containing an unsupported MCP protocol method', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end('unexpected');
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const response = await call(status.port, 'POST', '/mcp', JSON.stringify([
      { jsonrpc: '2.0', id: 'safe-id', method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 'blocked-id',
        method: 'resources/list',
        params: {},
      },
    ]), { authorization: 'Bearer test-key', 'content-type': 'application/json' });

    expect(response.status).toBe(403);
    const payload = JSON.parse(response.body);
    expect(payload).toMatchObject({ id: null, error: { code: -32003 } });
    expect(payload.error.message).toContain('整个批次');
    expect(response.body.length).toBeLessThan(1_024);
    expect(targetHits).toBe(0);
  });

  test('caps batch size and prevents unauthenticated response amplification', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end('unexpected');
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const oversizedBatch = Array.from({ length: LAN_MCP_MAX_BATCH_ITEMS + 1 }, (_value, id) => ({
      jsonrpc: '2.0', id, method: 'tools/list', params: {},
    }));
    const capped = await call(status.port, 'POST', '/mcp', JSON.stringify(oversizedBatch), {
      authorization: 'Bearer invalid',
      'content-type': 'application/json',
    });
    expect(capped.status).toBe(403);
    expect(JSON.parse(capped.body)).toMatchObject({ id: null, error: { code: -32003 } });
    expect(capped.body.length).toBeLessThan(1_024);

    const amplifiedInput = JSON.stringify([
      ...Array.from({ length: 20_000 }, () => null),
      {
        jsonrpc: '2.0', id: 'blocked', method: 'tools/call',
        params: { name: 'query', arguments: { query: 'secret' } },
      },
    ]);
    const bounded = await call(status.port, 'POST', '/mcp', amplifiedInput, {
      authorization: 'Bearer invalid',
      'content-type': 'application/json',
    });
    expect(bounded.status).toBe(403);
    expect(bounded.body.length).toBeLessThan(1_024);
    expect(targetHits).toBe(0);
  });

  test('rejects malformed JSON, preserves BOM payloads, and enforces the body limit', async () => {
    let targetHits = 0;
    const target = createServer((req, res) => {
      targetHits += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nativeBody: Buffer.concat(chunks).toString('utf8') }));
      });
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const malformed = await call(status.port, 'POST', '/mcp', '{not-json', {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toMatchObject({
      id: null,
      error: { code: -32700 },
    });

    const bomBypass = await call(
      status.port,
      'POST',
      '/mcp',
      `\uFEFF${JSON.stringify({
        jsonrpc: '2.0',
        id: 'bom-query',
        method: 'tools/call',
        params: { name: 'query', arguments: { query: '机密', source_id: '__all__' } },
      })}`,
      { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    );
    expect(bomBypass.status).toBe(400);
    expect(JSON.parse(bomBypass.body).nativeBody).toBe(
      `\uFEFF${JSON.stringify({
        jsonrpc: '2.0',
        id: 'bom-query',
        method: 'tools/call',
        params: { name: 'query', arguments: { query: '机密', source_id: '__all__' } },
      })}`,
    );

    const largeAllowedBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 'large-page',
      method: 'tools/call',
      params: { name: 'put_page', arguments: { slug: 'large', content: 'x'.repeat(1024 * 1024) } },
    });
    const accepted = await call(status.port, 'POST', '/mcp', largeAllowedBody, {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
    expect(accepted.status).toBe(400);
    expect(JSON.parse(accepted.body).nativeBody).toBe(largeAllowedBody);

    const oversized = await call(
      status.port,
      'POST',
      '/mcp',
      'x'.repeat(LAN_MCP_MAX_BODY_BYTES + 1),
      { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    );
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body).error).toContain('过大');
    expect(targetHits).toBe(2);
  });

  test('rejects missing or malformed Bearer headers before reading or proxying the body', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end('unexpected');
    });
    const targetPort = await listen(target);
    const gateway = createGateway({ bindAddress: '127.0.0.1', sidecarPort: targetPort, listenPort: 0 });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const response = await call(status.port, 'POST', '/mcp', '{}', { 'content-type': 'application/json' });
    expect(response.status).toBe(401);
    const malformed = await call(status.port, 'GET', '/mcp', '', { authorization: 'Basic invalid' });
    expect(malformed.status).toBe(401);
    expect(targetHits).toBe(0);
  });

  test('verifies the Bearer token before reading an unfinished request body', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });
    const targetPort = await listen(target);
    const gateway = new LanMcpGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
      verifyBearerToken: async authorizationHeader => authorizationHeader === 'Bearer valid',
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const invalidStatus = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let responseText = '';
      const socket = createConnection({ host: '127.0.0.1', port: status.port }, () => {
        socket.write([
          'POST /mcp HTTP/1.1',
          `Host: 127.0.0.1:${status.port}`,
          'Authorization: Bearer invalid',
          'Content-Type: application/json',
          'Content-Length: 100',
          '',
          '{"jsonrpc":"2.0"',
        ].join('\r\n'));
      });
      const timeout = setTimeout(() => finish(new Error('Gateway waited for an unauthenticated body.')), 1_000);
      function finish(error?: Error, code?: number) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(code ?? 0);
        }
      }
      socket.on('data', chunk => {
        responseText += chunk.toString('utf8');
        const statusMatch = responseText.match(/^HTTP\/1\.1\s+(\d{3})/);
        if (statusMatch) finish(undefined, Number(statusMatch[1]));
      });
      socket.on('error', error => finish(error));
    });
    expect(invalidStatus).toBe(401);
    expect(targetHits).toBe(0);

    const valid = await call(status.port, 'POST', '/mcp', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'ping', params: {},
    }), { authorization: 'Bearer valid', 'content-type': 'application/json' });
    expect(valid.status).toBe(200);
    expect(targetHits).toBe(1);
  });

  test('allows only audited MCP methods and GET health checks', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end('unexpected');
    });
    const targetPort = await listen(target);
    const gateway = createGateway({ bindAddress: '127.0.0.1', sidecarPort: targetPort, listenPort: 0 });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    const method = await call(status.port, 'POST', '/mcp', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'resources/list', params: {},
    }), { authorization: 'Bearer invalid', 'content-type': 'application/json' });
    expect(method.status).toBe(403);
    expect(JSON.parse(method.body)).toMatchObject({ id: 1, error: { code: -32003 } });
    expect((await call(status.port, 'POST', '/health')).status).toBe(405);
    expect(targetHits).toBe(0);
  });

  test('proxies GET, POST and DELETE while preserving MCP credentials and session headers', async () => {
    const target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'mcp-session-id': req.headers['mcp-session-id'] ?? '',
          connection: 'close',
        });
        res.end(JSON.stringify({
          method: req.method,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          sessionId: req.headers['mcp-session-id'],
          custom: req.headers['x-pmbrain-test'],
          forwarded: req.headers.forwarded,
          realIp: req.headers['x-real-ip'],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await call(
        status.port,
        method,
        '/mcp?transport=test',
        method === 'POST' ? '{"query":"中文"}' : '',
        {
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
          'mcp-session-id': 'session-123',
          'x-pmbrain-test': 'kept',
          forwarded: 'for=203.0.113.10',
          'x-real-ip': '203.0.113.10',
        },
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        method,
        authorization: 'Bearer test-key',
        contentType: 'application/json',
        sessionId: 'session-123',
        custom: 'kept',
        forwarded: undefined,
        realIp: undefined,
        body: method === 'POST' ? '{"query":"中文"}' : '',
      });
      expect(response.headers['mcp-session-id']).toBe('session-123');
      expect(response.headers.connection).not.toBe('close');
    }
  });

  test('streams target chunks without buffering the full MCP response', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 80);
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const req = request(
        `http://127.0.0.1:${status.port}/mcp`,
        { headers: { authorization: 'Bearer streaming-test-key' } },
        (res) => {
        const chunks: string[] = [];
        res.on('data', (chunk) => {
          chunks.push(String(chunk));
          if (chunks.length === 1) {
            expect(chunks[0]).toBe('data: first\n\n');
            expect(Date.now() - startedAt).toBeLessThan(70);
          }
        });
        res.on('end', () => {
          expect(chunks.join('')).toBe('data: first\n\ndata: second\n\n');
          resolve();
        });
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  test('does not expose admin or arbitrary sidecar paths', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end('unexpected');
    });
    const targetPort = await listen(target);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: targetPort,
      listenPort: 0,
    });
    cleanup.push(() => gateway.stop());
    const status = await gateway.start();

    expect((await call(status.port, 'GET', '/admin')).status).toBe(404);
    expect((await call(status.port, 'GET', '/oauth/authorize')).status).toBe(404);
    expect(targetHits).toBe(0);
  });

  test('reports an actionable error when the selected address and port cannot be bound', async () => {
    const occupied = createServer();
    const occupiedPort = await listen(occupied);
    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: occupiedPort,
      listenPort: occupiedPort,
    });

    await expect(gateway.start()).rejects.toThrow(`127.0.0.1:${occupiedPort}`);
    expect(gateway.getStatus().running).toBe(false);
  });

  test('cancels a pending listen without leaving an orphan server', async () => {
    const reserved = createServer();
    const listenPort = await listen(reserved);
    const release = cleanup.pop();
    await release?.();

    const gateway = createGateway({
      bindAddress: '127.0.0.1',
      sidecarPort: 6553,
      listenPort,
    });
    const starting = gateway.start();
    await gateway.stop();
    await expect(starting).rejects.toThrow('取消');

    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(listenPort, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });
});
