/**
 * #8543 / GST-2104: on a thin client, plain `gbrain serve` is an engine-free
 * stdio MCP relay to the remote brain. These probes drive the real CLI: a
 * `gbrain serve --http` host on a keyless, repo-less PGLite home, OAuth
 * clients registered on it, and thin homes whose bare `gbrain serve` is
 * spoken to over stdio by the SDK client. The relay adds no privilege: every
 * answer is the host's answer for the stored credential.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const PATH_ENV = `/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`;
const baseEnv = { GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', GBRAIN_NON_INTERACTIVE: '1',
  GBRAIN_NO_BANNER: '1', NO_COLOR: '1', NODE_ENV: 'test', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SURFACE: undefined };

let hostHome: string;
let base: string;
let server: ChildProcess;
let serverErr = '';
const tempDirs: string[] = [];

const gbrain = (cwd: string, args: string[]) => runCli(args, { home: cwd, cwd, env: baseEnv, timeoutMs: 90_000 });
const ok = (result: CliResult) => {
  expect({ exit: result.exitCode, failure: result.exitCode ? result.stdout + result.stderr : '' }).toEqual({ exit: 0, failure: '' });
  return result.stdout;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

async function registerClient(name: string, scopes: string): Promise<{ id: string; secret: string }> {
  const reg = await gbrain(hostHome, ['auth', 'register-client', name, '--grant-types', 'client_credentials',
    '--scopes', scopes, '--token-endpoint-auth-method', 'client_secret_post']);
  const id = /Client ID:\s+(\S+)/.exec(reg.stdout)?.[1];
  const secret = /Client Secret:\s+(\S+)/.exec(reg.stdout)?.[1];
  if (!id || !secret) throw new Error(`register-client yielded no credentials:\n${reg.stdout}\n${reg.stderr}`);
  return { id, secret };
}

function thinHome(cred: { id: string; secret: string }, mcpUrl = `${base}/mcp`): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bridge-thin-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres', remote_mcp: { issuer_url: base, mcp_url: mcpUrl, oauth_client_id: cred.id, oauth_client_secret: cred.secret },
  }));
  return dir;
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: PATH_ENV, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0',
    GBRAIN_SWEEP: '0', NODE_ENV: 'test', ...extra };
}

async function bridge(home: string, args: string[] = [], extra: Record<string, string> = {}) {
  const client = new Client({ name: 'bridge-8543-test', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve', ...args],
    cwd: home, env: childEnv(home, extra), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  await client.connect(transport, { signal: AbortSignal.timeout(60_000) });
  return { client, stderr: () => stderr, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}

async function direct(cred: { id: string; secret: string }) {
  const tok = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cred.id, client_secret: cred.secret }) });
  const { access_token } = await tok.json() as { access_token: string };
  const client = new Client({ name: 'direct-8543-test', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); } };
}

const text = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join('');
const names = (l: { tools: { name: string }[] }) => l.tools.map(t => t.name).sort();

async function putLocal(slug: string, content: string): Promise<void> {
  const child = Bun.spawn([process.execPath, '--no-env-file', CLI, 'put', slug], { cwd: hostHome, env: childEnv(hostHome, { GBRAIN_NON_INTERACTIVE: '1' }),
    stdin: new TextEncoder().encode(content), stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = [await child.exited, await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect({ code, failure: code ? out + err : '' }).toEqual({ code: 0, failure: '' });
}

let port = 0;
async function startHost(): Promise<void> {
  const serverEnv: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    ...childEnv(hostHome) };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_SURFACE']) delete serverEnv[key];
  server = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base],
    { cwd: hostHome, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d: Buffer) => { serverErr += d.toString(); });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch { /* not up yet */ }
    if (!ready) await Bun.sleep(500);
  }
  if (!ready) throw new Error(`serve --http did not become ready:\n${serverErr}`);
}

async function stopHost(): Promise<void> {
  const s = server;
  if (!s || s.exitCode !== null) return;
  s.kill('SIGTERM');
  await new Promise(resolve => { if (s.exitCode !== null) resolve(null); else s.once('exit', resolve); });
}

let readCred: { id: string; secret: string };
let writeCred: { id: string; secret: string };
let revokeCred: { id: string; secret: string };

beforeAll(async () => {
  hostHome = mkdtempSync(join(tmpdir(), 'gbrain-bridge-host-'));
  ok(await gbrain(hostHome, ['init', '--pglite', '--no-embedding', '--non-interactive', '--json']));
  ok(await gbrain(hostHome, ['access', 'member', 'add', 'alice-example']));
  readCred = await registerClient('bridge-8543-read', 'read');
  revokeCred = await registerClient('bridge-8543-revoke', 'read');
  writeCred = await registerClient('bridge-8543-write', 'read write');
  await putLocal('notes/alice-example-private-8543', '---\ntitle: Kept page\nreadable_by: [alice-example]\n---\nCanary kept-8543-zq.\n');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startHost();
  const w = await direct(writeCred);
  try {
    const put = await w.client.callTool({ name: 'put_page', arguments: { slug: 'notes/bridge-seed-8543', content: '---\ntitle: Bridge seed\n---\nSeeded for the stdio bridge test.\n' } });
    expect(put.isError ?? false).toBe(false);
  } finally { await w.close(); }
}, 240_000);

afterAll(async () => {
  await stopHost();
  for (const d of [hostHome, ...tempDirs]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('thin-client gbrain serve relays stdio to the remote brain', () => {
  test('a read-only client sees exactly the host listing, reads round-trip, refusals are the host\'s own', async () => {
    const home = thinHome(readCred);
    const b = await bridge(home);
    const d = await direct(readCred);
    try {
      const [viaBridge, viaHost] = [await b.client.listTools(), await d.client.listTools()];
      expect(names(viaBridge)).toEqual(names(viaHost));
      expect(names(viaBridge)).not.toContain('put_page');
      expect(names(viaBridge)).not.toContain('file_upload');

      const got = await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-seed-8543' } });
      expect(got.isError ?? false).toBe(false);
      expect(text(got)).toContain('Seeded for the stdio bridge test.');

      const [missB, missH] = [await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/absent-8543' } }),
        await d.client.callTool({ name: 'get_page', arguments: { slug: 'notes/absent-8543' } })];
      expect(missB.isError).toBe(true);
      expect(text(missB)).toBe(text(missH));

      const [putB, putH] = [await b.client.callTool({ name: 'put_page', arguments: { slug: 'notes/denied-8543', content: 'x' } }),
        await d.client.callTool({ name: 'put_page', arguments: { slug: 'notes/denied-8543', content: 'x' } })];
      expect(putB.isError).toBe(true);
      const withoutSessionNotices = (r: any) => { const { notices: _once, ...rest } = JSON.parse(text(r)); return rest; };
      expect(withoutSessionNotices(putB)).toEqual(withoutSessionNotices(putH));
      expect(withoutSessionNotices(putB).code).toBe('insufficient_scope');

      const up = await b.client.callTool({ name: 'file_upload', arguments: { path: '/etc/hostname' } });
      expect(up.isError).toBe(true);
      expect(text(up)).toContain('unknown_tool');
      expect(existsSync(join(home, '.gbrain')) ? readdirSync(join(home, '.gbrain')).filter(f => /pglite/i.test(f)) : []).toEqual([]);
    } finally { await b.close(); await d.close(); }
  }, 180_000);

  test('a write client\'s put_page lands on the host and reads back', async () => {
    const b = await bridge(thinHome(writeCred));
    try {
      const put = await b.client.callTool({ name: 'put_page', arguments: { slug: 'notes/bridge-write-8543', content: '---\ntitle: Bridged write\n---\nWritten through the bridge.\n' } });
      expect({ isError: put.isError ?? false, body: put.isError ? text(put) : '' }).toEqual({ isError: false, body: '' });
    } finally { await b.close(); }
    const d = await direct(readCred);
    try {
      expect(text(await d.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-write-8543' } }))).toContain('Written through the bridge.');
    } finally { await d.close(); }
  }, 180_000);

  test('a narrow surface lists only its tools, refuses the rest locally and widens per session', async () => {
    const b = await bridge(thinHome(writeCred), ['--surface', 'starter', '--advertise', 'verbs']);
    try {
      const listed = names(await b.client.listTools());
      expect(listed).toContain('request_tools');
      const d = await direct(writeCred);
      const hostListed = await (async () => { try { return names(await d.client.listTools()); } finally { await d.close(); } })();
      expect(listed.length).toBeLessThan(hostListed.length);
      const hidden = hostListed.find(n => !STARTER_OPS.has(n) && !listed.includes(n));
      if (!hidden) throw new Error('no full-only tool on the host listing');
      const refused = await b.client.callTool({ name: hidden, arguments: {} });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('unknown_tool');
      expect(text(refused)).toContain('request_tools');
      let changed = 0;
      b.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
      const outside = await b.client.callTool({ name: 'request_tools', arguments: { tools: [hidden] } });
      expect(outside.isError ?? false).toBe(false);
      expect(text(outside)).toContain('request_tools {\\"surface\\":\\"full\\"}');
      const inSurface = hostListed.find(n => STARTER_OPS.has(n) && !listed.includes(n));
      if (!inSurface) throw new Error('no starter tool hidden by --advertise verbs');
      const revealed = await b.client.callTool({ name: 'request_tools', arguments: { tools: [inSurface] } });
      expect(revealed.isError ?? false).toBe(false);
      for (let i = 0; i < 20 && changed === 0; i++) await Bun.sleep(100);
      expect(changed).toBe(1);
      const afterReveal = names(await b.client.listTools());
      expect(afterReveal).toContain(inSurface);
      expect(afterReveal).not.toContain(hidden);
      const other = hostListed.find(n => !STARTER_OPS.has(n) && n !== hidden && !listed.includes(n));
      if (!other) throw new Error('no second full-only tool on the host listing');
      const before = await gbrain(hostHome, ['auth', 'clients', '--json']);
      const widened = await b.client.callTool({ name: 'request_tools', arguments: { surface: 'full' } });
      expect(widened.isError ?? false).toBe(false);
      for (let i = 0; i < 20 && changed === 1; i++) await Bun.sleep(100);
      expect(changed).toBe(2);
      expect(names(await b.client.listTools())).toEqual(hostListed);
      expect((await gbrain(hostHome, ['auth', 'clients', '--json'])).stdout).toBe(before.stdout);
    } finally { await b.close(); }
  }, 180_000);

  test('stdout carries only JSON-RPC and stdin EOF exits 0 with no local brain', async () => {
    const home = thinHome(readCred);
    const child = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], { cwd: home, env: childEnv(home), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const reader = child.stdout.getReader();
    let out = '';
    const deadline = Date.now() + 60_000;
    while (!out.includes('"id":2') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    child.stdin.end();
    const code = await child.exited;
    while (true) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
    const stderr = await new Response(child.stderr).text();
    for (const line of out.split('\n').filter(Boolean)) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' });
    const files = readdirSync(home, { recursive: true }).map(String);
    expect(files.filter(f => /pglite/i.test(f))).toEqual([]);
  }, 120_000);

  test('a revoked client is refused on the next call without restarting the bridge', async () => {
    const cred = revokeCred;
    const b = await bridge(thinHome(cred));
    try {
      expect((await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-seed-8543' } })).isError ?? false).toBe(false);
      await stopHost();
      const revoked = await gbrain(hostHome, ['auth', 'revoke-client', cred.id]);
      await startHost();
      expect({ exit: revoked.exitCode, out: revoked.exitCode ? revoked.stdout + revoked.stderr : '' }).toEqual({ exit: 0, out: '' });
      const after = await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-seed-8543' } });
      expect(after.isError).toBe(true);
      expect(text(after)).not.toContain('Seeded for the stdio bridge test.');
      expect(JSON.parse(text(after)).code).toBe('invalid_client');
      expect(text(after)).not.toContain(cred.secret);
    } finally { await b.close(); }
  }, 180_000);

  test('a page kept to a member stays invisible to an unbound credential through the bridge', async () => {
    const b = await bridge(thinHome(readCred));
    const d = await direct(readCred);
    try {
      const [viaB, viaH] = [await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/alice-example-private-8543' } }),
        await d.client.callTool({ name: 'get_page', arguments: { slug: 'notes/alice-example-private-8543' } })];
      expect(text(viaH)).not.toContain('kept-8543-zq');
      expect(text(viaB)).not.toContain('kept-8543-zq');
      expect(viaB.isError ?? false).toBe(viaH.isError ?? false);
      const found = await b.client.callTool({ name: 'search', arguments: { query: 'kept-8543-zq' } });
      expect(text(found)).not.toContain('kept-8543-zq');
    } finally { await b.close(); await d.close(); }
  }, 180_000);

  test('a lost acknowledgment keeps the write identity, and a replay commits exactly once', async () => {
    const seen: string[] = [];
    let dropNextPut = true;
    const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.text() : undefined;
      const client = req.headers.get('x-gbrain-client');
      if (client) seen.push(client);
      const headers = new Headers(req.headers);
      headers.delete('host');
      const upstream = await fetch(`${base}${url.pathname}${url.search}`, { method: req.method, headers, body });
      if (dropNextPut && body?.includes('"tools/call"') && body.includes('"put_page"')) {
        dropNextPut = false;
        await upstream.arrayBuffer();
        return new Response('bad gateway', { status: 502 });
      }
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } });
    const b = await bridge(thinHome(writeCred, `http://127.0.0.1:${proxy.port}/mcp`));
    try {
      const args = { slug: 'notes/bridge-lost-ack-8543', content: '---\ntitle: Lost ack\n---\nOnce only.\n' };
      const lost = await b.client.callTool({ name: 'put_page', arguments: args });
      expect(lost.isError).toBe(true);
      const env = JSON.parse(text(lost));
      expect(env.code).toBe('write_outcome_unknown');
      expect(env.submission_status).toBe('unknown');
      expect(env.request_id).toMatch(/^[0-9a-f-]{36}$/);
      const replay = await b.client.callTool({ name: 'put_page', arguments: { ...args, request_id: env.request_id } });
      expect({ isError: replay.isError ?? false, body: replay.isError ? text(replay) : '' }).toEqual({ isError: false, body: '' });
      const receipt = JSON.parse(text(await b.client.callTool({ name: 'get_write_request', arguments: { request_id: env.request_id } })));
      expect(receipt.state).toBe('committed');
      expect(JSON.parse(text(replay)).revision).toBe(receipt.revision);
      const versions = await b.client.callTool({ name: 'get_versions', arguments: { slug: args.slug } });
      expect(JSON.parse(text(versions))).toHaveLength(0);
      expect(seen.length).toBeGreaterThan(0);
      for (const h of seen) expect(h).toMatch(/^gbrain-stdio-bridge\/\S+$/);
    } finally { await b.close(); proxy.stop(true); }
  }, 180_000);

  test('with MCP_STDIO=1 the bridge outlives stdin end and SIGTERM ends it like any gbrain process (143)', async () => {
    const home = thinHome(readCred);
    const child = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], { cwd: home, env: childEnv(home, { MCP_STDIO: '1' }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
    const reader = child.stdout.getReader();
    let out = '';
    while (!out.includes('"id":1')) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
    child.stdin.end();
    await Bun.sleep(1500);
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
  }, 120_000);

  test('stdin EOF with a put_page still in flight delivers its receipt before exit', async () => {
    const home = thinHome(writeCred);
    const child = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], { cwd: home, env: childEnv(home), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'put_page',
      arguments: { slug: 'notes/bridge-eof-8543', content: '---\ntitle: EOF write\n---\nWritten at EOF.\n' } } }) + '\n');
    child.stdin.end();
    const [code, out] = [await child.exited, await new Response(child.stdout).text()];
    const reply = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 2);
    expect(code).toBe(0);
    expect(reply?.result?.isError ?? false).toBe(false);
    expect(JSON.parse(reply.result.content[0].text).slug).toBe('notes/bridge-eof-8543');
  }, 120_000);

  test('_meta reaches the host unchanged: identity is the credential\'s and a forbidden on_behalf_of is the host\'s refusal', async () => {
    const b = await bridge(thinHome(readCred));
    const d = await direct(readCred);
    try {
      const [whoB, whoH] = [await b.client.callTool({ name: 'whoami', arguments: {} }), await d.client.callTool({ name: 'whoami', arguments: {} })];
      expect(text(whoH)).toContain(readCred.id);
      expect(text(whoB)).toContain(readCred.id);
      expect(JSON.parse(text(whoB)).scopes ?? null).toEqual(JSON.parse(text(whoH)).scopes ?? null);
      const meta = { on_behalf_of: ['alice-example'] };
      const [obB, obH] = [await b.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-seed-8543' }, _meta: meta }),
        await d.client.callTool({ name: 'get_page', arguments: { slug: 'notes/bridge-seed-8543' }, _meta: meta })];
      expect(obH.isError).toBe(true);
      expect(obB.isError).toBe(true);
      expect(JSON.parse(text(obB)).code).toBe(JSON.parse(text(obH)).code);
      expect(text(obB)).not.toContain('Seeded for the stdio bridge test.');
    } finally { await b.close(); await d.close(); }
  }, 180_000);

  test('doctor on a read-only thin client never recommends adding a scope', async () => {
    const r = await gbrain(thinHome(readCred), ['doctor', '--json']);
    const out = r.stdout + r.stderr;
    expect(out).not.toMatch(/--scopes[ =]?[^\n"]*admin|read,write,admin|re-register/);
    const scope = JSON.parse(r.stdout).checks?.find((x: any) => x.name === 'oauth_client_scopes_probe');
    expect(scope?.status).toBe('ok');
  }, 180_000);

  test('host-only serve forms still refuse on a thin client', async () => {
    const home = thinHome(readCred);
    for (const args of [['serve', '--http'], ['serve', '--http', '--port', '3131'], ['serve', '--access', 'read-only']]) {
      const r = await gbrain(home, args);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toContain('requires_local_engine');
    }
  }, 120_000);
});
