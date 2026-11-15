/**
 * #8543: forwardRemoteToolCall, the stdio bridge's relay. It returns the
 * host's CallToolResult unchanged (refusals and pending receipts included),
 * gives a journaled mutation one request_id that survives the single 401
 * re-mint, never resends after any other failure, and says whether a failed
 * call may have reached the host.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { forwardRemoteToolCall, RemoteMcpError, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../src/version.ts';

let server: ReturnType<typeof Bun.serve>;
let port = 0;
let tokenMints = 0;
let tokenStatus = 200;
let callAttempts = 0;
let callStatus: (attempt: number) => number | undefined = () => undefined;
let answer: (params: any) => unknown = () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });
let calls: any[] = [];
let headers: Array<string | null> = [];

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ token_endpoint: `http://127.0.0.1:${port}/token`, issuer: `http://127.0.0.1:${port}` });
    if (path === '/token') {
      tokenMints++;
      return tokenStatus === 200 ? Response.json({ access_token: `t-${tokenMints}`, token_type: 'bearer', expires_in: 3600, scope: 'read write' })
        : Response.json({ error: 'server_error' }, { status: tokenStatus });
    }
    if (path === '/mcp' && req.method === 'POST') {
      const body = await req.json() as { id?: number; method: string; params?: any };
      headers.push(req.headers.get('x-gbrain-client'));
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'gbrain', version: '0.60.600.0' } } });
      }
      if (body.method === 'tools/call') {
        callAttempts++;
        calls.push(body.params);
        const status = callStatus(callAttempts);
        if (status !== undefined) return new Response('fixture', { status });
        return Response.json({ jsonrpc: '2.0', id: body.id, result: answer(body.params) });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
    }
    return new Response(null, { status: path === '/mcp' ? 405 : 404 });
  } });
  port = server.port!;
});

afterAll(async () => { await server.stop(true); });

beforeEach(() => {
  tokenMints = 0; tokenStatus = 200; callAttempts = 0; calls = []; headers = [];
  callStatus = () => undefined;
  answer = () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });
  _clearMcpClientTokenCache();
});

const cfg = (): GBrainConfig => ({ engine: 'postgres', remote_mcp: { issuer_url: `http://127.0.0.1:${port}`, mcp_url: `http://127.0.0.1:${port}/mcp`,
  oauth_client_id: 'cid', oauth_client_secret: 'csecret' } }) as GBrainConfig;

async function failure(p: Promise<unknown>): Promise<RemoteMcpError> {
  try { await p; } catch (e) { if (e instanceof RemoteMcpError) return e; throw e; }
  throw new Error('expected a RemoteMcpError');
}

describe('forwardRemoteToolCall', () => {
  test('returns the host\'s refusal and pending receipt unchanged instead of throwing', async () => {
    const refusal: CallToolResult = { isError: true, content: [{ type: 'text', text: '{"code":"insufficient_scope","fix":{"argv":["gbrain"]}}' }] };
    answer = () => refusal;
    expect(await forwardRemoteToolCall(cfg(), 'get_page', { slug: 'x' })).toEqual(refusal);
    const pending: CallToolResult = { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'unavailable', write_error: 'write_pending', write_request: { request_id: 'd7599b95-65c2-4d54-aa4e-cb5745af90cf', state: 'queued', retry_after_ms: 1000 } }) }] };
    answer = () => pending;
    expect(await forwardRemoteToolCall(cfg(), 'put_page', { slug: 'x', content: 'y' })).toEqual(pending);
  });

  test('one HTTP 401 re-mints once and resends the same request_id', async () => {
    callStatus = (n) => n === 1 ? 401 : undefined;
    const result = await forwardRemoteToolCall(cfg(), 'put_page', { slug: 'x', content: 'y' });
    expect(result.isError ?? false).toBe(false);
    expect(tokenMints).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].arguments.request_id).toBe(calls[0].arguments.request_id);
  });

  test('any other failure after the call was sent is never resent and keeps its identity as unknown', async () => {
    callStatus = () => 502;
    const e = await failure(forwardRemoteToolCall(cfg(), 'put_page', { slug: 'x', content: 'y' }));
    expect(calls).toHaveLength(1);
    expect(e.detail?.submission_status).toBe('unknown');
    expect(e.detail?.request_id).toBe(calls[0].arguments.request_id);
  });

  test('a failure before the call is sent says not_sent', async () => {
    tokenStatus = 500;
    const e = await failure(forwardRemoteToolCall(cfg(), 'put_page', { slug: 'x', content: 'y', request_id: 'c96cbb61-b862-4f8a-92bb-e79113f8ff19' }));
    expect(calls).toHaveLength(0);
    expect(e.detail?.submission_status).toBe('not_sent');
    expect(e.detail?.request_id).toBe('c96cbb61-b862-4f8a-92bb-e79113f8ff19');
  });

  test('reads and dry runs carry no injected request_id', async () => {
    await forwardRemoteToolCall(cfg(), 'get_page', { slug: 'x' });
    await forwardRemoteToolCall(cfg(), 'put_page', { slug: 'x', content: 'y', dry_run: true });
    expect(calls.map(c => c.arguments.request_id)).toEqual([undefined, undefined]);
  });

  test('_meta reaches the host unchanged', async () => {
    const meta = { on_behalf_of: ['alice-example'], session_id: 's-1', hot_memory: false };
    await forwardRemoteToolCall(cfg(), 'query', { query: 'x' }, { meta });
    expect(calls[0]._meta).toEqual(meta);
  });

  test('the client name is the caller\'s, and the default stays the thin CLI\'s', async () => {
    await forwardRemoteToolCall(cfg(), 'get_page', { slug: 'x' }, { clientName: 'gbrain-stdio-bridge' });
    expect(new Set(headers)).toEqual(new Set([`gbrain-stdio-bridge/${VERSION}`]));
    headers = [];
    await forwardRemoteToolCall(cfg(), 'get_page', { slug: 'x' });
    expect(new Set(headers)).toEqual(new Set([`gbrain-remote-cli/${VERSION}`]));
  });

  test('admit sees the host\'s serverInfo and a refusal is returned without sending the call', async () => {
    const refused: CallToolResult = { isError: true, content: [{ type: 'text', text: '{"code":"host_upgrade_required"}' }] };
    let seen: unknown;
    const result = await forwardRemoteToolCall(cfg(), 'query', { query: 'x' }, { admit: (host) => { seen = host; return refused; } });
    expect(result).toEqual(refused);
    expect(seen).toMatchObject({ name: 'gbrain', version: '0.60.600.0' });
    expect(calls).toHaveLength(0);
  });
});
