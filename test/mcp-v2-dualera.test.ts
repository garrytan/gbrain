/**
 * Dual-era MCP protocol tests (SDK v2, 2026-07-28).
 *
 * Verifies the observable era contracts the migration to
 * `createMcpHandler` / `serveStdio` depends on:
 *
 *   - modern requests (carrying a `_meta` protocol-version envelope) are
 *     served the 2026-07-28 stateless path (`server/discover`,
 *     `supportedVersions` lists the modern revision, no `initialize`
 *     required for `tools/list`);
 *   - 2025-era `initialize` traffic (which the v1 thin-client emits — and
 *     whose post-handshake `MCP-Protocol-Version` header is NOT an era
 *     signal) still resolves through the `legacy: 'stateless'` fallback /
 *     `legacy: 'serve'` stdio path.
 *
 * No engine, no DB: the factory registers `tools/list` (via buildToolDefs)
 * and a no-op `tools/call`, mirroring the real wiring in serve-http.ts and
 * server.ts.
 */

import { describe, expect, it } from 'bun:test';
import { createMcpHandler, Server, type ListToolsResult, type McpServerFactory, type Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start >= timeoutMs) throw new Error('timed out waiting for stdio reply');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MODERN_VERSION = '2026-07-28';
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** Build the same factory shape gbrain uses: tools/list via buildToolDefs. */
function makeFactory(tools = buildToolDefs([{
  name: 'whoami',
  description: 'who am i',
  params: {},
  handler: async () => ({}),
}])): McpServerFactory {
  return () => {
    const server = new Server(
      { name: 'gbrain', version: '0.0.0-test' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({ tools }) as ListToolsResult);
    server.setRequestHandler('tools/call', async (request) => {
      const { name } = request.params;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name }) }],
      };
    });
    return server;
  };
}

describe('HTTP dual-era (createMcpHandler)', () => {
  const handler = createMcpHandler(makeFactory(), { legacy: 'stateless' });

  const post = (method: string, body: unknown, extra: Record<string, string> = {}) =>
    handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extra,
      },
      body: JSON.stringify(body),
    }));

  it('serves server/discover on the modern (2026-07-28) path — no initialize needed', async () => {
    const res = await post('server/discover', {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: MODERN_META },
    }, { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'server/discover' });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    const result = json.result;
    // supportedVersions lists the modern revisions the server serves.
    expect(result.supportedVersions).toContain(MODERN_VERSION);
    expect(result.capabilities.tools).toBeDefined();
  });

  it('HTTP connector rejects modern discover without MCP-Protocol-Version (header is transport metadata, not the era switch)', async () => {
    const res = await post('server/discover', {
      jsonrpc: '2.0',
      id: 11,
      method: 'server/discover',
      params: { _meta: MODERN_META },
    });
    expect(res.status).toBe(400);
  });

  it('a 2025 MCP-Protocol-Version header on initialize still serves the 2025-era handshake', async () => {
    const res = await post('initialize', {
      jsonrpc: '2.0',
      id: 12,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'thin-client', version: '0.test' },
      },
    }, { 'mcp-protocol-version': '2025-11-25' });

    expect(res.status).toBe(200);
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const json = JSON.parse(dataLine!.slice(5).trim());
    expect(json.result.protocolVersion).toMatch(/^2025-/);
  });

  it('serves initialize on the 2025-era path with a 2025-era protocolVersion', async () => {
    // v1 thin-client initialize: NO modern _meta envelope, MAY carry a
    // 2025 MCP-Protocol-Version header (post-handshake that header is
    // 2025-11-25 — header presence is NOT an era signal).
    const res = await post('initialize', {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'thin-client', version: '0.test' },
      },
    });

    expect(res.status).toBe(200);
    // The stateless legacy fallback serves initialize via an SSE stream.
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const json = JSON.parse(dataLine!.slice(5).trim());
    const result = json.result;
    // Legacy handshake answers a 2025-era revision, NOT 2026-07-28.
    expect(result.protocolVersion).toMatch(/^2025-/);
    expect(result.capabilities.tools).toBeDefined();
  });

  it('answers tools/list on the modern path with the envelope present', async () => {
    const res = await post('tools/list', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { _meta: MODERN_META },
    }, { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.result.tools)).toBe(true);
    expect(json.result.tools.map((t: { name: string }) => t.name)).toContain('whoami');
  });
});

describe('stdio dual-era (serveStdio)', () => {
  /** Minimal in-memory Transport that records outbound and feeds inbound. */
  function makeMemoryTransport() {
    const sent: unknown[] = [];
    let onmessage: Transport['onmessage'];
    let onclose: (() => void) | undefined;
    let onerror: ((e: Error) => void) | undefined;
    return {
      sent,
      _t: {
        async start() {},
        async send(message: unknown) { sent.push(message); },
        async close() { onclose?.(); },
        set onmessage(fn: Transport['onmessage']) { onmessage = fn; },
        get onmessage() { return onmessage; },
        set onclose(fn: (() => void) | undefined) { onclose = fn; },
        get onclose() { return onclose; },
        set onerror(fn: ((e: Error) => void) | undefined) { onerror = fn; },
        get onerror() { return onerror; },
        deliver(msg: unknown) { onmessage?.(msg as never); },
        throwError(e: Error) { onerror?.(e); },
      } as Transport & { deliver: (m: unknown) => void; throwError: (e: Error) => void },
    };
  }

  it('answers server/discover with a modern DiscoverResult on the stdio path', async () => {
    const mem = makeMemoryTransport();
    const handle = serveStdio(makeFactory(), { legacy: 'serve', transport: mem._t });

    mem._t.deliver({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: MODERN_META },
    });

    await waitUntil(() => mem.sent.length > 0);
    const reply = mem.sent[0] as { id?: unknown; result?: { supportedVersions?: string[]; capabilities?: { tools?: unknown } } };
    expect(reply.id).toBe(1);
    expect(reply.result?.supportedVersions).toContain(MODERN_VERSION);
    expect(reply.result?.capabilities?.tools).toBeDefined();

    await handle.close();
  });

  it('serves a 2025-era initialize over stdio with a 2025-era protocolVersion', async () => {
    const mem = makeMemoryTransport();
    const handle = serveStdio(makeFactory(), { legacy: 'serve', transport: mem._t });

    mem._t.deliver({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '0.test' },
      },
    });

    await waitUntil(() => mem.sent.length > 0);
    const reply = mem.sent[0] as { result?: { protocolVersion?: string } };
    expect(reply.result?.protocolVersion).toMatch(/^2025-/);

    await handle.close();
  });
});
