/**
 * Real MCP servers for agent-contract surface tests (Lane H3): the production
 * `gbrain serve --http` app (`buildServeHttpApp`) and the legacy bearer
 * transport (`startHttpTransport`), each listening on an ephemeral loopback
 * port over a caller-owned engine, plus the raw JSON-RPC and thin-client
 * plumbing to talk to them.
 *
 * `withOpHandler` swaps one registered operation's handler for the duration
 * of a callback. Tests use it ONLY to put an error family on the wire that no
 * real op throws on a keyless brain; the servers, dispatch, envelope
 * serialization and client parsing stay production code.
 */
import type { Server } from 'node:http';
import express from 'express';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { Operation } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { buildServeHttpApp } from '../../src/commands/serve-http.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';

export interface ToolResultWire {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface LiveServeHttp {
  base: string;
  mcpUrl: string;
  bootstrap: string;
  close(): Promise<void>;
}

/** The production serve-http app on 127.0.0.1:<ephemeral>. */
export async function startServeHttp(engine: BrainEngine, opts: { surface?: 'verbs' | 'starter' | 'full' } = {}): Promise<LiveServeHttp> {
  const app = express();
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const built = await buildServeHttpApp(app, engine, {
    port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base, surface: opts.surface,
  });
  return {
    base,
    mcpUrl: `${base}/mcp`,
    bootstrap: built.bootstrapToken,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export interface LiveLegacyHttp {
  base: string;
  close(): void;
}

/** The legacy bearer transport (`src/mcp/http-transport.ts`) on an ephemeral port. */
export async function startLegacyHttp(engine: BrainEngine): Promise<LiveLegacyHttp> {
  const limiter = () => new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 });
  const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: { ip: limiter(), token: limiter() } });
  return { base: `http://127.0.0.1:${server.port}`, close: () => { server.stop?.(true); } };
}

let tokenSeq = 0;
/** A legacy bearer token (accepted by both HTTP servers). */
export async function legacyToken(engine: BrainEngine, scopes: string[]): Promise<string> {
  return (await mintLegacyToken(engine, { name: `h3-token-${++tokenSeq}`, takesHolders: ['world'], scopes })).token;
}

/** Owner session cookie from the bootstrap token. */
export async function ownerCookie(app: LiveServeHttp): Promise<string> {
  const login = await fetch(`${app.base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.bootstrap }),
  });
  if (login.status !== 200) throw new Error(`owner login failed: ${login.status}`);
  return login.headers.get('set-cookie')!.split(';')[0]!;
}

let clientSeq = 0;
/** A client_credentials OAuth client registered through the admin API. */
export async function registerOAuthClient(app: LiveServeHttp, cookie: string, scopes: string): Promise<{ clientId: string; clientSecret: string }> {
  const res = await fetch(`${app.base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `h3-client-${++clientSeq}`, grantTypes: ['client_credentials'], scopes }),
  });
  if (res.status !== 200) throw new Error(`register-client failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { clientId: string; clientSecret?: string };
  if (!body.clientSecret) throw new Error('register-client returned no secret');
  return { clientId: body.clientId, clientSecret: body.clientSecret };
}

export async function clientCredentialsToken(app: LiveServeHttp, clientId: string, secret: string, scope: string): Promise<string> {
  const res = await fetch(`${app.base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }),
  });
  if (res.status !== 200) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { access_token: string }).access_token;
}

/** The thin client's config for a registered client (callRemoteTool input). */
export function thinClientConfig(app: LiveServeHttp, client: { clientId: string; clientSecret: string }): GBrainConfig {
  return {
    engine: 'postgres',
    remote_mcp: { issuer_url: app.base, mcp_url: app.mcpUrl, oauth_client_id: client.clientId, oauth_client_secret: client.clientSecret },
  } as GBrainConfig;
}

/** One JSON-RPC POST to /mcp; returns the parsed response (SSE `data:` line or plain JSON). */
export async function rpc(base: string, token: string, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  const data = text.split('\n').find(l => l.startsWith('data:'));
  let body: unknown = text;
  try { body = JSON.parse(data ? data.slice('data:'.length) : text); } catch { /* non-JSON body stays text */ }
  return { status: res.status, body };
}

/** tools/call over raw JSON-RPC; returns the MCP tool result. */
export async function callTool(base: string, token: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<ToolResultWire> {
  const r = await rpc(base, token, 'tools/call', { name, arguments: args }, headers);
  if (r.status !== 200 || !r.body?.result) throw new Error(`tools/call ${name} → HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body.result as ToolResultWire;
}

export function opNamed(name: string): Operation {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`no op ${name}`);
  return op;
}

/** Swap one op's handler for the callback's duration (restored even when it throws). */
export async function withOpHandler<T>(name: string, handler: Operation['handler'], fn: () => Promise<T>): Promise<T> {
  const op = opNamed(name) as { handler: Operation['handler'] };
  const original = op.handler;
  op.handler = handler;
  try {
    return await fn();
  } finally {
    op.handler = original;
  }
}

/** The single parsed envelope of an isError result (asserts exactly one block). */
export function envelopeOf(result: ToolResultWire): Record<string, any> {
  if (!result.isError) throw new Error(`expected an error result, got ${JSON.stringify(result).slice(0, 300)}`);
  if (result.content.length !== 1) throw new Error(`error result has ${result.content.length} content blocks`);
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}
