/**
 * Tests for src/core/mcp-client.ts.
 *
 * Strategy: spin up an in-process HTTP server that mimics gbrain serve --http
 * (OAuth discovery + /token + /mcp). Test callRemoteTool against it,
 * including the OAuth token cache, the 401 → refresh-once retry, and the
 * RemoteMcpError shape.
 *
 * The /mcp fixture implements just enough JSON-RPC to satisfy
 * StreamableHTTPClientTransport's connect handshake (initialize + initialized
 * notification) plus tools/call. NOT a full MCP server — only the surface
 * area a client_credentials thin-client uses.
 *
 * Async Bun.spawn-friendly: the test event loop stays responsive during
 * fetch round-trips because callRemoteTool awaits async work properly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  callRemoteTool,
  unpackToolResult,
  RemoteMcpError,
  _clearMcpClientTokenCache,
} from '../src/core/mcp-client.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { discoverOAuth, mintClientCredentialsToken } from '../src/core/remote-mcp-probe.ts';
import { withEnv } from './helpers/with-env.ts';

let server: ReturnType<typeof Bun.serve>;
let port: number;

// Per-test response control
let tokenStatus = 200;
let mcpResponseFor: (req: { method: string; params?: unknown }) => unknown = () => ({});
let tokenMintCount = 0;
type Stage = 'discovery' | 'token' | 'initialize' | 'notifications/initialized' | 'tools/call';
let requests: Partial<Record<Stage, number>> = {};
let statusFor: (stage: Stage, attempt: number) => number | undefined = () => undefined;
let hangingStage: Stage | undefined;
let hangFromAttempt = 1;
let hangAfterHeaders = false;
let onHang: (() => void) | undefined;
let onHangClosed: (() => void) | undefined;
let toolExecutions = 0;
let initializeTokens: string[] = [];

function intercept(stage: Stage, req: Request): Response | Promise<Response> | undefined {
  requests[stage] = (requests[stage] ?? 0) + 1;
  if (stage === hangingStage && requests[stage]! >= hangFromAttempt) {
    const closed = onHangClosed;
    onHang?.();
    if (hangAfterHeaders) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
        cancel() { closed?.(); },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise<Response>(resolve => {
      req.signal.addEventListener('abort', () => {
        closed?.();
        resolve(new Response(null, { status: 499 }));
      }, { once: true });
    });
  }
  const status = statusFor(stage, requests[stage]!);
  if (status !== undefined) return new Response('fixture rejection', { status });
}

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/.well-known/oauth-authorization-server') {
        const intercepted = intercept('discovery', req);
        if (intercepted) return intercepted;
        return Response.json({ token_endpoint: `http://127.0.0.1:${port}/token`, issuer: `http://127.0.0.1:${port}` });
      }
      if (path === '/token') {
        tokenMintCount++;
        const intercepted = intercept('token', req);
        if (intercepted) return intercepted;
        return Response.json(tokenStatus === 200 ? {
          access_token: `token-${Date.now()}-${tokenMintCount}`,
          token_type: 'bearer', expires_in: 3600, scope: 'read write admin',
        } : { error: 'invalid_client' }, { status: tokenStatus });
      }
      if (path === '/mcp' && req.method === 'POST') {
        const body = await req.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (body.method === 'initialize') initializeTokens.push(req.headers.get('authorization') ?? '');
        const intercepted = intercept(body.method as Stage, req);
        if (intercepted) return intercepted;
        if (body.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        if (body.method === 'initialize') {
          result = {
            protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mcp-client-test-fixture', version: '1' },
          };
        } else if (body.method === 'tools/call') {
          toolExecutions++;
          result = mcpResponseFor({ method: body.method, params: body.params });
        } else {
          result = {};
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
      }
      return new Response(null, { status: path === '/mcp' ? 405 : 404 });
    },
  });
  port = server.port!;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  tokenStatus = 200;
  tokenMintCount = 0;
  requests = {};
  statusFor = () => undefined;
  hangingStage = undefined;
  hangFromAttempt = 1;
  hangAfterHeaders = false;
  onHang = undefined;
  onHangClosed = undefined;
  toolExecutions = 0;
  initializeTokens = [];
  mcpResponseFor = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
  _clearMcpClientTokenCache();
});

function makeConfig(): GBrainConfig {
  return {
    engine: 'postgres',
    remote_mcp: {
      issuer_url: `http://127.0.0.1:${port}`,
      mcp_url: `http://127.0.0.1:${port}/mcp`,
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
  };
}

describe('callRemoteTool — happy path', () => {
  test('returns the tool response for a simple call', async () => {
    mcpResponseFor = () => ({ content: [{ type: 'text', text: JSON.stringify({ greeting: 'hello' }) }] });
    const res = await callRemoteTool(makeConfig(), 'echo', {});
    const parsed = unpackToolResult<{ greeting: string }>(res);
    expect(parsed.greeting).toBe('hello');
  });

  test('caches the access token across multiple calls', async () => {
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1);
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1); // still 1 — cache was reused
    await callRemoteTool(makeConfig(), 'noop', {});
    expect(tokenMintCount).toBe(1);
  });

  test('passes args through to the tool handler', async () => {
    let captured: unknown = null;
    mcpResponseFor = ({ params }) => {
      captured = params;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };
    await callRemoteTool(makeConfig(), 'with_args', { foo: 'bar', n: 42 });
    expect(captured).toEqual({ name: 'with_args', arguments: { foo: 'bar', n: 42 } });
  });
});

describe('callRemoteTool — HTTP authentication boundaries', () => {
  for (const stage of ['initialize', 'tools/call'] as const) {
    test(`${stage}: one HTTP 401 refreshes once and executes the tool once`, async () => {
      statusFor = (current, attempt) => current === stage && attempt === 1 ? 401 : undefined;
      const result = await callRemoteTool(makeConfig(), 'write_example', { value: 1 });
      expect(unpackToolResult<{ ok: boolean }>(result)).toEqual({ ok: true });
      expect(tokenMintCount).toBe(2);
      expect(requests[stage]).toBe(2);
      expect(initializeTokens).toHaveLength(2);
      expect(initializeTokens[0]).not.toBe(initializeTokens[1]);
      expect(toolExecutions).toBe(1);
    });

    test(`${stage}: repeated HTTP 401 stops after one refresh`, async () => {
      statusFor = current => current === stage ? 401 : undefined;
      await expect(callRemoteTool(makeConfig(), 'write_example')).rejects.toMatchObject({
        reason: 'auth_after_refresh', detail: { status: 401 },
      });
      expect(tokenMintCount).toBe(2);
      expect(requests[stage]).toBe(2);
      expect(toolExecutions).toBe(0);
    });

    for (const status of [403, 500, 503]) {
      test(`${stage}: HTTP ${status} is terminal and preserves status`, async () => {
        statusFor = current => current === stage ? status : undefined;
        await expect(callRemoteTool(makeConfig(), 'write_example')).rejects.toMatchObject({
          reason: 'network', detail: { status },
        });
        expect(tokenMintCount).toBe(1);
        expect(requests[stage]).toBe(1);
        expect(toolExecutions).toBe(0);
      });
    }
  }

  for (const text of ['client abc401def may not write', 'unauthorized operation', 'invalid_token is a field name']) {
    test(`application error is never retried: ${text}`, async () => {
      mcpResponseFor = () => ({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', message: text }) }],
      });
      await expect(callRemoteTool(makeConfig(), 'write_example')).rejects.toMatchObject({
        reason: 'tool_error', detail: { code: 'permission_denied' },
      });
      expect(tokenMintCount).toBe(1);
      expect(toolExecutions).toBe(1);
    });
  }

  test('application error after a genuine refresh remains a tool error', async () => {
    statusFor = (stage, attempt) => stage === 'tools/call' && attempt === 1 ? 401 : undefined;
    mcpResponseFor = () => ({ isError: true, content: [{ type: 'text', text: 'unauthorized 401 operation' }] });
    await expect(callRemoteTool(makeConfig(), 'write_example')).rejects.toMatchObject({ reason: 'tool_error' });
    expect(tokenMintCount).toBe(2);
    expect(toolExecutions).toBe(1);
  });

  test('rejected token refresh stops before a second tool request', async () => {
    statusFor = (stage, attempt) => stage === 'tools/call' ? 401 : stage === 'token' && attempt === 2 ? 401 : undefined;
    await expect(callRemoteTool(makeConfig(), 'write_example')).rejects.toMatchObject({ reason: 'auth_after_refresh', detail: { status: 401 } });
    expect(tokenMintCount).toBe(2);
    expect(requests['tools/call']).toBe(1);
    expect(toolExecutions).toBe(0);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('callRemoteTool — cancellation across every network stage', () => {
  test('the original call deadline also bounds token refresh', async () => {
    statusFor = stage => stage === 'tools/call' ? 401 : undefined;
    hangingStage = 'token';
    hangFromAttempt = 2;
    const closed = deferred();
    onHangClosed = closed.resolve;
    await expect(callRemoteTool(makeConfig(), 'write_example', {}, { timeoutMs: 200 })).rejects.toMatchObject({
      reason: 'network', detail: { kind: 'timeout' },
    });
    await bounded(closed.promise);
    expect(tokenMintCount).toBe(2);
    expect(requests['tools/call']).toBe(1);
    expect(toolExecutions).toBe(0);
  });

  for (const stage of ['discovery', 'token', 'initialize', 'notifications/initialized', 'tools/call'] as const) {
    for (const cancel of ['timeout', 'external'] as const) {
      test(`${cancel} closes a hanging ${stage} request`, async () => {
        hangingStage = stage;
        const started = deferred();
        const closed = deferred();
        onHang = started.resolve;
        onHangClosed = closed.resolve;
        const controller = new AbortController();
        const pending = callRemoteTool(makeConfig(), 'write_example', {}, {
          ...(cancel === 'timeout' ? { timeoutMs: 200 } : { signal: controller.signal }),
        });
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        await bounded(started.promise);
        if (cancel === 'external') controller.abort(new Error('caller stopped'));
        expect(await bounded(outcome)).toMatchObject({
          error: { reason: 'network', detail: { kind: cancel === 'timeout' ? 'timeout' : 'aborted' } },
        });
        await bounded(closed.promise);
        expect(requests[stage]).toBe(1);
        expect(tokenMintCount).toBe(stage === 'discovery' ? 0 : 1);
        expect(toolExecutions).toBe(0);
      });
    }
  }

  for (const stage of ['discovery', 'token', 'initialize', 'tools/call'] as const) {
    test(`timeout closes a partial JSON response at ${stage}`, async () => {
      hangingStage = stage;
      hangAfterHeaders = true;
      const closed = deferred();
      onHangClosed = closed.resolve;
      await expect(callRemoteTool(makeConfig(), 'write_example', {}, { timeoutMs: 200 })).rejects.toMatchObject({
        reason: 'network', detail: { kind: 'timeout' },
      });
      await bounded(closed.promise);
      expect(requests[stage]).toBe(1);
      expect(toolExecutions).toBe(0);
    });
  }

  test('already-aborted calls never contact discovery or MCP', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(callRemoteTool(makeConfig(), 'write_example', {}, { signal: controller.signal })).rejects.toMatchObject({
      reason: 'network', detail: { kind: 'aborted' },
    });
    expect(requests).toEqual({});
    expect(tokenMintCount).toBe(0);
  });

  for (const stage of ['discovery', 'token'] as const) {
    test(`${stage} keeps its own timeout cap when no call-wide timeout is set`, async () => {
      hangingStage = stage;
      const closed = deferred();
      onHangClosed = closed.resolve;
      const base = `http://127.0.0.1:${port}`;
      const result = stage === 'discovery'
        ? await discoverOAuth(base, { timeoutMs: 30 })
        : await mintClientCredentialsToken(`${base}/token`, 'cid', 'csecret', { timeoutMs: 30 });
      expect(result).toMatchObject({ ok: false, reason: 'network', kind: 'timeout' });
      await bounded(closed.promise);
    });
  }
});

describe('callRemoteTool — error surfaces', () => {
  test('an unreachable MCP transport is terminal after one token mint', async () => {
    const config = makeConfig();
    config.remote_mcp!.mcp_url = 'http://127.0.0.1:1/mcp';
    await expect(callRemoteTool(config, 'write_example')).rejects.toMatchObject({
      reason: 'network', detail: { kind: 'unreachable' },
    });
    expect(tokenMintCount).toBe(1);
    expect(toolExecutions).toBe(0);
  });

  test('config has no remote_mcp → throws RemoteMcpError(config)', async () => {
    await expect(callRemoteTool({ engine: 'postgres' }, 'foo', {})).rejects.toThrow(RemoteMcpError);
  });

  test('client_secret missing → throws RemoteMcpError(config)', async () => {
    const config: GBrainConfig = {
      engine: 'postgres',
      remote_mcp: {
        issuer_url: `http://127.0.0.1:${port}`,
        mcp_url: `http://127.0.0.1:${port}/mcp`,
        oauth_client_id: 'cid',
      },
    };
    await withEnv({ GBRAIN_REMOTE_CLIENT_SECRET: undefined }, async () => {
      try {
        await callRemoteTool(config, 'foo', {});
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteMcpError);
        expect((e as RemoteMcpError).reason).toBe('config');
      }
    });
  });

  test('token mint fails with 401 → throws RemoteMcpError(auth)', async () => {
    tokenStatus = 401;
    try {
      await callRemoteTool(makeConfig(), 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('auth');
    }
  });

  test('discovery URL unreachable → throws RemoteMcpError(network)', async () => {
    const config: GBrainConfig = {
      engine: 'postgres',
      remote_mcp: {
        issuer_url: 'http://127.0.0.1:1', // typically refused
        mcp_url: 'http://127.0.0.1:1/mcp',
        oauth_client_id: 'cid',
        oauth_client_secret: 'csecret',
      },
    };
    try {
      await callRemoteTool(config, 'foo', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('network');
    }
  });

  test('tool returns isError → throws RemoteMcpError(tool_error)', async () => {
    mcpResponseFor = () => ({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
    try {
      await callRemoteTool(makeConfig(), 'fails', {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteMcpError);
      expect((e as RemoteMcpError).reason).toBe('tool_error');
    }
  });
});

describe('unpackToolResult', () => {
  test('extracts JSON from the first content text element', () => {
    const wire = { content: [{ type: 'text', text: JSON.stringify({ a: 1, b: 'two' }) }] };
    expect(unpackToolResult<{ a: number; b: string }>(wire)).toEqual({ a: 1, b: 'two' });
  });

  test('throws RemoteMcpError(parse) on non-JSON text', () => {
    const wire = { content: [{ type: 'text', text: 'not json' }] };
    expect(() => unpackToolResult(wire)).toThrow(RemoteMcpError);
  });

  test('throws RemoteMcpError(parse) on missing content array', () => {
    expect(() => unpackToolResult({})).toThrow(RemoteMcpError);
  });

  test('throws RemoteMcpError(parse) on wrong content type', () => {
    const wire = { content: [{ type: 'image', data: 'xxx' }] };
    expect(() => unpackToolResult(wire)).toThrow(RemoteMcpError);
  });
});
