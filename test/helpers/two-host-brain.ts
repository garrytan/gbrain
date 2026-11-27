/**
 * Two gbrain hosts on one machine, as M1 runs them (docs/designs/rust-engine/multi-user-server.md, "M1 as built"):
 *
 *  - the server host: its own home, a Rust brain it owns (`engine: 'rust'`, `database_path`), `GBRAIN_RUST_MULTIUSER=1`,
 *    and `gbrain serve` started with `GBRAIN_RUST_SERVER_LISTEN=<interface address>:0` plus a throwaway self-signed TLS
 *    certificate whose SAN is that address. The address is a non-loopback address of this machine, so the client
 *    reaches the server the way another machine would (the listener refuses a non-loopback address without TLS);
 *  - the client host: a second home with no brain of its own, whose config names the server in `rust_server.url`
 *    (`gbrain+tls://<address>:<port>`), the token's variable in `token_env`, and the certificate in `ca_file`.
 *
 * Every command is the real CLI (`src/cli.ts`) in its own child process with the real addon. The owner server token is
 * minted with `gbrain auth create <name> --rust-server-owner` on the server host before the serve starts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
export const TWO_HOST_ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
export const HAVE_TWO_HOST_ADDON = !!TARGET && existsSync(TWO_HOST_ADDON);

/** The first IPv4 address of this machine that is not a loopback address, or null when it has none. */
export function interfaceAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('127.')) return a.address;
  }
  return null;
}

/** A one-day self-signed certificate whose SAN is the IP `address`; returns the PEM file paths. */
export function selfSignedCert(dir: string, address: string): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', `/CN=${address}`, '-addext', `subjectAltName=IP:${address}`, '-keyout', key, '-out', cert], { stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`openssl could not make the test certificate: ${run.stderr.toString()}`);
  return { cert, key };
}

export interface CliRun { exitCode: number; stdout: string; stderr: string }
export type HostName = 'server' | 'client';

export interface TwoHostBrain {
  root: string;
  /** The non-loopback interface address the server listens on. */
  address: string;
  port: number;
  /** `<address>:<port>`: what GBRAIN_RUST_SERVER_LISTEN names once the port is known. */
  listen: string;
  url: string;
  token: string;
  /** The server brain's persistence brain id, read embedded before the serve started. */
  brainId: string;
  tls: { cert: string; key: string; certPem: Buffer };
  serverHome: string;
  clientHome: string;
  /** Runs the real CLI on one host (the server host as a second local process while the serve runs). */
  cli(host: HostName, args: string[]): Promise<CliRun>;
  /** The serve's stderr so far (never carries the token). */
  serveLog(): string;
  /** Stops `gbrain serve` and keeps every file: the brain, the token and the certificate stay for `restartServer`. */
  stopServer(): Promise<void>;
  /** Starts `gbrain serve` again on the same address and port, over the same brain; resolves once it listens. */
  restartServer(): Promise<void>;
  /** Stops the serve and removes every file of both hosts. */
  stop(): Promise<void>;
}

function writeConfig(home: string, config: Record<string, unknown>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
}

function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_RUST_MULTIUSER|GBRAIN_RUST_SERVER_\w+)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', TZ: 'UTC',
    GBRAIN_RUST_MULTIUSER: '1', ...extra };
}

/** Starts the two hosts; throws with the step that failed. The caller must call `stop()`. */
export async function startTwoHostBrain(opts: { address?: string } = {}): Promise<TwoHostBrain> {
  const address = opts.address ?? interfaceAddress();
  if (!address) throw new Error('this machine has no non-loopback IPv4 address to serve on');
  const root = mkdtempSync(join(tmpdir(), 'gb-two-host-'));
  const serverHome = join(root, 'server', 'home');
  const clientHome = join(root, 'client', 'home');
  const tlsDir = join(root, 'tls');
  mkdirSync(tlsDir, { recursive: true });
  const files = selfSignedCert(tlsDir, address);
  const tls = { ...files, certPem: readFileSync(files.cert) };
  writeConfig(serverHome, { engine: 'rust', database_path: join(root, 'server', 'db') });

  let token = '';
  const serverEnv = (extra: Record<string, string> = {}) => childEnv(serverHome, { GBRAIN_RUST_ENGINE_ADDON: TWO_HOST_ADDON, ...extra });
  // The client has no brain and no addon: it reaches the brain through the server only.
  const clientEnv = () => childEnv(clientHome, { GBRAIN_RUST_SERVER_TOKEN: token });
  const cli = async (host: HostName, args: string[]): Promise<CliRun> => {
    const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: host === 'server' ? serverEnv() : clientEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
  const must = async (host: HostName, args: string[]): Promise<CliRun> => {
    const r = await cli(host, args);
    if (r.exitCode !== 0) throw new Error(`${host}: gbrain ${args.join(' ')} exited ${r.exitCode}: ${r.stderr.slice(-1500)}`);
    return r;
  };

  let serve: ReturnType<typeof Bun.spawn> | undefined;
  let log = '';
  const stopServer = async () => {
    const running = serve;
    serve = undefined;
    if (!running) return;
    try { (running.stdin as { end?: () => void } | undefined)?.end?.(); } catch { /* closed */ }
    try { running.kill(); } catch { /* gone */ }
    await Promise.race([running.exited, Bun.sleep(10_000)]);
  };
  const stop = async () => {
    await stopServer();
    rmSync(root, { recursive: true, force: true });
  };
  /** Starts the serve on `port` (0: any free port) and returns the port it listens on. */
  const startServe = async (port: number): Promise<number> => {
    const proc = Bun.spawn(['bun', 'run', CLI, 'serve'], {
      cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: serverEnv({ GBRAIN_RUST_SERVER_LISTEN: `${address}:${port}`, GBRAIN_RUST_SERVER_TLS_CERT: tls.cert, GBRAIN_RUST_SERVER_TLS_KEY: tls.key }),
    });
    serve = proc;
    void new Response(proc.stdout as ReadableStream).text();
    const from = log.length;
    return readPort(proc, chunk => { log += chunk; }, () => log.slice(from));
  };
  let listenPort = 0;
  const restartServer = async () => {
    if (!listenPort) throw new Error('restartServer: the server never listened');
    await stopServer();
    const port = await startServe(listenPort);
    if (port !== listenPort) throw new Error(`restartServer: gbrain serve listens on ${port}, not ${listenPort}`);
  };
  try {
    // The server brain exists before the serve: one page written embedded, then its id and the owner token.
    await must('server', ['put', 'notes/two-host-seed', '--content', '---\ntype: note\ntitle: Seed\n---\nWritten on the server host.\n', '--json']);
    const brainId = await readBrainId(root, serverEnv());
    const minted = await must('server', ['auth', 'create', 'two-host', '--rust-server-owner']);
    token = /gbrain_[A-Za-z0-9_-]+/.exec(minted.stdout)?.[0] ?? '';
    if (!token) throw new Error('auth create --rust-server-owner printed no token');

    const port = await startServe(0);
    listenPort = port;
    const url = `gbrain+tls://${address}:${port}`;
    writeConfig(clientHome, { engine: 'rust', rust_server: { url, token_env: 'GBRAIN_RUST_SERVER_TOKEN', ca_file: tls.cert } });
    return { root, address, port, listen: `${address}:${port}`, url, token, brainId, tls, serverHome, clientHome, cli, serveLog: () => log, stopServer, restartServer, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Reads the server brain's persistence brain id embedded (a short child script; no serve runs yet). */
async function readBrainId(root: string, env: Record<string, string>): Promise<string> {
  const script = join(root, 'read-brain-id.ts');
  writeFileSync(script, `
    import { loadConfig, toEngineConfig } from ${JSON.stringify(join(ROOT, 'src/core/config.ts'))};
    import { createEngine } from ${JSON.stringify(join(ROOT, 'src/core/engine-factory.ts'))};
    const config = toEngineConfig(loadConfig()!);
    const engine = await createEngine(config);
    await engine.connect(config);
    const id = await engine.readPersistenceBrainId();
    await engine.disconnect();
    console.log('BRAIN_ID=' + id);
  `);
  const proc = Bun.spawn(['bun', 'run', script], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const id = /BRAIN_ID=([0-9a-f-]{36})/.exec(out)?.[1];
  if (code !== 0 || !id) throw new Error(`reading the brain id failed (${code}): ${out}\n${err.slice(-1500)}`);
  return id;
}

async function readPort(proc: ReturnType<typeof Bun.spawn>, onChunk: (s: string) => void, text: () => string): Promise<number> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value));
    }
  })();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const hit = /brain server listening on [\d.]+:(\d+) \(TLS/.exec(text());
    if (hit) return Number(hit[1]);
    if (proc.exitCode !== null) throw new Error(`gbrain serve exited ${proc.exitCode} before listening:\n${text().slice(-2000)}`);
    await Bun.sleep(100);
  }
  throw new Error(`gbrain serve did not print its TLS listening line in 90 s:\n${text().slice(-2000)}`);
}
