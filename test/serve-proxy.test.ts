/**
 * Tests for the multi-client `gbrain serve` proxy: src/mcp/multiplexer.ts +
 * src/mcp/proxy.ts + the readLockInfo() helper exported from
 * src/core/pglite-lock.ts.
 *
 * Background: PGLite is single-process-per-data-dir. Multiple `gbrain serve`
 * invocations against the same brain (Claude.app's primary serve + each
 * claude-code-spawn child session that passes --mcp-config) used to collide
 * on the lock and die. The multiplexer + proxy let the first serve become
 * the owner and subsequent serves stream through it over a Unix socket.
 *
 * Test isolation: CONTRIBUTING.md R3 + R4 — the PGLite engine is created
 * inside beforeAll() and disconnected in afterAll(). No process.env mutation
 * (R1) and no module-level mocks (R2), so this file stays parallel-safe
 * and out of the *.serial.test.ts quarantine.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  startMultiplexer,
  serveSocketPath,
  type MultiplexerHandle,
} from '../src/mcp/multiplexer.ts';
import { runProxy } from '../src/mcp/proxy.ts';
import { readLockInfo } from '../src/core/pglite-lock.ts';

let engine: PGLiteEngine;
let dataDir: string;
let activeMultiplexer: MultiplexerHandle | null = null;

// 30s timeout: PGLite cold-start + 88 migrations against a fresh tmpdir
// takes ~7s; the default 5s beforeAll cap times out before initSchema
// completes. Other PGLite-backed test files run inside the *.serial.test.ts
// quarantine OR reuse a snapshot via GBRAIN_PGLITE_SNAPSHOT; this suite
// stays parallel-safe by paying the cold-start cost honestly.
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-serve-proxy-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  if (activeMultiplexer) {
    try { await activeMultiplexer.close(); } catch { /* idempotent */ }
    activeMultiplexer = null;
  }
  await engine.disconnect();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 10_000);

/**
 * Drive a single JSON-RPC `initialize` through runProxy and return the parsed
 * reply. Caller controls socket path so we can point at owner / stale / etc.
 */
async function proxyInitialize(socketPath: string, id = 1): Promise<unknown> {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'serve-proxy-test', version: '0.0.0' },
    },
  }) + '\n';

  const stdin = new Readable({ read() {} });
  stdin.push(initialize);

  const captured: Buffer[] = [];
  const stdout = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured.push(chunk);
      cb();
    },
  });

  const proxyDone = runProxy(socketPath, { stdin, stdout });

  // Poll for a reply (PGLite-backed server is fast but not instant).
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && captured.length === 0) {
    await new Promise((r) => setTimeout(r, 25));
  }

  stdin.push(null);
  await Promise.race([
    proxyDone.catch(() => {}),
    new Promise((r) => setTimeout(r, 500)),
  ]);

  const text = Buffer.concat(captured).toString('utf8');
  const firstLine = text.split('\n').filter(Boolean)[0];
  if (!firstLine) throw new Error(`no reply received from ${socketPath}`);
  return JSON.parse(firstLine);
}

describe('serve proxy + multiplexer', () => {
  test('roundtrips JSON-RPC initialize through proxy→multiplexer→server', async () => {
    // Use a per-test socket path so this stays isolated from the suite's
    // shared engine's lock dir.
    const socketPath = join(dataDir, '.gbrain-lock', `roundtrip-${Date.now()}.sock`);
    activeMultiplexer = await startMultiplexer(engine, socketPath);

    const reply = await proxyInitialize(socketPath) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };

    expect(reply.jsonrpc).toBe('2.0');
    expect(reply.id).toBe(1);
    expect(reply.result.serverInfo.name).toBe('gbrain');
    expect(reply.result.protocolVersion).toBeTruthy();

    await activeMultiplexer.close();
    activeMultiplexer = null;
  });

  test('serves N concurrent proxies on one multiplexer (multi-client core promise)', async () => {
    // The whole point of the fix: Claude.app's primary serve + N
    // claude-code-spawn sub-sessions all multiplexed into one engine.
    // We simulate 3 concurrent proxies sending initialize at once.
    const socketPath = join(dataDir, '.gbrain-lock', `concurrent-${Date.now()}.sock`);
    activeMultiplexer = await startMultiplexer(engine, socketPath);

    const N = 3;
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) => proxyInitialize(socketPath, i + 100)),
    );

    expect(replies).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const r = replies[i] as { jsonrpc: string; id: number; result?: unknown };
      expect(r.jsonrpc).toBe('2.0');
      expect(r.id).toBe(i + 100);
      expect(r.result).toBeTruthy();
    }
    // The multiplexer should have seen all N connections and shed them.
    // clientCount goes back to 0 once proxies hang up (proxyInitialize
    // closes its stdin which propagates through to socket close).
    // Give a beat for the close events to drain.
    await new Promise((r) => setTimeout(r, 200));
    expect(activeMultiplexer.clientCount).toBe(0);

    await activeMultiplexer.close();
    activeMultiplexer = null;
  });

  test('startMultiplexer removes a stale socket file from a crashed owner', async () => {
    // Simulates the post-kill-9 state: owner crashed without releasing
    // anything, lock got reclaimed (acquireLock has its own stale-PID
    // cleanup, covered in test/pglite-lock.test.ts), but the orphan
    // socket file from `net.createServer().listen(path)` is still on disk.
    // A fresh owner's startMultiplexer must unlink it or `listen()` would
    // fail with EADDRINUSE.
    const lockDir = join(dataDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const socketPath = join(lockDir, `stale-${Date.now()}.sock`);

    // Plant a stale file at the socket path (not a real socket — just a
    // regular file, same as what a crashed listener leaves behind on macOS
    // when the process is SIGKILL'd before its own cleanup hook runs).
    writeFileSync(socketPath, '');
    expect(existsSync(socketPath)).toBe(true);

    // Should not throw — the multiplexer is responsible for clearing the
    // stale path before bind.
    activeMultiplexer = await startMultiplexer(engine, socketPath);

    // After bind, the path exists again (now as a real socket inode). We
    // verify by running a roundtrip — if the listener weren't bound, the
    // proxy would fail to connect.
    const reply = await proxyInitialize(socketPath) as { result?: unknown };
    expect(reply.result).toBeTruthy();

    await activeMultiplexer.close();
    activeMultiplexer = null;
  });
});

describe('readLockInfo()', () => {
  // These are scoped to a tmp dir that's NOT the shared engine's dataDir,
  // so we can write arbitrary lock files without breaking the suite.
  let infoDir: string;
  beforeAll(() => {
    infoDir = mkdtempSync(join(tmpdir(), 'gbrain-lockinfo-test-'));
  });
  afterAll(() => {
    try { rmSync(infoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns null when no lock file present', () => {
    expect(readLockInfo(infoDir)).toBe(null);
  });

  test('returns null for undefined dataDir (in-memory engine)', () => {
    expect(readLockInfo(undefined)).toBe(null);
  });

  test('parses a well-formed lock file', () => {
    const lockDir = join(infoDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({
        pid: 12345,
        acquired_at: 1779000000000,
        command: '/path/to/gbrain serve',
      }),
    );

    const info = readLockInfo(infoDir);
    expect(info).not.toBe(null);
    expect(info!.pid).toBe(12345);
    expect(info!.acquired_at).toBe(1779000000000);
    expect(info!.command).toBe('/path/to/gbrain serve');

    rmSync(lockDir, { recursive: true, force: true });
  });

  test('returns null on corrupt lock file (does not throw)', () => {
    const lockDir = join(infoDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), 'this is not json');

    expect(readLockInfo(infoDir)).toBe(null);

    rmSync(lockDir, { recursive: true, force: true });
  });

  test('returns null on lock file missing required fields', () => {
    const lockDir = join(infoDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ command: 'only-command-no-pid' }),
    );

    expect(readLockInfo(infoDir)).toBe(null);

    rmSync(lockDir, { recursive: true, force: true });
  });
});

describe('serveSocketPath()', () => {
  test('returns a path inside the per-brain lock dir', () => {
    const result = serveSocketPath('/tmp/some-brain');
    expect(result).toBe('/tmp/some-brain/.gbrain-lock/serve.sock');
  });
});
