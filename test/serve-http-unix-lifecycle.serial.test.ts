import { expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { formatServeHttpBanner } from '../src/commands/serve-http-banner.ts';
import { assertPrivateSocketParent, listenPrivateHttp, closePrivateHttpSafely } from '../src/commands/serve-http-unix.ts';

const fixture = path.join(import.meta.dir, 'fixtures/private-http-lifecycle-server.ts');
const bootstrap = 'synthetic_private_http_bootstrap_0123456789';
function homeFixture() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uds-'));
  fs.chmodSync(home, 0o700);
  return { home, socket: path.join(home, 'http.sock'), clean: () => fs.rmSync(home, { recursive: true, force: true }) };
}
async function reservePort() {
  const server = http.createServer((_req, res) => res.end('occupied-fixture'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function start(home: string, port: number, closeFault?: 'callback-error') {
  // Allowlist, rather than copy, parent state: no real credentials, source overrides, or service URLs enter the child.
  const env = keylessBrainEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GBRAIN_PGLITE_SNAPSHOT: process.env.GBRAIN_PGLITE_SNAPSHOT }, home, {
    GBRAIN_HTTP_UNIX_SOCKET: path.join(home, 'http.sock'), GBRAIN_TEST_HTTP_PORT: String(port),
    GBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrap, GBRAIN_AUDIT_DIR: path.join(home, 'audit'),
    GBRAIN_SYNC_FAILURES_FILE: path.join(home, 'sync-failures.jsonl'),
    GBRAIN_TEST_PRIVATE_CLOSE_FAULT: closeFault,
  });
  const child = spawn(process.execPath, ['--no-env-file', fixture], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout!.resume();
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}
async function waitForReady(run: ReturnType<typeof start>, home: string) {
  const stopAt = Date.now() + 30_000;
  while (!fs.existsSync(path.join(home, 'ready.json'))) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`resident exited before readiness: ${run.stderr()}`);
    if (Date.now() >= stopAt) throw new Error(`resident readiness deadline: ${run.stderr()}`);
    await Bun.sleep(25);
  }
  return JSON.parse(fs.readFileSync(path.join(home, 'ready.json'), 'utf8')) as { ipcPath: string | null; baseline: number };
}
async function stop(run: ReturnType<typeof start>) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  // Only the child created by this fixture is terminated; no service discovery or broad process matching.
  run.child.kill('SIGKILL');
  await run.exited;
}
function request(target: { socketPath: string } | { hostname: string; port: number }, route: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ ...target, path: route, method: 'POST', agent: false,
      headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.setTimeout(5_000, () => req.destroy(new Error('fixture request deadline')));
    req.on('error', reject);
    req.end(body);
  });
}
const readMarker = (home: string, name: string) => JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));

// Value: protects=env-enabled TCP and UDS share real OAuth identity and orderly teardown; fails_when=env wiring or shared app/cleanup is removed;
// why_new=existing auth test manually builds a UDS listener; seam=none; no_claim=external tunnels and every scope/tenant restriction.
test.skipIf(process.platform === 'win32')('env-enabled resident shares OAuth identity across TCP and UDS and cleans up on SIGINT', async () => {
  const f = homeFixture();
  const port = await reservePort();
  await port.close();
  const run = start(f.home, port.port);
  try {
    const ready = await waitForReady(run, f.home);
    const uds = { socketPath: f.socket };
    const tcp = { hostname: '127.0.0.1', port: port.port };
    const rpcHeaders = { accept: 'application/json, text/event-stream' };
    for (const target of [uds, tcp]) {
      const denied = await request(target, '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), rpcHeaders);
      expect(denied.status).toBe(401);
    }
    const login = await request(uds, '/admin/login', JSON.stringify({ token: bootstrap }));
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    const registered = await request(uds, '/admin/api/register-client', JSON.stringify({ name: 'synthetic-dual-transport', scopes: 'read write', grantTypes: ['client_credentials'] }), { cookie });
    expect(registered.status).toBe(200);
    const client = JSON.parse(registered.body);
    const token = await request(tcp, '/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret, scope: 'read write' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
    expect(token.status).toBe(200);
    const auth = JSON.parse(token.body);
    expect(auth.scope.split(' ').sort()).toEqual(['read', 'write']);
    for (const target of [uds, tcp]) {
      const response = await request(target, '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }), { ...rpcHeaders, authorization: `Bearer ${auth.access_token}` });
      expect(response.status).toBe(200);
      const data = response.body.split('\n').find(line => line.startsWith('data:'));
      const rpc = JSON.parse(data ? data.slice(5) : response.body);
      expect(rpc.error).toBeUndefined();
      expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({ client_id: client.clientId, source_id: 'default', transport: 'oauth' });
    }
    expect(ready.ipcPath).not.toBeNull();
    expect(fs.existsSync(ready.ipcPath!)).toBe(true);
    expect(run.child.kill('SIGINT')).toBe(true);
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(readMarker(f.home, 'stopped.json')).toMatchObject({ remaining: ready.baseline, socketExists: false, ipcExists: false });
    expect(readMarker(f.home, 'disconnected.json').socketExistedAtDisconnect).toBe(false);
    expect(fs.existsSync(f.socket)).toBe(false);
    expect(fs.existsSync(ready.ipcPath!)).toBe(false);
    expect(run.stderr()).not.toContain(bootstrap);
  } finally { await stop(run); f.clean(); }
}, 60_000);

// Value: protects=TCP bind failure reaps the already-created UDS and registration; fails_when=outer private-listener finally is removed;
// why_new=existing occupied-port cases leave optional UDS disabled; seam=none; no_claim=uncatchable process crashes.
test.skipIf(process.platform === 'win32')('occupied TCP port closes the enabled UDS without disturbing the original TCP listener', async () => {
  const f = homeFixture();
  const held = await reservePort();
  const run = start(f.home, held.port);
  try {
    expect(await run.exited).toEqual({ code: 1, signal: null });
    const failed = readMarker(f.home, 'failed.json');
    expect(failed.code).toBe('serve_port_in_use');
    expect(failed.remaining).toBe(failed.baseline);
    expect(failed.socketExists).toBe(false);
    expect(readMarker(f.home, 'disconnected.json').socketExistedAtDisconnect).toBe(false);
    expect(fs.existsSync(f.socket)).toBe(false);
    expect((await request({ hostname: '127.0.0.1', port: held.port }, '/', '')).body).toBe('occupied-fixture');
  } finally { await stop(run); await held.close(); f.clean(); }
}, 60_000);

// Value: protects=real SIGTERM cleanup closes UDS before engine disconnect and reaps IPC; fails_when=optional listener skips abnormal cleanup;
// why_new=existing lifecycle tests use SIGINT or a manually closed helper; seam=none; no_claim=SIGKILL or injected close timeout.
test.skipIf(process.platform === 'win32')('SIGTERM closes the enabled private listener before the real engine disconnects', async () => {
  const f = homeFixture();
  const port = await reservePort();
  await port.close();
  const run = start(f.home, port.port);
  try {
    const ready = await waitForReady(run, f.home);
    expect(fs.existsSync(f.socket)).toBe(true);
    expect(ready.ipcPath).not.toBeNull();
    expect(fs.existsSync(ready.ipcPath!)).toBe(true);
    expect(run.child.kill('SIGTERM')).toBe(true);
    expect(await run.exited).toEqual({ code: 143, signal: null });
    expect(readMarker(f.home, 'disconnected.json').socketExistedAtDisconnect).toBe(false);
    expect(fs.existsSync(f.socket)).toBe(false);
    expect(fs.existsSync(ready.ipcPath!)).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'stopped.json'))).toBe(false);
  } finally { await stop(run); f.clean(); }
}, 60_000);

// Value: protects=banner hides env/suppressed secrets and preserves visible/DCR/port output; fails_when=renderer leaks a secret or mislabels policy;
// why_new=the previous 96-case byte comparison was not a retained test; seam=none; no_claim=caller TTY suppression-decision logic.
test('startup banner table keeps synthetic secrets hidden and renders explicit disclosure and DCR modes', () => {
  const secret = 'synthetic-banner-token-'.repeat(4);
  for (const port of [0, 3131, 65535]) for (const enableDcr of [false, true]) for (const enableDcrInsecure of [false, true])
  for (const bootstrapFromEnv of [false, true]) for (const suppressBootstrapPrint of [false, true]) {
    const banner = formatServeHttpBanner({ port, bind: '127.0.0.1', engine: 'pglite', issuerOrigin: 'https://example.test', clientCount: 0,
      enableDcr, enableDcrInsecure, skillBanner: 'not published', tokenTtl: 3600, bootstrapToken: secret, bootstrapFromEnv, suppressBootstrapPrint });
    const lines = banner.split('\n');
    expect(lines.find(line => line.startsWith('║  Port:'))).toBe(`║  Port:      ${String(port).padEnd(40)}║`);
    expect(banner).toContain(`http://localhost:${port}/mcp`);
    const dcr = enableDcr ? (enableDcrInsecure ? 'enabled (INSECURE: read-only M2M)' : 'enabled (consent; DCR max read write)') : 'disabled';
    expect(lines.find(line => line.startsWith('║  DCR:'))).toBe(`║  DCR:       ${dcr.padEnd(40)}║`);
    if (bootstrapFromEnv || suppressBootstrapPrint) {
      expect(banner).not.toContain(secret.substring(0, 50));
      expect(banner).not.toContain(secret.substring(50));
      expect(banner).toContain(bootstrapFromEnv ? 'Admin Token: from $GBRAIN_ADMIN_BOOTSTRAP_TOKEN' : 'Admin Token: hidden (non-TTY log-leak guard)');
    } else {
      expect(banner).toContain(`║  ${secret.substring(0, 50)}  ║`);
      expect(banner).toContain(`║  ${secret.substring(50).padEnd(50)}  ║`);
    }
  }
});

// Value: protects=private socket directories reject noncanonical paths and writable ancestors; fails_when=path/ancestor confinement is weakened;
// why_new=existing directory cases cover relative/symlink/final mode only; seam=none; no_claim=wrong-owner metadata or Windows paths.
test.skipIf(process.platform === 'win32')('private directory table refuses malformed and writable ancestry and accepts only the sticky private-child exception', () => {
  const f = homeFixture();
  // Canonical root-owned sticky temp is a real OS fixture, not mocked stat metadata.
  const sticky = fs.realpathSync('/tmp');
  const stickyChild = fs.mkdtempSync(path.join(sticky, 'gbrain-private-'));
  fs.chmodSync(stickyChild, 0o700);
  try {
    const middle = path.join(f.home, 'middle');
    const leaf = path.join(middle, 'private');
    fs.mkdirSync(leaf, { recursive: true, mode: 0o700 });
    for (const mode of [0o720, 0o702]) {
      fs.chmodSync(middle, mode);
      expect(() => assertPrivateSocketParent(path.join(leaf, 'http.sock'))).toThrow('unsafe_private_http_ancestor');
    }
    fs.chmodSync(middle, 0o700);
    for (const filename of ['', path.join(f.home, 'child') + '/../http.sock', f.socket + '/']) {
      expect(() => assertPrivateSocketParent(filename)).toThrow('private_http_requires_absolute_unix_path');
    }
    const nonDirectory = path.join(f.home, 'file');
    fs.writeFileSync(nonDirectory, 'preserve');
    expect(() => assertPrivateSocketParent(path.join(nonDirectory, 'http.sock'))).toThrow('unsafe_private_http_ancestor');
    expect(fs.readFileSync(nonDirectory, 'utf8')).toBe('preserve');
    const stickyStat = fs.statSync(sticky);
    expect(stickyStat.uid).toBe(0);
    expect(stickyStat.mode & 0o1000).toBe(0o1000);
    expect(() => assertPrivateSocketParent(path.join(stickyChild, 'http.sock'))).not.toThrow();
    fs.chmodSync(stickyChild, 0o755);
    expect(() => assertPrivateSocketParent(path.join(stickyChild, 'http.sock'))).toThrow('unsafe_private_http_ancestor');
  } finally {
    fs.chmodSync(stickyChild, 0o700);
    fs.rmSync(stickyChild, { recursive: true, force: true });
    f.clean();
  }
});

// Value: protects=UDS address chains stay empty and already-stopped listener cleanup resolves; fails_when=ips override or inactive close branch breaks;
// why_new=prior tests check ip and reuse only a cached close Promise; seam=none; no_claim=WeakRef collection timing.
test.skipIf(process.platform === 'win32')('UDS reports no forwarded address chain and first close after external shutdown resolves', async () => {
  const f = homeFixture();
  const listener = await listenPrivateHttp((req, res) => {
    const peer = req as http.IncomingMessage & { ip: string; ips: string[] };
    res.end(JSON.stringify({ ip: peer.ip, ips: peer.ips }));
  }, f.socket);
  try {
    const response = await request({ socketPath: f.socket }, '/', '', { 'x-forwarded-for': '203.0.113.10, 203.0.113.11' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ip: '127.0.0.1', ips: [] });
    await new Promise<void>((resolve, reject) => listener.server.close(error => error ? reject(error) : resolve()));
    expect(listener.server.listening).toBe(false);
    await expect(listener.close()).resolves.toBeUndefined();
    expect(fs.existsSync(f.socket)).toBe(false);
    const notices: string[] = [];
    await expect(closePrivateHttpSafely(null, message => notices.push(message))).resolves.toBeUndefined();
    expect(notices).toEqual([]);
  } finally { await listener.close(); f.clean(); }
});

// Value: protects=real listener close propagates callback failure and its actual deadline; fails_when=close ignores errors or never times out;
// why_new=prior timeout-named fake bypasses listener.close entirely; seam=none; no_claim=native callback-failure occurrence (public API fault injection).
test.skipIf(process.platform === 'win32')('listener close reports injected native callback errors and a withheld callback reaches its real deadline', async () => {
  for (const fault of ['callback-error', 'missing-callback'] as const) {
    const f = homeFixture();
    const listener = await listenPrivateHttp((_req, res) => res.end(), f.socket);
    const close = listener.server.close.bind(listener.server);
    const failure = new Error('synthetic-native-close-error');
    // Real native close still releases the OS listener. Only its completion callback is controlled.
    listener.server.close = function(callback) {
      return close(() => { if (fault === 'callback-error') callback?.(failure); });
    };
    try {
      const expected = fault === 'callback-error' ? failure : new Error('private_http_close_timeout');
      await expect(listener.close()).rejects.toThrow(expected.message);
      expect(listener.server.listening).toBe(false);
      expect(fs.existsSync(f.socket)).toBe(false);
    } finally {
      listener.server.close = close;
      if (listener.server.listening) await new Promise<void>(resolve => close(() => resolve()));
      f.clean();
    }
  }
}, 10_000);

// Value: protects=preflight/bind/chmod startup failures leave no UDS and permit retry; fails_when=non-ENOENT is swallowed or partial bind leaks;
// why_new=prior failures stop at preexisting-path checks; seam=none; no_claim=every OS error (chmod disappearance is orchestrated at fs boundary).
test.skipIf(process.platform === 'win32')('filesystem inspection, oversized bind and disappearing socket chmod all fail closed and permit a clean retry', async () => {
  const f = homeFixture();
  let listener: Awaited<ReturnType<typeof listenPrivateHttp>> | undefined;
  try {
    const denied = Object.assign(new Error('synthetic-lstat-access-denied'), { code: 'EACCES' });
    const lstat = fs.lstatSync.bind(fs);
    // Preserve actual ancestor inspection; inject only the socket-path inspection failure and require that exact error.
    const deniedSocket = spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === f.socket) throw denied;
      return lstat(...args);
    }) as typeof fs.lstatSync);
    try {
      const start = listenPrivateHttp((_req, res) => res.end(), f.socket).then(value => { listener = value; return value; });
      await expect(start).rejects.toBe(denied);
    } finally { deniedSocket.mockRestore(); }
    expect(fs.readdirSync(f.home)).toEqual([]);
    // Below NAME_MAX but above every supported Unix-domain socket path limit: this reaches listen, not lstat ENAMETOOLONG.
    await expect(listenPrivateHttp((_req, res) => res.end(), path.join(f.home, 's'.repeat(200)))).rejects.toThrow();
    expect(fs.readdirSync(f.home)).toEqual([]);
    const chmod = fs.chmodSync.bind(fs);
    const disappearingSocket = spyOn(fs, 'chmodSync').mockImplementation((filename, mode) => {
      if (filename === f.socket) fs.unlinkSync(f.socket);
      return chmod(filename, mode);
    });
    try {
      await expect(listenPrivateHttp((_req, res) => res.end(), f.socket)).rejects.toThrow('ENOENT');
    } finally { disappearingSocket.mockRestore(); }
    expect(fs.existsSync(f.socket)).toBe(false);
    listener = await listenPrivateHttp((_req, res) => res.end('retry-ok'), f.socket);
    expect((await request({ socketPath: f.socket }, '/', '')).body).toBe('retry-ok');
    await listener.close();
    expect(fs.readdirSync(f.home)).toEqual([]);
  } finally { await listener?.close(); f.clean(); }
}, 10_000);

// Value: protects=private-close rejection is logged without skipping actual engine/IPC shutdown; fails_when=optional close aborts resident teardown;
// why_new=prior cleanup-error test manually appends engine/ipc strings; seam=none; no_claim=native close fault occurrence (callback injection in child).
test.skipIf(process.platform === 'win32')('SIGTERM still disconnects the real engine and reaps IPC when private listener close rejects', async () => {
  const f = homeFixture();
  const port = await reservePort();
  await port.close();
  const run = start(f.home, port.port, 'callback-error');
  try {
    const ready = await waitForReady(run, f.home);
    expect(fs.existsSync(f.socket)).toBe(true);
    expect(ready.ipcPath).not.toBeNull();
    expect(fs.existsSync(ready.ipcPath!)).toBe(true);
    expect(run.child.kill('SIGTERM')).toBe(true);
    expect(await run.exited).toEqual({ code: 143, signal: null });
    expect(run.stderr()).toContain('GBrain private HTTP listener: close failed; continuing engine cleanup');
    expect(readMarker(f.home, 'disconnected.json').socketExistedAtDisconnect).toBe(false);
    expect(fs.existsSync(f.socket)).toBe(false);
    expect(fs.existsSync(ready.ipcPath!)).toBe(false);
  } finally { await stop(run); f.clean(); }
}, 60_000);
