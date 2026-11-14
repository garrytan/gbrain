/**
 * Status-only `gbrain serve --http` (agent operator follow-up, Item 3).
 *
 * Protects: a shared HTTP serve whose brain cannot be opened stays up on its
 * port and explains itself (503 /health with an allowlisted, path-free,
 * reason-collapsed payload; MCP with only gbrain_status; serve_status_only
 * envelopes on OAuth/admin routes), writes a per-instance marker that doctor
 * reports as serve_status_only (transport http), and recovers in place on the
 * same port once the brain frees up, after which clients re-authenticate
 * (401 + WWW-Authenticate) and an authenticated gbrain_status answers
 * `recovered`. Regression it catches: the pre-change exit (a supervisor crash
 * loop showing every client a dead endpoint), a leaked path or PID, a second
 * brain open from overlapping re-probes, a failed full-app build that exits
 * or drops the status handler, and shutdown races during recovery.
 *
 * Serial: real ports, child processes and process-wide GBRAIN_HOME.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runHttpStatusServe } from '../src/commands/serve-http-status.ts';
import { initialStatusState } from '../src/mcp/status-mode.ts';
import { liveStatusMarkers, readStatusMarkers } from '../src/core/serve-http-status-marker.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const MARKER = 'quillon-http-status-8d2';
const BRAIN_SEGMENT = 'data/brains/x';
const HEALTH_KEYS = ['status', 'reason', 'why', 'fix', 'user_message', 'retry_after_s', 'contract_version', 'instance'];

function envFor(home: string): Record<string, string> {
  const env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined });
  delete env.GBRAIN_SOURCE;
  delete env.GBRAIN_SERVE_FAIL_FAST;
  env.GBRAIN_NO_BANNER = '1';
  return env;
}

function cli(args: string[], env: Record<string, string>, timeout = 120_000) {
  return spawnSync(process.execPath, ['--no-env-file', CLI, ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout, input: '' });
}

/** Distinct free ports, all held open until every one is chosen. */
async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  await Promise.all(servers.map(s => new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()))));
  const ports = servers.map(s => (s.address() as AddressInfo).port);
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  return ports;
}
const freePort = async () => (await freePorts(1))[0];

async function waitFor(pred: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred().catch(() => false)) return true;
    await Bun.sleep(250);
  }
  return false;
}

function startHttp(env: Record<string, string>, port: number): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', `http://127.0.0.1:${port}`],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  return { child, stderr: () => err };
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(null); else child.once('exit', resolve); });
}

function body(res: unknown): Record<string, any> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

describe('serve --http: lock held → status-only → recovery on the same port', () => {
  let home: string;
  let env: Record<string, string>;
  let token = '';
  let clientId = '';
  let clientSecret = '';
  let holder: { client: Client; transport: StdioClientTransport } | null = null;
  let http: ReturnType<typeof startHttp> | null = null;
  let thinHome: string;
  let port: number;
  let base: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-http-status-'));
    env = envFor(home);
    const brainDir = join(home, BRAIN_SEGMENT);
    mkdirSync(join(home, 'data', 'brains'), { recursive: true });
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive', '--path', brainDir], env).status).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'm.md'), `---\ntitle: ${MARKER}\n---\n\n# ${MARKER}\n\nHTTP status-mode recall proof ${MARKER}.\n`);
    expect(cli(['import', notes, '--no-embed'], env).status).toBe(0);
    const created = cli(['auth', 'create', 'status-harness', '--scopes', 'read,write'], env);
    expect(created.status).toBe(0);
    token = (created.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    const reg = cli(['auth', 'register-client', 'status-thin', '--grant-types', 'client_credentials', '--scopes', 'read write', '--token-endpoint-auth-method', 'client_secret_post'], env);
    clientId = /Client ID:\s+(\S+)/.exec(reg.stdout)?.[1] ?? '';
    clientSecret = /Client Secret:\s+(\S+)/.exec(reg.stdout)?.[1] ?? '';
    expect(token && clientId && clientSecret).toBeTruthy();
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    thinHome = mkdtempSync(join(tmpdir(), 'gbrain-http-status-thin-'));
    mkdirSync(join(thinHome, '.gbrain'), { recursive: true });
    writeFileSync(join(thinHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'postgres', remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: clientId, oauth_client_secret: clientSecret },
    }));
  }, 240_000);

  afterAll(async () => {
    if (holder) { try { await holder.client.close(); } catch { /* best-effort */ } }
    await stopChild(http?.child ?? null);
    rmSync(home, { recursive: true, force: true });
    rmSync(thinHome, { recursive: true, force: true });
  });

  test('status-only while a stdio serve holds the brain; recovery in place; then the port is taken', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve'], cwd: process.cwd(), env, stderr: 'pipe' });
    holder = { client: new Client({ name: 'holder', version: '1' }, { capabilities: {} }), transport };
    await holder.client.connect(transport);
    const holderPid = String(transport.pid);

    // --fail-fast keeps the supervisor exit.
    const failFast = spawnSync(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--fail-fast', '--port', String(await freePort())],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000, input: '' });
    expect(failFast.signal).toBeNull();
    expect(failFast.status).not.toBe(0);

    http = startHttp(env, port);
    expect(await waitFor(async () => (await fetch(`${base}/health`)).status === 503, 60_000)).toBe(true);

    // /health: 503, Retry-After, only allowlisted keys, the reason collapsed (a loopback request, as Funnel delivers it).
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    expect(health.headers.get('retry-after')).toBe('5');
    const healthText = await health.text();
    const healthBody = JSON.parse(healthText);
    // The instance is 32 random hex digits (the marker's nonce, checked below), which can hold the PID's digits by chance;
    // the PID must appear nowhere else.
    expect(healthBody.instance).toMatch(/^[0-9a-f]{32}$/);
    const leaks = (text: string) => {
      const exposed = text.replaceAll(healthBody.instance, '<instance>');
      expect(exposed).not.toContain(BRAIN_SEGMENT); expect(exposed).not.toContain(holderPid); expect(exposed).not.toContain(home);
    };
    leaks(healthText);
    expect(Object.keys(healthBody).every(k => HEALTH_KEYS.includes(k))).toBe(true);
    expect(healthBody).toMatchObject({ status: 'unavailable', reason: 'unavailable', retry_after_s: 5, contract_version: 1 });
    expect(healthBody.fix).toMatchObject({ argv: ['gbrain', 'doctor', '--json'], actor: 'host_admin', next: 'tell_user_to_run' });

    // OAuth/admin routes: a 503 serve_status_only envelope.
    for (const [path, method] of [['/.well-known/oauth-authorization-server', 'GET'], ['/token', 'POST'], ['/admin', 'GET'], ['/register', 'POST']] as const) {
      const r = await fetch(`${base}${path}`, { method });
      expect(r.status).toBe(503);
      const text = await r.text();
      leaks(text);
      expect(JSON.parse(text)).toMatchObject({ code: 'serve_status_only', reason: 'unavailable', fix: { actor: 'host_admin', next: 'tell_user_to_run' } });
    }

    // MCP: initialize + tools/list show only gbrain_status; any other tool is one serve_status_only block.
    const anon = new Client({ name: 'status-anon', version: '1' }, { capabilities: {} });
    await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    expect(anon.getInstructions()).toContain('STATUS-ONLY MODE');
    leaks(anon.getInstructions() ?? '');
    expect((await anon.listTools()).tools.map(t => t.name)).toEqual(['gbrain_status']);
    const status = await anon.callTool({ name: 'gbrain_status', arguments: {} });
    leaks(JSON.stringify(status));
    expect(body(status)).toMatchObject({ status: 'unavailable', reason: 'unavailable' });
    const refused = await anon.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(refused.isError).toBe(true);
    expect((refused.content as unknown[]).length).toBe(1);
    expect(body(refused)).toMatchObject({ code: 'serve_status_only', reason: 'unavailable' });
    await anon.close();

    // The marker holds the detailed reason and matches the responder.
    const markerPath = join(home, '.gbrain', `serve-http-status-${port}.json`);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker).toMatchObject({ pid: http.child.pid, port, reason: 'lock_held', instance_nonce: healthBody.instance });

    // Doctor on the host names the status-only server and the reason's fix, not "start serve --http".
    const doctor = cli(['doctor', '--only', 'harness_wiring', '--json'], env);
    const wiring = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === 'harness_wiring');
    expect(wiring.details).toMatchObject({ reason: 'serve_status_only', transport: 'http', port, status_reason: 'lock_held' });
    expect(wiring.fix.argv).toEqual(['kill', holderPid]);

    // The thin client renders the envelope and its host-admin fix (cold credentials: discovery answers 503).
    const thinEnv = { ...envFor(thinHome) };
    const thin = cli(['search', MARKER, '--json'], thinEnv, 60_000);
    expect(thin.status).not.toBe(0);
    expect(JSON.parse(thin.stdout)).toMatchObject({ code: 'serve_status_only', fix: { actor: 'host_admin', next: 'tell_user_to_run' } });
    const remoteDoctor = cli(['doctor', '--json'], thinEnv, 60_000);
    const disco = JSON.parse(remoteDoctor.stdout).checks.find((c: { name: string }) => c.name === 'oauth_discovery');
    expect(disco).toMatchObject({ status: 'fail', detail: { status: 503, code: 'serve_status_only' } });

    // The holder closes: the same port serves the full app within 10 s.
    await holder.client.close();
    holder = null;
    expect(await waitFor(async () => (await fetch(`${base}/health`)).status === 200, 15_000)).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    expect(http.stderr()).toContain('"event":"serve_status_mode_recovered","reason":"lock_held","transport":"http"');

    // A client that initialized during status mode gets a standard 401 with resource metadata.
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata=');

    // Authenticated: the never-listed gbrain_status alias answers recovered; the full catalog serves recall.
    const authed = new Client({ name: 'status-authed', version: '1' }, { capabilities: {} });
    await authed.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const tools = (await authed.listTools()).tools.map(t => t.name);
      expect(tools).not.toContain('gbrain_status');
      expect(tools).toContain('search');
      expect(body(await authed.callTool({ name: 'gbrain_status', arguments: {} }))).toMatchObject({ status: 'recovered', reason: 'lock_held' });
      const found = await authed.callTool({ name: 'search', arguments: { query: MARKER } });
      expect(JSON.stringify(body(found))).toContain(MARKER);
    } finally {
      await authed.close();
    }

    // Recovery through the real thin client.
    const thinAfter = cli(['search', MARKER, '--json'], thinEnv, 60_000);
    expect(thinAfter.status).toBe(0);
    expect(thinAfter.stdout).toContain(MARKER);

    // A second serve --http on the port the owning HTTP serve holds exits with serve_port_in_use.
    const second = spawnSync(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port)],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000, input: '' });
    expect(second.signal).toBeNull();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('serve_port_in_use');
    expect(readdirSync(join(home, '.gbrain')).filter(n => n.startsWith('serve-http-status-'))).toEqual([]);
  }, 300_000);
});

describe('serve --http: no brain → gbrain init → recovery', () => {
  let home: string;
  let http: ReturnType<typeof startHttp> | null = null;
  afterAll(async () => { await stopChild(http?.child ?? null); rmSync(home, { recursive: true, force: true }); });

  test('starts status-only with reason no_brain and picks the new brain up', async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-http-status-nobrain-'));
    const env = envFor(home);
    const port = await freePort();
    http = startHttp(env, port);
    expect(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 503, 60_000)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.gbrain', `serve-http-status-${port}.json`), 'utf8')).reason).toBe('no_brain');
    expect(http.stderr()).toContain('Re-checking every 5 s; Ctrl-C to stop; --fail-fast to exit instead.');
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    expect(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 200, 20_000)).toBe(true);
  }, 180_000);
});

describe('status marker liveness', () => {
  let home: string;
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('a marker whose PID is gone is ignored by readiness and removed by doctor', async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-http-status-stale-'));
    const env = envFor(home);
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    const dead = spawnSync('true').pid;
    const path = join(home, '.gbrain', 'serve-http-status-45999.json');
    writeFileSync(path, JSON.stringify({ pid: dead, instance_nonce: 'n', brain_id: 'b', bind: '127.0.0.1', port: 45999, reason: 'lock_held', since: new Date().toISOString() }));
    const prior = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    try {
      expect(readStatusMarkers().length).toBe(1);
      expect(liveStatusMarkers()).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prior;
    }
    const doctor = cli(['doctor', '--only', 'harness_wiring', '--json'], env);
    const wiring = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === 'harness_wiring');
    expect(wiring.details?.reason).not.toBe('serve_status_only');
    expect(existsSync(path)).toBe(false);
  }, 180_000);
});

describe('runHttpStatusServe lifecycle (in process)', () => {
  let home: string;
  let prior: string | undefined;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-http-status-unit-'));
    prior = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  });

  type Handle = { server: import('node:http').Server; nonce: string; shutdown(): Promise<void> };
  const fakeEngine = () => {
    const calls = { disconnect: 0 };
    return { calls, engine: { disconnect: async () => { calls.disconnect++; } } as unknown as BrainEngine };
  };
  const markerFile = (port: number) => join(home, '.gbrain', `serve-http-status-${port}.json`);

  async function getHealth(port: number): Promise<{ status: number; body: string; socketPort: number }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/health' }, (res: IncomingMessage) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, socketPort: port }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function start(port: number, probe: () => Promise<BrainEngine | null>, runServe?: NonNullable<Parameters<typeof runHttpStatusServe>[3]>['runServe']) {
    let handle!: Handle;
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const done = runHttpStatusServe(initialStatusState('no_brain'), ['serve', '--http', '--port', String(port)], probe, {
      tickMs: 40, log: () => {}, exit: () => {}, runServe, onReady: h => { handle = h; resolveReady(); },
    });
    return { ready: ready.then(() => handle), done: () => done };
  }

  test('a slow connect across three ticks opens once; recovery swaps the handler on the same listener', async () => {
    const port = await freePort();
    const { engine } = fakeEngine();
    let probes = 0;
    const s = start(port, async () => { probes++; await Bun.sleep(200); return engine; }, async (_e, _a, o) => {
      o.adoptServer.adopt((_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end('full'); });
      await new Promise(() => {});
    });
    const handle = await s.ready;
    expect((await getHealth(port)).status).toBe(503);
    expect(await waitFor(async () => (await getHealth(port)).status === 200, 5_000)).toBe(true);
    expect(probes).toBe(1);
    expect((handle.server.address() as AddressInfo).port).toBe(port);
    expect(existsSync(markerFile(port))).toBe(false);
    handle.server.close();
  });

  test('a failed full-app build releases the engine and keeps the status handler on the same socket', async () => {
    const port = await freePort();
    const { engine, calls } = fakeEngine();
    let probes = 0;
    const s = start(port, async () => (++probes === 1 ? engine : null), async () => { throw new Error('migration failed'); });
    const handle = await s.ready;
    expect(await waitFor(async () => calls.disconnect === 1, 5_000)).toBe(true);
    const health = await getHealth(port);
    expect(health.status).toBe(503);
    expect(JSON.parse(health.body).instance).toBe(handle.nonce);
    expect(JSON.parse(readFileSync(markerFile(port), 'utf8')).reason).toBe('brain_unopenable');
    await handle.shutdown();
    await s.done();
    expect(existsSync(markerFile(port))).toBe(false);
  });

  test('shutdown during a recovery waits for it, shuts down once and removes only its own marker', async () => {
    const [portA, portB] = await freePorts(2);
    const { engine, calls } = fakeEngine();
    let releaseBuild!: () => void;
    const building = new Promise<void>(r => { releaseBuild = r; });
    let built = false;
    const a = start(portA, async () => engine, async (_e, _a, o) => {
      built = true;
      await building;
      o.adoptServer.adopt(() => {});
    });
    const b = start(portB, async () => null);
    const [ha, hb] = [await a.ready, await b.ready];
    expect(existsSync(markerFile(portA)) && existsSync(markerFile(portB))).toBe(true);
    expect(await waitFor(async () => built, 5_000)).toBe(true);
    const stopping = ha.shutdown();
    const again = ha.shutdown();
    releaseBuild();
    await Promise.all([stopping, again]);
    await a.done();
    expect(calls.disconnect).toBe(1);
    expect(existsSync(markerFile(portA))).toBe(false);
    expect(existsSync(markerFile(portB))).toBe(true);
    await expect(getHealth(portA)).rejects.toThrow();
    expect((await getHealth(portB)).status).toBe(503);
    await hb.shutdown();
    await b.done();
    expect(existsSync(markerFile(portB))).toBe(false);
  });
});
