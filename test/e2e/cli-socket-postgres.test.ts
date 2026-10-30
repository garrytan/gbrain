/**
 * The opt-in warm CLI socket against a real Postgres brain: a `gbrain serve
 * --cli-socket` answers CLI search/query/get/recall with the cold path's exact
 * bytes and exit code in far fewer database round trips, writes never use it,
 * a CLI bound to another config or another behavior env is refused by the
 * identity handshake, a serve on a mount brain never answers the host CLI and
 * a dead serve falls back to the cold path. Runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromContent } from '../../src/core/import-file.ts';
import { cliSocketIdentity } from '../../src/core/cli-socket/identity.ts';
import { exchangeCliSocket } from '../../src/cli/cli-socket-client.ts';
import { VERSION } from '../../src/version.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const WORD = 'zephyrquartz';

interface Run { stdout: string; stderr: string; exitCode: number }

describe.skipIf(!DATABASE_URL)('warm CLI socket (postgres)', () => {
  let home: string;
  let env: Record<string, string>;
  let socketPath: string;
  let configFile: string;
  let databaseUrl: string;
  let close: (() => Promise<void>) | undefined;
  let serve: ChildProcess | null = null;
  let serveLog = '';
  let traceSeq = 0;
  let serveTrace = '';
  const cold = new Map<string, Run>();

  const READS: Record<string, string[]> = {
    search: ['search', WORD],
    'search --json': ['search', WORD, '--json'],
    query: ['query', WORD],
    'query --json': ['query', WORD, '--json'],
    get: ['get', 'notes/alpha-example'],
    'get --json': ['get', 'notes/alpha-example', '--json'],
    'get missing': ['get', 'notes/missing-example'],
    'recall --query': ['recall', '--query', WORD],
    'recall --query --json': ['recall', '--query', WORD, '--json'],
  };

  async function cli(args: string[], extra: Record<string, string> = {}): Promise<Run> {
    const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', ...args], {
      cwd: process.cwd(), env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  /** The [AGENT] block a refused non-JSON call prints on stdout before the cold path's output. */
  function refusedNotice(part: string): string {
    const why = `[socket_identity_mismatch] The running serve's warm CLI socket refused this call because ${part} differs from the serve's (the value is never shown), so it ran on the slower cold path. Every call from this environment does until that part matches the serve's.`;
    return `[AGENT]\nwhy: ${why}\nactor: agent\nnext: run: gbrain doctor --only cli_socket_refusals --json --brain host\n[/AGENT]\n`;
  }

  function traceFile(): string { return join(home, `trace-${traceSeq++}.jsonl`); }
  function tripLines(file: string): string[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(line => line && !line.includes('"kind":"connect"'));
  }
  function roundTrips(file: string): number { return tripLines(file).length; }

  async function startServe(args: string[], extra: Record<string, string> = {}): Promise<ChildProcess> {
    serveLog = '';
    const child = spawn('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', ...args], { cwd: process.cwd(), env: { ...env, ...extra }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr!.on('data', data => { serveLog += String(data); });
    for (let i = 0; i < 240 && !serveLog.includes('Starting GBrain MCP server'); i++) await Bun.sleep(250);
    expect(serveLog).toContain('Starting GBrain MCP server');
    return child;
  }

  async function stopServe(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = serve;
    serve = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      child.kill(signal);
    });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-cli-socket-'));
    const isolated = await isolatedPersistencePostgres(DATABASE_URL!);
    close = isolated.close;
    databaseUrl = isolated.databaseUrl;
    for (const [slug, body] of [['notes/alpha-example', `${WORD} alpha synthetic page for the warm socket.`], ['notes/beta-example', `Beta page mentions ${WORD} twice: ${WORD}.`]] as const) {
      await importFromContent(isolated.engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n\n${body}\n`, {
        sourceId: 'default', noEmbed: true,
        prepare: async prepared => { await withManagedFixtureWrite(isolated.engine, ['default'], tx => prepared.apply(tx)); return prepared.result; },
      });
    }
    // A second source, so a CLI's GBRAIN_SOURCE visibly changes what a search answers.
    await isolated.engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('source-b', 'source-b', '{}'::jsonb)`);
    await importFromContent(isolated.engine, 'notes/gamma-example', `---\ntitle: notes/gamma-example\ntype: note\n---\n\n${WORD} gamma page in source-b.\n`, {
      sourceId: 'source-b', noEmbed: true,
      prepare: async prepared => { await withManagedFixtureWrite(isolated.engine, ['source-b'], tx => prepared.apply(tx)); return prepared.result; },
    });
    await isolated.engine.disconnect();
    mkdirSync(join(home, '.gbrain'));
    configFile = join(home, '.gbrain', 'config.json');
    writeFileSync(configFile, JSON.stringify({ engine: 'postgres', database_url: databaseUrl }));
    socketPath = join(home, '.gbrain', 'run', 'cli.sock');
    env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined, GBRAIN_SOURCE: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_NO_RETRY_CONNECT: '1', GBRAIN_DEBUG: undefined,
      // A provider endpoint no recipe here uses: the serve and every CLI share it, so a CLI pointing elsewhere must be refused.
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    // Two warm-up calls absorb one-time notices so the cold baseline is steady state.
    await cli(['search', 'warmup']);
    await cli(['search', 'warmup']);
    for (const [name, args] of Object.entries(READS)) cold.set(name, await cli(args));
  }, 180_000);

  afterAll(async () => {
    await stopServe('SIGKILL');
    await close?.();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('off by default: a serve without --cli-socket or serve.cli_socket binds no socket', async () => {
    serve = await startServe([]);
    await Bun.sleep(3_000);
    expect(existsSync(socketPath)).toBe(false);
    expect(serveLog).not.toContain('cli-socket');
    await stopServe();
  }, 90_000);

  test('without a socket, GBRAIN_DEBUG names the missing socket and the read runs cold', async () => {
    expect(existsSync(socketPath)).toBe(false);
    const run = await cli(READS.search!, { GBRAIN_DEBUG: '1' });
    expect(run.stderr).toContain(`[cli-socket] cold path: no socket at ${socketPath}; start the serve with gbrain serve --cli-socket or set serve.cli_socket true`);
    expect(run.stderr).not.toContain('[cli-socket] warm:');
    expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: cold.get('search')!.stdout, exitCode: cold.get('search')!.exitCode });
  }, 90_000);

  test('serve.cli_socket true opens it without the flag (read from the connect-time config merge)', async () => {
    expect((await cli(['config', 'set', 'serve.cli_socket', 'true'])).exitCode).toBe(0);
    try {
      serve = await startServe([]);
      for (let i = 0; i < 120 && !serveLog.includes('cli-socket: listening'); i++) await Bun.sleep(250);
      expect(serveLog).toContain('cli-socket: listening');
      await stopServe();
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      expect((await cli(['config', 'set', 'serve.cli_socket', 'false'])).exitCode).toBe(0);
    }
  }, 90_000);

  test('serve --cli-socket binds a 0600 socket in a 0700 run directory', async () => {
    serveTrace = join(home, 'serve-trace.jsonl');
    serve = await startServe(['--cli-socket'], { GBRAIN_SQL_TRACE: serveTrace });
    for (let i = 0; i < 120 && !serveLog.includes('cli-socket: listening'); i++) await Bun.sleep(250);
    expect(serveLog).toContain('cli-socket: listening');
    const { statSync, lstatSync } = await import('node:fs');
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.gbrain', 'run')).mode & 0o777).toBe(0o700);
  }, 90_000);

  test('search, query, get and recall print the cold path\'s exact bytes and exit code through the socket', async () => {
    expect(existsSync(socketPath)).toBe(true);
    for (const [name, args] of Object.entries(READS)) {
      const warm = await cli(args, { GBRAIN_DEBUG: '1' });
      expect(warm.stderr, `${name} took the cold path`).not.toContain('[cli-socket] cold path');
      expect(warm.stderr).toContain(`[cli-socket] warm: ${args[0]} answered by the serve socket at ${socketPath}\n`);
      const expected = cold.get(name)!;
      const output = { ...warm, stderr: warm.stderr.replace(`[cli-socket] warm: ${args[0]} answered by the serve socket at ${socketPath}\n`, '') };
      expect({ name, ...output }).toEqual({ name, ...expected });
    }
    expect(cold.get('get missing')!.exitCode).not.toBe(0);
  }, 180_000);

  test('a warm read opens no database connection in the CLI, reads config once in one statement, and costs the serve fewer round trips than a cold call', async () => {
    const coldTrace = traceFile();
    const coldStarted = performance.now();
    const coldRun = await cli(['search', WORD], { GBRAIN_SQL_TRACE: coldTrace, GBRAIN_CLI_SOCKET: '0' });
    const coldMs = performance.now() - coldStarted;
    const warmCli = traceFile();
    await Bun.sleep(1_500);
    const serveBefore = roundTrips(serveTrace);
    const started = performance.now();
    const warmRun = await cli(['search', WORD], { GBRAIN_SQL_TRACE: warmCli });
    const warmMs = performance.now() - started;
    await Bun.sleep(1_500);
    const requestTrips = tripLines(serveTrace).slice(serveBefore);
    const serveTrips = requestTrips.length;
    expect(warmRun.stdout).toBe(coldRun.stdout);
    expect(roundTrips(warmCli)).toBe(0);
    const coldTrips = roundTrips(coldTrace);
    console.error(`[cli-socket e2e] search round trips: cold CLI ${coldTrips}; warm CLI ${roundTrips(warmCli)} + serve ${serveTrips} (${Math.round(warmMs)} ms wall; cold ${Math.round(coldMs)} ms)`);
    expect(coldTrips).toBeGreaterThan(10);
    // The request's config snapshot: one bulk read of the config table, and no per-key config read at all.
    expect(requestTrips.filter(line => /FROM config WHERE key/i.test(line))).toEqual([]);
    expect(requestTrips.filter(line => /SELECT key, value FROM config/i.test(line)).length).toBe(1);
    expect(serveTrips).toBeLessThan(coldTrips);
  }, 90_000);

  test('a write never goes through the socket', async () => {
    const trace = traceFile();
    const run = await cli(['tag', 'notes/alpha-example', 'tag-example'], { GBRAIN_SQL_TRACE: trace, GBRAIN_DEBUG: '1' });
    expect(run.stderr).not.toContain('[cli-socket]');
    expect(roundTrips(trace)).toBeGreaterThan(0);
  }, 90_000);

  test('a CLI bound to a different config or GBRAIN_HOME is refused by the handshake and falls back', async () => {
    const original = readFileSync(configFile, 'utf8');
    writeFileSync(configFile, JSON.stringify({ ...JSON.parse(original), search_mode_note: 'edited-after-bind' }));
    try {
      const run = await cli(READS.search!, { GBRAIN_DEBUG: '1' });
      expect(run.stderr).toContain('[cli-socket] cold path: refused (identity_mismatch): config contents');
      expect(run.stdout).toBe(refusedNotice('config contents') + cold.get('search')!.stdout);
      expect(run.exitCode).toBe(0);
    } finally {
      writeFileSync(configFile, original);
    }
    const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-socket-other-'));
    mkdirSync(join(otherHome, '.gbrain'));
    writeFileSync(join(otherHome, '.gbrain', 'config.json'), original);
    const identity = cliSocketIdentity({ config: { engine: 'postgres', database_url: databaseUrl }, brainId: 'host', configDir: join(otherHome, '.gbrain'), configFile: join(otherHome, '.gbrain', 'config.json'), version: VERSION, env });
    const outcome = await exchangeCliSocket(socketPath, { v: 1, identity, command: 'search', kind: 'op', op: 'search', params: { query: WORD },
      routing: { cwd: process.cwd(), source_env: null }, cli: { quiet: false, timeout_ms: null } }, 30_000);
    expect(outcome).toEqual({ reason: 'refused (identity_mismatch): config home' });
    rmSync(otherHome, { recursive: true, force: true });
  }, 90_000);

  test('a CLI whose behavior env differs from the serve\'s (GBRAIN_* settings, provider keys present, a provider endpoint value) is refused and falls back', async () => {
    const extras: Array<[Record<string, string>, string]> = [[{ GBRAIN_CONTRIBUTOR_MODE: '1' }, 'env GBRAIN_CONTRIBUTOR_MODE'], [{ VOYAGE_API_KEY: 'synthetic-fixture-value' }, 'provider key VOYAGE_API_KEY'],
      [{ LMSTUDIO_BASE_URL: 'https://lmstudio.acme-example.test/v1' }, 'env LMSTUDIO_BASE_URL']];
    for (const [extra, part] of extras) {
      const run = await cli(READS.search!, { GBRAIN_DEBUG: '1', ...extra });
      expect(run.stderr).toContain(`[cli-socket] cold path: refused (identity_mismatch): ${part}`);
      expect(run.stdout).toBe(refusedNotice(part) + cold.get('search')!.stdout);
    }
    // GBRA-156: without GBRAIN_DEBUG the refusal is still printed (an [AGENT] block on a non-TTY stdout; stderr under --json).
    const quiet = await cli(READS.search!, { GBRAIN_CONTRIBUTOR_MODE: '1' });
    expect(quiet.stdout).toBe(refusedNotice('env GBRAIN_CONTRIBUTOR_MODE') + cold.get('search')!.stdout);
    const quietJson = await cli(READS['search --json']!, { GBRAIN_CONTRIBUTOR_MODE: '1' });
    expect(quietJson.stdout).toBe(cold.get('search --json')!.stdout);
    expect(quietJson.stderr).toContain('[socket_identity_mismatch]');
  }, 90_000);

  test('a variable of a provider neither side can call (an Azure API version, no Azure endpoint) no longer refuses: answered warm', async () => {
    const trace = traceFile();
    const run = await cli(READS.search!, { GBRAIN_DEBUG: '1', GBRAIN_SQL_TRACE: trace, AZURE_OPENAI_API_VERSION: '2024-10-21', OPENAI_ORG_ID: 'org-example' });
    expect(run.stderr).not.toContain('[cli-socket] cold path');
    expect(roundTrips(trace)).toBe(0);
    expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: cold.get('search')!.stdout, exitCode: 0 });
  }, 90_000);

  test('a request that reaches its round-trip cap answers a retryable timeout error (not a cold rerun), and its slot is free again', async () => {
    const identity = cliSocketIdentity({ config: { engine: 'postgres', database_url: databaseUrl }, brainId: 'host', configDir: join(home, '.gbrain'), configFile, version: VERSION, env });
    const capped = await exchangeCliSocket(socketPath, { v: 1, identity, command: 'search', kind: 'op', op: 'search', params: { query: WORD },
      routing: { cwd: process.cwd(), source_env: null }, cli: { quiet: false, timeout_ms: 1 } }, 30_000);
    expect(capped).toMatchObject({ frame: { kind: 'error', error: { code: 'timeout', reason: 'cli_socket_round_trip_cap', retryable: true } } });
    const run = await cli(['search', WORD, '--timeout=1ms']);
    expect(run.exitCode).toBe(124);
    expect(run.stdout).toContain('[AGENT]');
    expect(run.stdout).toContain('[timeout] gbrain search did not finish within 1 ms on the warm CLI socket');
    const after = await cli(READS.search!, { GBRAIN_DEBUG: '1' });
    expect(after.stderr).not.toContain('[cli-socket] cold path');
    expect(after.stdout).toBe(cold.get('search')!.stdout);
  }, 90_000);

  test('a CLI that differs only in connection sizing and driver-only URL parameters is answered warm', async () => {
    const lane = `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}prepare=false&application_name=cli-lane-example`;
    const trace = traceFile();
    const run = await cli(READS.search!, { GBRAIN_DEBUG: '1', GBRAIN_SQL_TRACE: trace, GBRAIN_POOL_SIZE: '3', GBRAIN_DIRECT_POOL_SIZE: '1', GBRAIN_DATABASE_URL: lane });
    expect(run.stderr).not.toContain('[cli-socket] cold path');
    expect(roundTrips(trace)).toBe(0);
    expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: cold.get('search')!.stdout, exitCode: 0 });
  }, 90_000);

  test('a CLI that resolves the same home through HOME, without the serve\'s GBRAIN_HOME, is answered warm', async () => {
    const trace = traceFile();
    const run = await cli(READS.search!, { GBRAIN_DEBUG: '1', GBRAIN_SQL_TRACE: trace, GBRAIN_HOME: '' });
    expect(run.stderr).not.toContain('[cli-socket] cold path');
    expect(roundTrips(trace)).toBe(0);
    expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: cold.get('search')!.stdout, exitCode: 0 });
  }, 90_000);

  test('a CLI with its own GBRAIN_SOURCE is answered warm, with that source applied', async () => {
    const coldB = await cli(['search', WORD], { GBRAIN_CLI_SOCKET: '0', GBRAIN_SOURCE: 'source-b' });
    expect(coldB.stdout).toContain('notes/gamma-example');
    expect(coldB.stdout).not.toBe(cold.get('search')!.stdout);
    const warmB = await cli(['search', WORD], { GBRAIN_DEBUG: '1', GBRAIN_SOURCE: 'source-b' });
    expect(warmB.stderr).not.toContain('[cli-socket] cold path');
    expect({ stdout: warmB.stdout, exitCode: warmB.exitCode }).toEqual({ stdout: coldB.stdout, exitCode: coldB.exitCode });
  }, 90_000);

  test('a killed serve leaves a stale socket that falls back silently', async () => {
    await stopServe('SIGKILL');
    expect(existsSync(socketPath)).toBe(true);
    const quiet = await cli(READS.search!);
    expect(quiet).toEqual(cold.get('search')!);
    const noisy = await cli(READS.search!, { GBRAIN_DEBUG: '1' });
    expect(noisy.stderr).toContain('[cli-socket] cold path: connect_failed');
    expect(noisy.stdout).toBe(cold.get('search')!.stdout);
  }, 90_000);

  test('a serve on a mount brain never answers the host CLI with the mount\'s data', async () => {
    const mountWord = 'quillmountword';
    const mount = await isolatedPersistencePostgres(DATABASE_URL!);
    const mountsFile = join(home, '.gbrain', 'mounts.json');
    try {
      await importFromContent(mount.engine, 'notes/mount-only-example', `---\ntitle: notes/mount-only-example\ntype: note\n---\n\n${mountWord} lives only in the mount.\n`, {
        sourceId: 'default', noEmbed: true,
        prepare: async prepared => { await withManagedFixtureWrite(mount.engine, ['default'], tx => prepared.apply(tx)); return prepared.result; },
      });
      await mount.engine.disconnect();
      const checkout = join(home, 'mnt-checkout');
      mkdirSync(checkout, { recursive: true });
      writeFileSync(mountsFile, JSON.stringify({ version: 1, mounts: [{ id: 'mnt', path: checkout, engine: 'postgres', database_url: mount.databaseUrl }] }));
      const coldHost = await cli(['search', mountWord], { GBRAIN_CLI_SOCKET: '0' });
      expect(coldHost.stdout).not.toContain('mount-only-example');
      const viaMount = await cli(['--brain', 'mnt', 'search', mountWord], { GBRAIN_CLI_SOCKET: '0' });
      expect(viaMount.stdout).toContain('notes/mount-only-example');
      serve = await startServe(['--brain', 'mnt', '--cli-socket']);
      for (let i = 0; i < 120 && !serveLog.includes('cli-socket: '); i++) await Bun.sleep(250);
      const warmHost = await cli(['search', mountWord], { GBRAIN_DEBUG: '1' });
      expect(warmHost.stdout).toBe(coldHost.stdout);
      expect(warmHost.exitCode).toBe(coldHost.exitCode);
      expect(warmHost.stderr).toContain('[cli-socket] cold path:');
      expect(serveLog).toContain('cli-socket: not started: this serve is on mount brain "mnt"');
    } finally {
      await stopServe();
      rmSync(mountsFile, { force: true });
      await mount.close();
    }
  }, 180_000);
});
