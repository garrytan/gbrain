/**
 * Thin client against a status-only `foresights serve --http` host.
 *
 * Protects: OAuth discovery and /token answering 503 with a
 * `serve_status_only` envelope reach the agent as that code with the host's
 * fix and wait, instead of a generic discovery or token failure. Cold
 * credentials hit discovery; credentials that must be re-minted (the cached
 * token lapsed) hit /token after discovery succeeds. A plain 503 without the
 * envelope keeps the existing `http` classification.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { discoverOAuth, mintClientCredentialsToken } from '../src/core/remote-mcp-probe.ts';
import { callRemoteTool, RemoteMcpError, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { httpStatusEnvelope } from '../src/mcp/status-mode.ts';
import type { GBrainConfig } from '../src/core/config.ts';

type Mode = 'status_discovery' | 'status_token' | 'plain_503';
let mode: Mode = 'status_discovery';
let server: ReturnType<typeof Bun.serve>;
let base = '';
const statusResponse = () => Response.json(httpStatusEnvelope(), { status: 503, headers: { 'Retry-After': '5' } });

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    const path = new URL(req.url).pathname;
    if (mode === 'plain_503') return new Response('upstream down', { status: 503 });
    if (path === '/.well-known/oauth-authorization-server') {
      return mode === 'status_discovery' ? statusResponse() : Response.json({ issuer: base, token_endpoint: `${base}/token` });
    }
    return statusResponse();
  } });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _clearMcpClientTokenCache());

const config = (): GBrainConfig => ({
  engine: 'postgres',
  remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: 'thin-client', oauth_client_secret: ['runtime', 'secret', String(Date.now())].join('-') },
} as GBrainConfig);

async function remoteError(): Promise<RemoteMcpError> {
  try {
    await callRemoteTool(config(), 'search', { query: 'x' }, { timeoutMs: 5_000 });
  } catch (e) {
    if (e instanceof RemoteMcpError) return e;
    throw e;
  }
  throw new Error('expected a RemoteMcpError');
}

describe('remote-mcp-probe: status-only 503 envelopes', () => {
  test('discovery returns the envelope, its Retry-After and a status-only message', async () => {
    mode = 'status_discovery';
    const r = await discoverOAuth(base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).toMatchObject({ reason: 'http', status: 503, retry_after_s: 5 });
    expect(r.status_only).toMatchObject({ code: 'serve_status_only', reason: 'unavailable' });
    expect(r.message).toContain('status-only mode');
  });

  test('/token returns the envelope', async () => {
    mode = 'status_token';
    const r = await mintClientCredentialsToken(`${base}/token`, 'thin-client', ['runtime', 'secret'].join('-'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status_only).toMatchObject({ code: 'serve_status_only' });
  });

  test('a plain 503 keeps the http classification without an envelope', async () => {
    mode = 'plain_503';
    const r = await discoverOAuth(base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).toMatchObject({ reason: 'http', status: 503 });
    expect(r.status_only).toBeUndefined();
  });
});

describe('mcp-client: a status-only host reaches the agent as serve_status_only', () => {
  test('cold credentials: discovery fails with the host-admin fix', async () => {
    mode = 'status_discovery';
    const e = await remoteError();
    expect(e.reason).toBe('discovery');
    expect(e.detail).toMatchObject({ code: 'serve_status_only', reason: 'unavailable', retry_after_s: 5 });
    expect(e.toJSON()).toMatchObject({ code: 'serve_status_only', fix: { argv: ['gbrain', 'doctor', '--json'], actor: 'host_admin' } });
  });

  test('re-minted credentials: /token fails after discovery with the same envelope', async () => {
    mode = 'status_token';
    const e = await remoteError();
    expect(e.reason).toBe('token');
    expect(e.detail).toMatchObject({ code: 'serve_status_only', reason: 'unavailable' });
    expect(e.toJSON().code).toBe('serve_status_only');
  });
});
