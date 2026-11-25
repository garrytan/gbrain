/**
 * GST-3849 PR 2: the Google token socket end to end over a real Unix socket
 * in a temp GBRAIN_HOME (peer uid faked through the peer-cred seam), the MCP
 * client's wire shape, `gbrain google exec` against a fake gwscli, and the
 * trust boundary: no remote-dispatchable operation reaches the socket modules.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';

import { socketRequest } from '../src/commands/google-socket.ts';
import { FileVaultBackend, type CredentialEntry } from '../src/core/creds/vault.ts';
import { GoogleMcpClient } from '../src/core/google-socket/mcp-client.ts';
import { googleAuditPath, googleSocketPath, startGoogleSocket, type GoogleSocketBinding } from '../src/core/google-socket/server.ts';
import type { GoogleSocketConfig } from '../src/core/google-socket/preconditions.ts';

const ACCOUNT = 'alice@example.com';
const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const CLIENT = '100001-personala.apps.googleusercontent.com';
const OWNER = process.getuid?.() ?? 1000;
const open: GoogleSocketBinding[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

function brainHome(extraScopes: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'gsk-'));
  const home = join(root, '.gbrain');
  mkdirSync(home, { mode: 0o700 });
  const entry: CredentialEntry = { id: `google:${ACCOUNT}`, provider: 'google', kind: 'oauth2', client_ref: 'byo',
    secret: { refresh_token: '1//synthetic-refresh' }, meta: { account: ACCOUNT, scopes: ['openid', 'email', GMAIL_RO, ...extraScopes], client_id: CLIENT, client_mode: 'personal', connected_at: '2026-11-01T00:00:00.000Z', grant_generation: 1 } };
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ version: 2, clients: [{ provider: 'google', client_id: CLIENT, client_secret: 'GOCSPX-synthetic', created_at: '2026-01-01T00:00:00.000Z', account: ACCOUNT, mode: 'personal' }], credentials: { [entry.id]: entry } }));
  return home;
}

const fakeFetch = (async (url: string) => {
  if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'ya29.minted', expires_in: 3600, scope: `openid email ${GMAIL_RO}` }));
  throw new Error(`unexpected ${url}`);
}) as never;

async function start(home: string, peer: number, config: GoogleSocketConfig = {}, seams: { mcp?: GoogleMcpClient; fetchImpl?: never } = {}) {
  const logs: string[] = [];
  const started = await startGoogleSocket({
    home, log: l => logs.push(l), config: () => config, vault: new FileVaultBackend(join(home, 'credentials.json')), fetchImpl: seams.fetchImpl ?? fakeFetch,
    peerCred: { ok: true, read: () => peer }, uid: () => OWNER, ...(seams.mcp ? { mcp: seams.mcp } : {}),
  });
  if (started.ok) open.push(started.binding);
  return { started, logs };
}

describe('the socket', () => {
  test('binds 0600 beside cli.sock, mints read-only tokens and audits without the token', async () => {
    const home = brainHome();
    const { started } = await start(home, OWNER);
    expect(started.ok).toBe(true);
    const path = googleSocketPath(home);
    expect(path).toBe(join(home, 'run', 'google.sock'));
    const minted = await socketRequest(path, { op: 'mint', account: ACCOUNT, profile: 'ingest', caller: 'test' });
    expect(minted).toMatchObject({ ok: true, access_token: 'ya29.minted', account: ACCOUNT, scopes: ['openid', 'email', GMAIL_RO] });
    expect(await socketRequest(path, { op: 'mint', account: ACCOUNT, profile: 'act', caller: 'test' })).toMatchObject({ ok: false, code: 'act_not_mintable' });
    expect(await socketRequest(path, { v: 3, op: 'mint' })).toMatchObject({ ok: false, code: 'unsupported_version', request_id: expect.any(String) });
    expect(await socketRequest(path, { op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: {}, turn_id: 't', idempotency_key: 'k', caller: 'test' }))
      .toMatchObject({ ok: false, code: 'peer_refused' });
    const audit = readFileSync(googleAuditPath(home), 'utf8');
    expect(audit).toContain(`test ${ACCOUNT} ingest ok`);
    expect(audit).not.toContain('ya29');
  });

  test('a peer outside the allowlist is refused before a byte is read; held prompts are the owner\'s alone', async () => {
    const home = brainHome();
    const { logs } = await start(home, 4242);
    const closed = await new Promise<boolean>(res => {
      const s = net.createConnection(googleSocketPath(home));
      s.on('close', () => res(true));
      s.on('error', () => res(true));
      s.on('data', () => res(false));
      s.write(JSON.stringify({ v: 4, op: 'pending' }) + '\n');
    });
    expect(closed).toBe(true);
    expect(logs.join('\n')).toContain('refused a connection from uid 4242');
    const peerHome = brainHome();
    await start(peerHome, 4242, { socket_peers: [4242] });
    expect(await socketRequest(googleSocketPath(peerHome), { op: 'pending' })).toMatchObject({ ok: false, code: 'peer_refused' });
    expect(await socketRequest(googleSocketPath(peerHome), { op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: {}, turn_id: 't', idempotency_key: 'k', caller: 'test' }))
      .toMatchObject({ ok: false, code: 'broker_precondition_unmet', recovery: 'ask_human' });
  });

  test('a headless agent peer makes a write call end to end once every precondition holds', async () => {
    const home = brainHome([GMAIL_COMPOSE]);
    const sent: string[] = [];
    const mcp = { callTool: async (_s: string, token: string, tool: string) => { sent.push(`${tool} ${token}`); return { kind: 'complete', result: { content: [] }, isError: false, text: '' }; }, listTools: async () => [] } as unknown as GoogleMcpClient;
    const writeFetch = (async (url: string) => {
      if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'ya29.act', expires_in: 3600, scope: `openid email ${GMAIL_RO} ${GMAIL_COMPOSE}` }));
      throw new Error(`unexpected ${url}`);
    }) as never;
    const { started } = await start(home, 4242, { broker_act: true, socket_peers: [4242], broker_joint_probe: 4 }, { mcp, fetchImpl: writeFetch });
    expect(started.ok).toBe(true);
    const call = { op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: { to: 'bob@example.com', subject: 's' }, turn_id: 't', idempotency_key: 'k1', caller: 'agent' };
    expect(await socketRequest(googleSocketPath(home), call)).toMatchObject({ ok: true, quota: { product: 'gmail', used_today: 1 } });
    expect(await socketRequest(googleSocketPath(home), call)).toMatchObject({ ok: true, replayed: true });
    expect(sent).toEqual(['create_draft ya29.act']);
    expect(readFileSync(googleAuditPath(home), 'utf8')).not.toContain('ya29');
  });

  test('a stale socket file is replaced; a live one and an overlong path refuse', async () => {
    const home = brainHome();
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    // A process that exits while listening leaves its socket file behind with nobody answering.
    Bun.spawnSync(['bun', '-e', `require('node:net').createServer().listen(${JSON.stringify(googleSocketPath(home))}, () => process.exit(0))`]);
    expect(existsSync(googleSocketPath(home))).toBe(true);
    chmodSync(googleSocketPath(home), 0o600);
    const first = await start(home, OWNER);
    expect(first.started.ok).toBe(true);
    const second = await start(home, OWNER);
    expect(second.started).toMatchObject({ ok: false });
    const deep = join(mkdtempSync(join(tmpdir(), 'gsk-')), 'x'.repeat(90), '.gbrain');
    mkdirSync(deep, { recursive: true, mode: 0o700 });
    expect((await start(deep, OWNER)).started).toMatchObject({ ok: false, reason: expect.stringContaining('longer than a Unix socket address allows') });
  });

  test('a platform without peer credentials never opens the socket', async () => {
    const home = brainHome();
    const started = await startGoogleSocket({ home, log: () => {}, config: () => ({}), peerCred: { ok: false, reason: 'unsupported' }, uid: () => OWNER });
    expect(started).toMatchObject({ ok: false });
    expect(existsSync(googleSocketPath(home))).toBe(false);
  });
});

describe('socket hardening', () => {
  test('the 121st mint in a minute from one peer is rate_limited, and the window resets', async () => {
    const home = brainHome();
    let t = Date.parse('2026-11-25T12:00:00Z');
    const started = await startGoogleSocket({ home, log: () => {}, config: () => ({}), vault: new FileVaultBackend(join(home, 'credentials.json')), fetchImpl: fakeFetch,
      peerCred: { ok: true, read: () => OWNER }, uid: () => OWNER, now: () => t });
    if (!started.ok) throw new Error(started.reason);
    open.push(started.binding);
    const mint = () => socketRequest(googleSocketPath(home), { op: 'mint', account: ACCOUNT, profile: 'ingest', caller: 'test' });
    for (let i = 0; i < 120; i++) expect(await mint()).toMatchObject({ ok: true });
    expect(await mint()).toMatchObject({ ok: false, code: 'rate_limited', retry_after_s: 60 });
    t += 60_001;
    expect(await mint()).toMatchObject({ ok: true });
  });

  test('a setup failure after the bind lock is taken releases the lock', async () => {
    const home = brainHome();
    mkdirSync(googleAuditPath(home), { recursive: true });
    const failed = await start(home, OWNER);
    expect(failed.started.ok).toBe(false);
    rmSync(googleAuditPath(home), { recursive: true });
    expect((await start(home, OWNER)).started.ok).toBe(true);
  });

  test('a client whose connection is closed unanswered gets peer_refused at once, not a 2-minute wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsk-close-'));
    const path = join(dir, 's.sock');
    const server = net.createServer(s => s.destroy());
    await new Promise<void>(res => server.listen(path, res));
    const t0 = Date.now();
    await expect(socketRequest(path, { op: 'pending' })).rejects.toMatchObject({ code: 'peer_refused' });
    expect(Date.now() - t0).toBeLessThan(5000);
    server.close();
  });
});

describe('the MCP client', () => {
  test('sends the 2026-07-28 headers and reads Google\'s approval prompt', async () => {
    const seen: Array<Record<string, string>> = [];
    const client = new GoogleMcpClient((async (_url: string, init?: RequestInit) => {
      seen.push(init!.headers as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init!.body)).id, result: { resultType: 'input_required', requestState: 'opaque',
        inputRequests: { approve: { method: 'elicitation/create', params: { mode: 'form', message: 'Allow?', requestedSchema: { properties: { decision: { enum: ['ALLOW_ONCE', 'DENY'] } } } } } } } }), { headers: { 'content-type': 'application/json' } });
    }) as never);
    const out = await client.callTool('gmail', 'ya29.act', 'create_draft', {});
    expect(out).toEqual({ kind: 'input_required', prompt: { message: 'Allow?', choices: ['ALLOW_ONCE', 'DENY'], field: 'decision', inputKey: 'approve', requestState: 'opaque' } });
    expect(seen[0]).toMatchObject({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', authorization: 'Bearer ya29.act' });
  });
});

describe('gbrain google exec', () => {
  test('runs only gwscli, with the minted token redacted from its output', async () => {
    const home = brainHome();
    const bin = mkdtempSync(join(tmpdir(), 'gsk-bin-'));
    writeFileSync(join(bin, 'gwscli'), '#!/bin/sh\necho "argv: $*"\necho "telemetry=$GWSCLI_TELEMETRY_ENABLED" 1>&2\n', { mode: 0o755 });
    const cli = resolve(import.meta.dir, '../src/cli.ts');
    const env = { ...process.env, GBRAIN_HOME: dirname(home), PATH: `${bin}:${process.env.PATH}` };
    const preload = join(bin, 'fetch.ts');
    writeFileSync(preload, `globalThis.fetch = (async (u) => String(u).endsWith('/token') ? new Response(JSON.stringify({ access_token: 'ya29.exec-secret', expires_in: 3600, scope: 'openid email ${GMAIL_RO}' })) : new Response('{}', { status: 500 }));\n`);
    const run = Bun.spawnSync(['bun', '--preload', preload, cli, 'google', 'exec', '--account', ACCOUNT, '--', 'gwscli', 'gmail', 'list'], { env, stdout: 'pipe', stderr: 'pipe' });
    const out = run.stdout.toString();
    const err = run.stderr.toString();
    expect(out).toContain('argv: --oauth_token=[redacted:google_token] gmail list');
    expect(out + err).not.toContain('ya29.exec-secret');
    expect(err).toContain('telemetry=0');
    const refused = Bun.spawnSync(['bun', cli, 'google', 'exec', '--account', ACCOUNT, '--', 'curl', 'x'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain('only gwscli, by its bare name');
    const byPath = Bun.spawnSync(['bun', cli, 'google', 'exec', '--account', ACCOUNT, '--', join(bin, 'gwscli'), 'gmail'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(byPath.exitCode).toBe(2);
    const audit = readFileSync(googleAuditPath(home), 'utf8');
    expect(audit).toContain(`gwscli-exec ${ACCOUNT} ingest ok`);
    expect(audit).not.toContain('ya29');
    const debug = Bun.spawnSync(['bun', cli, 'google', 'exec', '--account', ACCOUNT, '--', 'gwscli', '--debug'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(debug.exitCode).toBe(2);
  }, 60_000);
});

describe('trust boundary', () => {
  // The op layer reaches the CLI's argv dispatch table (src/cli/command-table.ts) only to route local commands; every
  // other path from an operation or the MCP server must stay clear of the socket, the broker and the exec wrapper.
  test('no remote-dispatchable operation can import the socket, the broker or the exec wrapper', () => {
    const root = resolve(import.meta.dir, '..');
    const seen = new Set<string>();
    const queue = [join(root, 'src/core/operations.ts'), join(root, 'src/mcp/server.ts')];
    const spec = /(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(spec)) {
        const s = m[1] ?? m[2] ?? m[3];
        if (!s || !s.startsWith('.')) continue;
        const target = resolve(dirname(file), s);
        if (target.endsWith('src/cli/command-table.ts') || target.endsWith('src/cli/command-table')) continue;
        queue.push(target.endsWith('.ts') ? target : `${target}.ts`);
      }
    }
    const reached = [...seen].map(f => f.slice(root.length + 1)).filter(f => f.startsWith('src/core/google-socket/') || f === 'src/commands/google-socket.ts');
    expect(seen.size).toBeGreaterThan(50);
    expect(reached).toEqual([]);
  });
});

describe('gbrain config set google.*', () => {
  test('a rejected value prints the reason and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsk-cfg-'));
    const cli = resolve(import.meta.dir, '../src/cli.ts');
    const env = { ...process.env, GBRAIN_HOME: root };
    expect(Bun.spawnSync(['bun', cli, 'init', '--pglite', '--no-embedding'], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
    const bad = Bun.spawnSync(['bun', cli, 'config', 'set', 'google.socket_peers', 'abc'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(bad.stderr.toString()).toContain('comma-separated list of uids');
    expect(bad.stderr.toString()).not.toContain('${');
    expect(readFileSync(join(root, '.gbrain', 'config.json'), 'utf8')).not.toContain('socket_peers');
  }, 60_000);
});
