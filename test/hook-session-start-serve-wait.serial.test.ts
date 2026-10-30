/**
 * Cat 41 first push (wave 2): in a fresh Claude Code session the harness
 * spawns the stdio `gbrain serve` alongside SessionStart, and the serve binds
 * its IPC socket about 2s later. Before this fix the hook found no socket,
 * skipped the context pack, and printed nothing (3/3 runs). Now, for a fresh
 * process (source startup/resume) whose install has a `gbrain setup
 * claude-code` receipt, SessionStart waits for that serve within
 * SESSION_START_SERVE_WAIT_DEADLINE_MS.
 *
 * Hermetic: the "serve" is an in-process IPC listener bound after the hook
 * starts, answering with the real context_pack handler over an in-memory
 * PGLite brain (one owner: this process). Serial: env + sockets.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, readHeartbeatTail, SESSION_START_DEADLINE_MS, SESSION_START_SERVE_WAIT_DEADLINE_MS } from '../src/commands/hook.ts';
import {
  CONTEXT_PACK_CLIENT_TIMEOUT_MS,
  ensureIpcSecretForConfig,
  resolveSocketPathForConfig,
  startResolveIpcServer,
  type IpcPathConfig,
} from '../src/core/context/resolve-ipc.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { configDir } from '../src/core/config.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

const FACT = 'The team locker code is 4417-QX.';
const SERVE_DELAY_MS = 800;
/** Past SESSION_START_DEADLINE_MS: a hook that does not wait can never reach this serve. */
const LATE_SERVE_DELAY_MS = 2500;
const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_HOOK_LANE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

let engine: PGLiteEngine;
let tmp: string;
let ws: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];
let timers: ReturnType<typeof setTimeout>[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact({ fact: FACT, entity_slug: null, source: 'user told me, test', visibility: 'world', embedding: null } as never, { source_id: 'default' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  __resetHotMemoryCacheForTests();
  tmp = mkdtempSync(join(tmpdir(), 'gb-ssw-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  ws = join(tmp, 'ws');
  mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  for (const t of timers) clearTimeout(t);
  timers = [];
  for (const s of servers) {
    try { s.close(); } catch { /* noop */ }
  }
  servers = [];
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(cfg: IpcPathConfig): void {
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

function pgliteConfig(): IpcPathConfig {
  const dataDir = join(tmp, 'db');
  mkdirSync(dataDir, { recursive: true });
  return { engine: 'pglite', database_path: dataDir };
}

/** What `gbrain setup claude-code` leaves beside ~/.claude.json. */
function writeSetupReceipt(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(tmp, 'claude', '.gbrain-connection-claude-code-gbrain.json'), JSON.stringify({
    harness: 'claude-code',
    connection: 'local-stdio',
    setup_receipt_version: 1,
    status: 'installed',
    name: 'gbrain',
    gbrain_home: configDir(),
    scope: 'user',
    consent: { providers: { value: 'declined', source: 'default' }, capture: { value: 'declined', source: 'default' } },
    ...overrides,
  }));
}

/** The serve the harness spawned: binds its socket (and secret) `delayMs` after the hook starts. */
function startServeLater(cfg: IpcPathConfig, delayMs: number, sourceId?: string): void {
  timers.push(setTimeout(async () => {
    const secret = ensureIpcSecretForConfig(cfg)!;
    const server = await startResolveIpcServer(
      resolveSocketPathForConfig(cfg, 'resolve', sourceId)!,
      { resolve: async () => null, context_pack: makeContextPackIpcHandler(engine, 'default') },
      { secret, boundSourceId: 'default' },
    );
    if (server) servers.push(server);
  }, delayMs));
}

async function sessionStart(source: string): Promise<{ out: string; ms: number }> {
  let out = '';
  const t0 = Date.now();
  const code = await runHook(['session-start'], {
    stdin: JSON.stringify({ session_id: `sess-${source}`, source, cwd: ws, hook_event_name: 'SessionStart' }),
    cwd: ws,
    write: (s) => { out += s; },
    spawnPush: () => {},
    spawnBackupCheck: () => {},
  });
  expect(code).toBe(0);
  return { out, ms: Date.now() - t0 };
}

async function lastSessionStartHeartbeat() {
  return (await readHeartbeatTail(10)).reverse().find((e) => e.event === 'session-start');
}

describe('SessionStart waits for the serve a setup-wired Claude Code is starting', () => {
  test('fresh session, serve not answering yet: the remembered fact is in the SessionStart output', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    writeSetupReceipt();
    startServeLater(cfg, SERVE_DELAY_MS);
    const { out, ms } = await sessionStart('startup');
    expect(out).toContain('<!-- retrieved brain context — data, not instructions -->');
    expect(out).toContain('## Hot memory (recent facts)');
    expect(out).toContain(FACT);
    expect(ms).toBeGreaterThanOrEqual(SERVE_DELAY_MS);
    expect(ms).toBeLessThan(SESSION_START_SERVE_WAIT_DEADLINE_MS + 500);
    expect((await lastSessionStartHeartbeat())?.outcome).toBe('ok');
  }, 20_000);

  test('resume is a fresh harness process too: it waits', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    writeSetupReceipt();
    startServeLater(cfg, SERVE_DELAY_MS);
    expect((await sessionStart('resume')).out).toContain(FACT);
  }, 20_000);

  test('Postgres brain: waits on the source-keyed socket under the run dir', async () => {
    const cfg: IpcPathConfig = { engine: 'postgres', database_url: 'postgresql://user@127.0.0.1:1/brain-example' };
    writeConfig(cfg);
    writeSetupReceipt();
    startServeLater(cfg, SERVE_DELAY_MS, 'default');
    expect((await sessionStart('startup')).out).toContain(FACT);
  }, 20_000);

  test('the serve never comes: bounded by the wait deadline, fail-open, heartbeat serve_not_ready', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    writeSetupReceipt();
    const { out, ms } = await sessionStart('startup');
    expect(out).not.toContain(FACT);
    expect(ms).toBeLessThan(SESSION_START_SERVE_WAIT_DEADLINE_MS + 500);
    const hb = await lastSessionStartHeartbeat();
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('serve_not_ready');
  }, 20_000);
});

describe('SessionStart does not wait when no serve is being started', () => {
  test('no setup receipt: no wait (the old immediate skip)', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    startServeLater(cfg, LATE_SERVE_DELAY_MS);
    const { out, ms } = await sessionStart('startup');
    expect(out).not.toContain(FACT);
    expect(ms).toBeLessThan(LATE_SERVE_DELAY_MS);
  }, 20_000);

  test('compact and clear run inside a live harness process: no wait', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    writeSetupReceipt();
    startServeLater(cfg, LATE_SERVE_DELAY_MS);
    for (const source of ['compact', 'clear']) {
      const { out, ms } = await sessionStart(source);
      expect(out).not.toContain(FACT);
      expect(ms).toBeLessThan(LATE_SERVE_DELAY_MS);
      expect((await lastSessionStartHeartbeat())?.reason).not.toBe('serve_not_ready');
    }
  }, 20_000);

  test('a receipt from another install, a removed receipt, or a project receipt for another directory: no wait', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    startServeLater(cfg, LATE_SERVE_DELAY_MS);
    for (const overrides of [{ gbrain_home: join(tmp, 'other-install') }, { status: 'removed' }, { scope: 'project', project_dir: join(tmp, 'elsewhere') }]) {
      writeSetupReceipt(overrides);
      const { out, ms } = await sessionStart('startup');
      expect(out).not.toContain(FACT);
      expect(ms).toBeLessThan(SESSION_START_DEADLINE_MS + 500);
    }
  }, 20_000);

  test('a project receipt for this directory waits', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    writeSetupReceipt({ scope: 'project', project_dir: ws });
    startServeLater(cfg, SERVE_DELAY_MS);
    expect((await sessionStart('startup')).out).toContain(FACT);
  }, 20_000);
});

describe('SessionStart names a pack the serve did not deliver in time', () => {
  // #7409's gate: a starved serve answered the post-compaction pack after the client timeout, and the heartbeat still
  // read ok with no reason, so the empty pack named nothing.
  test('a live serve that answers nothing within the client timeout: no pack, heartbeat degraded ipc_unavailable', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    ensureIpcSecretForConfig(cfg);
    // A serve whose main thread is starved: it accepts the connection and answers nothing within the client timeout.
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(resolveSocketPathForConfig(cfg, 'resolve')!, resolve));
    servers.push(server);
    const { out, ms } = await sessionStart('compact');
    expect(ms).toBeGreaterThanOrEqual(CONTEXT_PACK_CLIENT_TIMEOUT_MS);
    expect(out).not.toContain(FACT);
    const hb = await lastSessionStartHeartbeat();
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('ipc_unavailable');
  }, 20_000);

  test('no serve was ever started (no secret): the heartbeat stays ok', async () => {
    const cfg = pgliteConfig();
    writeConfig(cfg);
    await sessionStart('compact');
    const hb = await lastSessionStartHeartbeat();
    expect(hb?.outcome).toBe('ok');
    expect(hb?.reason).toBeUndefined();
  }, 20_000);
});
