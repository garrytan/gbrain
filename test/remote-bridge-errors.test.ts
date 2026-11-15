/**
 * #8543: the stdio bridge's failure envelopes, driven in-process over an
 * in-memory MCP pair with the remote list/forward calls injected. Every
 * transport failure becomes the v1 agent envelope with a fix that never
 * widens the client, every line and envelope is free of URL secrets, and an
 * unexpected fault leaves the bridge serving.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RemoteMcpError, type ForwardRemoteToolOptions, type RemoteToolDefs } from '../src/core/mcp-client.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { startRemoteStdioBridge, type RemoteBridgeOptions } from '../src/mcp/remote-bridge.ts';
import { withEnv } from './helpers/with-env.ts';

const USERINFO = ['user', 's3cret'].join(':');
const SECRET_URL = `https://${USERINFO}@host.example/mcp?token=abc123#frag`;
const cfg = { engine: 'postgres', remote_mcp: { issuer_url: `https://${USERINFO}@host.example`, mcp_url: SECRET_URL,
  oauth_client_id: 'gbrain_cl_example', oauth_client_secret: 'client-secret-example' } } as unknown as GBrainConfig;
const HOST = { name: 'gbrain', version: '9.0.0.0' };
const TOOLS: RemoteToolDefs = { server: HOST, tools: ['get_page', 'put_page', 'query', 'whoami', 'request_tools', 'submit_job'].map(name => ({ name, inputSchema: { type: 'object' as const } })) };
const homes: string[] = [];

afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

type Forward = (c: GBrainConfig, name: string, args: Record<string, unknown>, o: ForwardRemoteToolOptions & { meta?: Record<string, unknown> }) => Promise<CallToolResult>;

async function startBridge(over: { forward?: Forward; list?: () => Promise<RemoteToolDefs>; transport?: RemoteBridgeOptions['transport']; advertise?: RemoteBridgeOptions['advertise'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bridge-unit-'));
  homes.push(home);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const logs: string[] = [];
  const exits: number[] = [];
  const stdin = Object.assign(new EventEmitter(), { isTTY: true });
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SURFACE: undefined }, () => startRemoteStdioBridge(cfg, {
    installFatalHandlers: false, mcpStdio: false, eofDrainMs: 0, ...(over.advertise ? { advertise: over.advertise } : {}),
    transport: over.transport ?? (() => serverSide),
    lifecycle: { stdin: stdin as never, signals: new EventEmitter() as never, log: (m: string) => { logs.push(m); }, exit: (c?: number) => { exits.push(c ?? 0); },
      getParentPid: () => 1, probeWatchdog: () => false },
    list: (async () => (over.list ? over.list() : TOOLS)) as never,
    forward: (over.forward ?? (async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }))) as never,
  }));
  const client = new Client({ name: 'bridge-unit', version: '1' }, { capabilities: {} });
  if (!over.transport) await client.connect(clientSide);
  return { client, logs, exits, home, close: () => client.close().catch(() => {}) };
}

const body = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text);
const noSecrets = (s: string) => { expect(s).not.toContain('s3cret'); expect(s).not.toContain('abc123'); expect(s).not.toContain('client-secret-example'); expect(s).not.toContain('#frag'); };

const CASES: Array<[string, RemoteMcpError, string]> = [
  ['config', new RemoteMcpError('config', `bad config for ${SECRET_URL}`), 'config_error'],
  ['discovery', new RemoteMcpError('discovery', `no metadata at ${SECRET_URL}`, { mcp_url: SECRET_URL }), 'unavailable'],
  ['token', new RemoteMcpError('token', 'token endpoint 500', { mcp_url: SECRET_URL }), 'unavailable'],
  ['rate_limited', new RemoteMcpError('rate_limited', 'slow down', { mcp_url: SECRET_URL }), 'rate_limited'],
  ['auth', new RemoteMcpError('auth', 'bad creds', { mcp_url: SECRET_URL }), 'invalid_client'],
  ['auth_after_refresh', new RemoteMcpError('auth_after_refresh', 'still 401', { mcp_url: SECRET_URL }), 'invalid_client'],
  ['network timeout', new RemoteMcpError('network', `timed out ${SECRET_URL}`, { mcp_url: SECRET_URL, kind: 'timeout' }), 'timeout'],
  ['network aborted', new RemoteMcpError('network', 'aborted', { mcp_url: SECRET_URL, kind: 'aborted' }), 'cancelled'],
  ['network unreachable', new RemoteMcpError('network', `ECONNREFUSED ${SECRET_URL}`, { mcp_url: SECRET_URL, kind: 'unreachable' }), 'unavailable'],
  ['parse', new RemoteMcpError('parse', 'bad json', { mcp_url: SECRET_URL }), 'internal_error'],
  ['tool_error', new RemoteMcpError('tool_error', 'odd', { mcp_url: SECRET_URL }), 'internal_error'],
];

describe('bridge call failures', () => {
  for (const [label, error, code] of CASES) {
    test(`${label} on a read → ${code}, secret-free, and no fix widens the client`, async () => {
      const b = await startBridge({ forward: async () => { throw error; } });
      try {
        const r = await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/x' } });
        expect(r.isError).toBe(true);
        const env = body(r);
        expect(env.code).toBe(code);
        expect(env.stage).toBe('call');
        noSecrets(JSON.stringify(r));
        noSecrets(b.logs.join('\n'));
        expect(JSON.stringify(env)).not.toMatch(/--scopes|rescope|register-client[^"]*admin/);
      } finally { await b.close(); }
    });
  }
});

describe('bridge list failures', () => {
  for (const [label, error, code] of CASES) {
    test(`${label} on tools/list → JSON-RPC error with the ${code} envelope and no side effects`, async () => {
      let calls = 0;
      const b = await startBridge({ list: async () => { calls++; throw error; } });
      try {
        let caught: unknown;
        try { await b.client.listTools(); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(McpError);
        const data = (caught as McpError).data as Record<string, unknown>;
        expect(data.code).toBe(code);
        expect(data.side_effects).toBe('none');
        expect(typeof data.stage).toBe('string');
        noSecrets(JSON.stringify(data) + (caught as Error).message);
        expect(b.logs.some(l => l.includes(`code=${code}`) || l.includes(code))).toBe(true);
        noSecrets(b.logs.join('\n'));
        expect(calls).toBeGreaterThan(0);
      } finally { await b.close(); }
    });
  }
});

describe('write identity', () => {
  test('an accepted mutation whose answer was lost keeps its request_id and says the outcome is unknown', async () => {
    let sentId: unknown;
    const b = await startBridge({ forward: async (_c, _n, args) => {
      sentId = args.request_id;
      throw new RemoteMcpError('network', 'socket hang up', { mcp_url: SECRET_URL, kind: 'unreachable', request_id: args.request_id as string, submission_status: 'unknown' });
    } });
    try {
      const env = body(await b.client.callTool({ name: 'put_page', arguments: { slug: 'notes/x', content: 'x' } }));
      expect(env.code).toBe('write_outcome_unknown');
      expect(env.submission_status).toBe('unknown');
      expect(env.request_id).toBe(sentId);
      expect(env.retryable).toBe(false);
      expect(JSON.stringify(env)).toContain('get_write_request');
      expect(env.fix.argv).toEqual(['gbrain', 'write-request', '--', sentId]);
    } finally { await b.close(); }
  });

  test('a mutation that was never sent is safe to resend', async () => {
    const b = await startBridge({ forward: async (_c, _n, args) => {
      throw new RemoteMcpError('network', 'ECONNREFUSED', { mcp_url: SECRET_URL, kind: 'unreachable', request_id: args.request_id as string, submission_status: 'not_sent' });
    } });
    try {
      const env = body(await b.client.callTool({ name: 'put_page', arguments: { slug: 'notes/x', content: 'x' } }));
      expect(env.code).toBe('unavailable');
      expect(env.submission_status).toBe('not_sent');
    } finally { await b.close(); }
  });

  test('a job submission whose answer was lost points at list_jobs, not a write receipt', async () => {
    const b = await startBridge({ forward: async () => {
      throw new RemoteMcpError('network', 'reset', { mcp_url: SECRET_URL, kind: 'unreachable', submission_status: 'unknown' });
    } });
    try {
      const env = body(await b.client.callTool({ name: 'submit_job', arguments: { name: 'sync' } }));
      expect(env.code).toBe('write_outcome_unknown');
      expect(JSON.stringify(env)).toContain('list_jobs');
      expect(JSON.stringify(env)).not.toContain('get_write_request');
    } finally { await b.close(); }
  });
});

describe('unexpected faults', () => {
  test('a thrown non-remote error becomes internal_error with a 0600 trace, and the next call still works', async () => {
    let n = 0;
    const b = await startBridge({ forward: async () => {
      if (n++ === 0) throw new Error(`kaboom at ${SECRET_URL}`);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    } });
    try {
      const first = await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/x' } });
      expect(first.isError).toBe(true);
      const env = body(first);
      expect(env.code).toBe('internal_error');
      const trace = b.logs.map(l => /trace=(\S+)/.exec(l)?.[1]).find(Boolean);
      expect(trace && existsSync(trace)).toBe(true);
      expect(statSync(trace!).mode & 0o777).toBe(0o600);
      noSecrets(await Bun.file(trace!).text());
      noSecrets(JSON.stringify(first) + b.logs.join('\n'));
      const second = await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/x' } });
      expect(second.isError ?? false).toBe(false);
      expect(body(second)).toEqual({ ok: true });
    } finally { await b.close(); }
  });

  test('a startup failure exits 1 with one secret-free stderr line', async () => {
    const b = await startBridge({ transport: () => { throw new Error(`cannot open ${SECRET_URL}`); } });
    expect(b.exits).toEqual([1]);
    const fatal = b.logs.filter(l => l.includes('code=internal_error'));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain('stage=startup');
    noSecrets(b.logs.join('\n'));
  });
});

describe('audience', () => {
  test('an audience-bearing call to a host too old to enforce it is refused before it is sent', async () => {
    let sent = 0;
    const b = await startBridge({ forward: async (_c, _n, _a, o) => {
      const refused = o.admit?.({ name: 'gbrain', version: '0.60.500.0' });
      if (refused) return refused;
      sent++;
      return { content: [{ type: 'text', text: '{}' }] };
    } });
    try {
      const env = body(await b.client.callTool({ name: 'query', arguments: { query: 'x' }, _meta: { on_behalf_of: ['alice-example'] } }));
      expect(env.code).toBe('host_upgrade_required');
      expect(env.min_host_version).toBe('0.60.543.0');
      expect(sent).toBe(0);
    } finally { await b.close(); }
  });

  test('a read answer that does not report its audience is withheld', async () => {
    const b = await startBridge({ forward: async (_c, _n, _a, o) => {
      expect(o.meta).toEqual({ on_behalf_of: ['alice-example'], session_id: 's-1' });
      return { content: [{ type: 'text', text: '{"rows":["canary-row-8543"]}' }] };
    } });
    try {
      const r = await b.client.callTool({ name: 'query', arguments: { query: 'x' }, _meta: { on_behalf_of: ['alice-example'], session_id: 's-1' } });
      expect(body(r).code).toBe('host_upgrade_required');
      expect(JSON.stringify(r)).not.toContain('canary-row-8543');
    } finally { await b.close(); }
  });

  test('a read answer that reports its audience is relayed unchanged', async () => {
    const answer: CallToolResult = { content: [{ type: 'text', text: '{"rows":[]}' }], _meta: { access: { audience: ['alice-example'] } } };
    const b = await startBridge({ forward: async () => answer });
    try {
      const r = await b.client.callTool({ name: 'query', arguments: { query: 'x' }, _meta: { on_behalf_of: ['alice-example'] } });
      expect(r).toEqual(answer);
    } finally { await b.close(); }
  });

  test('a non-object _meta is never relayed (the protocol layer drops the frame before any handler)', async () => {
    let sent = 0;
    const b = await startBridge({ forward: async () => { sent++; return { content: [] }; } });
    try {
      let failed = false;
      try { await b.client.request({ method: 'tools/call', params: { name: 'query', arguments: { query: 'x' }, _meta: 'alice-example' as never } }, CallToolResultSchema, { timeout: 1000 }); }
      catch { failed = true; }
      expect(failed).toBe(true);
      expect(sent).toBe(0);
      expect((await b.client.callTool({ name: 'query', arguments: { query: 'x' } })).isError ?? false).toBe(false);
      expect(sent).toBe(1);
    } finally { await b.close(); }
  });
});

describe('request_tools schemas the host describes enter the bridge tool list', () => {
  const hostVerbsOnly: RemoteToolDefs = { server: HOST, tools: ['query', 'request_tools'].map(name => ({ name, inputSchema: { type: 'object' as const } })) };
  const described = { content: [{ type: 'text' as const, text: JSON.stringify({ tools: [{ name: 'get_page', description: 'Read a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } } } }] }) }] };

  for (const advertise of [undefined, 'verbs'] as const) {
    test(`a tool the host lists only after request_tools is listed next time (advertise=${advertise ?? 'none'})`, async () => {
      const b = await startBridge({ list: async () => hostVerbsOnly, forward: async () => described, ...(advertise ? { advertise } : {}) });
      try {
        expect((await b.client.listTools()).tools.map(x => x.name)).not.toContain('get_page');
        const r = await b.client.callTool({ name: 'request_tools', arguments: { tools: ['get_page'] } });
        expect(r.isError ?? false).toBe(false);
        const after = (await b.client.listTools()).tools;
        expect(after.map(x => x.name)).toContain('get_page');
        expect(after.find(x => x.name === 'get_page')?.inputSchema).toEqual({ type: 'object', properties: { slug: { type: 'string' } } });
      } finally { await b.close(); }
    });
  }
});
