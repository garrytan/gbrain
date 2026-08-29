/**
 * GBRAIN_SERVE_SYNC_IPC='0' kill switch — both halves of the contract.
 *
 * Lane 1 — the ENV GATE itself (src/mcp/server.ts). The env is read at serve
 * boot (call-time, inside startMcpServer's resolve-IPC block), and
 * startMcpServer cannot run in-process (its StdioServerTransport attaches to
 * the REAL process.stdin and its shutdown chain ends in process.exit — a
 * stdin EOF would silently kill the test runner). So a child process boots
 * the REAL startMcpServer (bun -e driver: real in-memory PGLite engine + a
 * tmp GBRAIN_HOME config whose database_path anchors the socket/secret).
 * With the switch set, the listener that WOULD have registered the sync
 * kinds answers sync_start/sync_status/sync_abort with unsupported_kind
 * while resolve + turn_context still work. A CONTROL child without the
 * switch answers sync_status with unknown_job — this kills the vacuity
 * class where a broken serve-sync-runner import (whose catch ALSO yields
 * handler-absent → unsupported_kind) would masquerade as the kill switch.
 * The stub-composition analog (handler map without sync kinds →
 * unsupported_kind) is pinned in test/context/resolve-ipc-sync-kinds.test.ts
 * and deliberately NOT duplicated here.
 *
 * Lane 2 — the CLIENT ladder mapping (src/commands/sync-delegate.ts). On
 * unsupported_kind the delegate client prints the documented remediation
 * ("sync delegation disabled (GBRAIN_SERVE_SYNC_IPC=0 or a startup
 * failure)"), sets exit verdict 1, and returns true (HANDLED). true is the
 * no-fall-through contract: cli.ts `return`s on it (src/cli.ts sync
 * pre-connect hook), so the client can never proceed to a direct in-process
 * sync against a brain a live serve still holds.
 *
 * Serial: spawns bun subprocesses that boot PGLite WASM, and the ladder lane
 * mutates env (withEnv) + the CLI exit verdict / process.exitCode.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  IPC_UNAVAILABLE,
  ensureIpcSecret,
  ipcSecretPath,
  readIpcSecret,
  requestSyncAbort,
  requestSyncStart,
  requestSyncStatus,
  requestTurnContext,
  resolveSocketPath,
  resolveViaIpc,
  startResolveIpcServer,
  type TurnContextResponse,
} from '../src/core/context/resolve-ipc.ts';
import type { SyncStartResponse, SyncStatusResponse } from '../src/core/context/sync-ipc.ts';
import { maybeDelegateSyncToServe } from '../src/commands/sync-delegate.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

const cleanupDirs: string[] = [];
const killers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const kill of killers.splice(0)) { try { await kill(); } catch { /* dead */ } }
  for (const d of cleanupDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Env the child must NOT inherit (a dev/CI DATABASE_URL would flip engines;
 * ambient brain/source/opt-out vars would perturb the serve's resolution). */
const CHILD_STRIP = [
  'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE',
  'GBRAIN_SYNC_NO_DELEGATE', 'GBRAIN_HOOKS', 'GBRAIN_SERVE_SYNC_IPC',
];

interface DriverServe {
  sock: string;
  secret: string;
  stderrText: () => string;
}

/**
 * Boot the REAL startMcpServer in a child process. In-memory PGLite engine
 * (snapshot-eligible, fast) + a tmp config whose database_path exists only to
 * anchor the IPC socket + secret — the resolve-IPC block reads
 * loadConfig().database_path for those paths and uses the passed engine for
 * every handler. stdin is a held-open silent pipe (the MCP stdio transport
 * reads it; EOF would trigger the shutdown chain).
 */
async function bootDriverServe(extraEnv: Record<string, string>): Promise<DriverServe> {
  const tmpParent = mkdtempSync(join(tmpdir(), 'gb-ssk-'));
  cleanupDirs.push(tmpParent);
  const home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  const dbDir = join(tmpParent, 'db');
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir, embedding_dimensions: 1536 }),
  );

  const env = { ...process.env } as Record<string, string>;
  for (const k of CHILD_STRIP) delete env[k];
  Object.assign(env, {
    GBRAIN_HOME: tmpParent,
    HOME: tmpParent,
    GBRAIN_SWEEP: '0',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
  }, extraEnv);

  const driver = [
    '(async () => {',
    `  const { PGLiteEngine } = await import(${JSON.stringify(join(REPO_ROOT, 'src', 'core', 'pglite-engine.ts'))});`,
    `  const { startMcpServer } = await import(${JSON.stringify(join(REPO_ROOT, 'src', 'mcp', 'server.ts'))});`,
    '  const engine = new PGLiteEngine();',
    '  await engine.connect({});',
    '  await engine.initSchema();',
    '  await startMcpServer(engine);',
    "  console.error('[driver] serve ready');",
    "})().catch((e) => { console.error('[driver] boot failed: ' + (e && e.stack ? e.stack : String(e))); process.exit(1); });",
  ].join('\n');

  const proc = Bun.spawn([process.execPath, '-e', driver], {
    cwd: tmpParent,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  killers.push(async () => {
    if (proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
  });
  const stderrChunks: string[] = [];
  const decoder = new TextDecoder();
  for (const [stream, sink] of [[proc.stdout, null], [proc.stderr, stderrChunks]] as const) {
    void (async () => {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (sink) sink.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* child gone */ }
    })();
  }

  const sock = resolveSocketPath(dbDir);
  const deadline = Date.now() + 90_000;
  while (!(existsSync(sock) && existsSync(ipcSecretPath(dbDir)))) {
    if (proc.exitCode !== null) {
      throw new Error(`driver serve exited early (code ${proc.exitCode})\nstderr:\n${stderrChunks.join('')}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the IPC socket + secret\nstderr:\n${stderrChunks.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { sock, secret: readIpcSecret(dbDir)!, stderrText: () => stderrChunks.join('') };
}

/** Retry an IPC round trip past transient IPC_UNAVAILABLE (child still settling). */
async function withIpcRetry<T>(fn: () => Promise<T | typeof IPC_UNAVAILABLE>): Promise<T | typeof IPC_UNAVAILABLE> {
  let last: T | typeof IPC_UNAVAILABLE = IPC_UNAVAILABLE;
  for (let i = 0; i < 5; i++) {
    last = await fn();
    if (last !== IPC_UNAVAILABLE) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

describe('GBRAIN_SERVE_SYNC_IPC=0 — the serve-boot env gate (real startMcpServer)', () => {
  test('switch set: sync kinds answer unsupported_kind while resolve + turn_context still work', async () => {
    const serve = await bootDriverServe({ GBRAIN_SERVE_SYNC_IPC: '0' });

    const start = await withIpcRetry(() =>
      requestSyncStart(serve.sock, { secret: serve.secret, clientToken: 'ks-1', options: { timeoutSeconds: 60 } }),
    );
    expect(start).not.toBe(IPC_UNAVAILABLE);
    const startResp = start as SyncStartResponse;
    expect(startResp.ok).toBe(false);
    expect(startResp.error).toBe('unsupported_kind');
    expect(startResp.protocol).toBe(2);

    const status = await requestSyncStatus(serve.sock, { secret: serve.secret, jobId: 'any' });
    expect((status as SyncStatusResponse).error).toBe('unsupported_kind');
    const abort = await requestSyncAbort(serve.sock, { secret: serve.secret, jobId: 'any' });
    expect((abort as SyncStatusResponse).error).toBe('unsupported_kind');

    // The switch narrows the surface, it never blinds it: the same listener
    // still answers the resolve kind ok (resolveViaIpc collapses ok:false
    // into IPC_UNAVAILABLE, so not-UNAVAILABLE === the handler answered ok)…
    const resolved = await withIpcRetry(() => resolveViaIpc(serve.sock, { candidates: [] }));
    expect(resolved).not.toBe(IPC_UNAVAILABLE);

    // …and turn_context (secret-gated, so this also proves the secret file
    // the client reads is the one the serve provisioned).
    const tc = await withIpcRetry(() =>
      requestTurnContext(serve.sock, { secret: serve.secret, window: [] }, { timeoutMs: 5_000 }),
    );
    expect(tc).not.toBe(IPC_UNAVAILABLE);
    const tcResp = tc as TurnContextResponse;
    expect(tcResp.protocol).toBe(2);
    expect(tcResp.ok).toBe(true);

    // The gate-off path is a SILENT skip; the runner-import-failure path (the
    // other route to handler-absent) logs loudly. Distinguish them.
    expect(serve.stderrText()).not.toContain('[serve-sync] handlers unavailable');
  }, 120_000);

  test('control (switch unset): the same driver registers the kinds — sync_status answers unknown_job', async () => {
    // Sensitivity pin: without this control, a broken serve-sync-runner
    // import would ALSO produce unsupported_kind (its catch skips
    // registration) and the killswitch test above would pass vacuously.
    // sync_status on an unknown jobId is the side-effect-free discriminator:
    // registered handlers answer unknown_job, an absent map answers
    // unsupported_kind.
    const serve = await bootDriverServe({});
    const status = await withIpcRetry(() =>
      requestSyncStatus(serve.sock, { secret: serve.secret, jobId: 'missing' }),
    );
    expect(status).not.toBe(IPC_UNAVAILABLE);
    const resp = status as SyncStatusResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unknown_job');
    expect(resp.protocol).toBe(2);
    expect(serve.stderrText()).not.toContain('[serve-sync] handlers unavailable');
  }, 120_000);
});

describe('client ladder — the unsupported_kind arm (sync-delegate.ts)', () => {
  test('live serve answering unsupported_kind → documented remediation, verdict 1, HANDLED (no direct-sync fall-through)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gb-ssk-ladder-'));
    cleanupDirs.push(dataDir);
    // A provably-alive serve holder (the PID is us) — same fixture shape as
    // test/sync-delegate-ladder.test.ts.
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dataDir, '.gbrain-lock', 'lock'),
      JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        refreshed_at: new Date().toISOString(),
        command: '/x/gbrain/src/cli.ts serve',
        subcommand: 'serve',
      }),
    );
    const secret = ensureIpcSecret(dataDir);
    // The exact handler map a killswitched serve registers: resolve present,
    // sync kinds ABSENT — the real IPC server then answers unsupported_kind.
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      { resolve: async () => null },
      { secret },
    );
    expect(server).not.toBeNull();

    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    /* eslint-disable no-console */
    const origError = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      const handled = await withEnv(
        // Hermetic ladder walk: host brain, no ambient source, opt-out unset.
        { GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SYNC_NO_DELEGATE: undefined, GBRAIN_HOME: dataDir },
        () => maybeDelegateSyncToServe(dataDir, []),
      );
      // true = HANDLED: cli.ts's pre-connect hook `return`s on it, so the
      // direct connect-engine + in-process sync path NEVER runs. false would
      // be the fall-through — the exact bug this arm exists to prevent.
      expect(handled).toBe(true);
      const text = lines.join('\n');
      expect(text).toContain('the serve has sync delegation disabled (GBRAIN_SERVE_SYNC_IPC=0 or a startup failure).');
      // remediation(): the flag-independent ways out are always named.
      expect(text).toContain('stop the serve (PID');
      expect(text).toContain('--no-delegate');
      // The refusal happened up-front: no delegation banner, no poll loop.
      expect(text).not.toContain('delegating the sync through it');
      expect(currentExitCode()).toBe(1);
    } finally {
      console.error = origError;
      /* eslint-enable no-console */
      try { server!.close(); } catch { /* noop */ }
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });
});
