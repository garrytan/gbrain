/**
 * test/resolve-ipc-binding.test.ts — #4474.
 *
 * `gbrain serve --http` never bound the resolve-IPC unix socket (the
 * listener lived inline in the stdio MCP path only), so on the exact
 * posture `gbrain bootstrap harness` targets, every wired lifecycle hook
 * degraded to `no_serve` forever — with no local recovery on PGLite (the
 * http serve owns the single-writer lock). The wiring now lives in the
 * shared `bindResolveIpcForServe` helper and BOTH transports call it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';
import { resolveSocketPath, socketHasLiveListener } from '../src/core/context/resolve-ipc.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const readSrc = (rel: string) => Bun.file(join(REPO_ROOT, rel));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-ipc-bind-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('bindResolveIpcForServe (#4474)', () => {
  it('binds the socket for a PGLite config and close() reaps it', async () => {
    const dataDir = join(tmp, 'db');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(
      join(tmp, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dataDir }),
    );
    await withEnv({ GBRAIN_HOME: tmp, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      // Bind-time never touches the engine (handlers close over it lazily),
      // so a stub is enough to prove the listener itself comes up.
      const binding = await bindResolveIpcForServe({} as unknown as BrainEngine, 'default');
      try {
        expect(binding.server).not.toBeNull();
        expect(binding.socketPath).toBe(resolveSocketPath(dataDir));
        expect(existsSync(binding.socketPath!)).toBe(true);
      } finally {
        binding.close();
      }
      expect(existsSync(resolveSocketPath(dataDir))).toBe(false);
      // close() is idempotent.
      binding.close();
    });
  });

  it('returns a null binding (not a throw) when the config has no keying material', async () => {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    await withEnv({ GBRAIN_HOME: tmp, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      const binding = await bindResolveIpcForServe({} as unknown as BrainEngine, 'default');
      expect(binding.server).toBeNull();
      expect(binding.socketPath).toBeNull();
      binding.close(); // no-op, must not throw
    });
  });
});

describe('both serve transports bind through the shared helper (#4474)', () => {
  it('serve --http wires bindResolveIpcForServe with teardown', async () => {
    const src = await readSrc('src/commands/serve-http.ts').text();
    expect(src).toContain('bindResolveIpcForServe(');
    expect(src).toContain('ipcBinding.close()');
  });

  it('the stdio MCP path wires bindResolveIpcForServe with teardown', async () => {
    const src = await readSrc('src/mcp/server.ts').text();
    expect(src).toContain('bindResolveIpcForServe(');
    // Optional chain since the db-availability wave: degraded-mode serve
    // defers the IPC bind until first reconnect, so shutdown may run with
    // the binding still null. The teardown wiring is what this pins.
    expect(src).toContain('ipcBinding?.close()');
  });

  it('an exiting serve never blind-unlinks the socket pathname (#4896)', async () => {
    // A transient serve that lost the bind to a live provider must not
    // delete that provider's socket on the way out; Bun's server.close()
    // already unlinks the pathname the listener itself bound.
    const src = await readSrc('src/mcp/resolve-ipc-binding.ts').text();
    expect(src).not.toContain('unlinkSync(resolveSocket)');
    expect(src).not.toContain('rmSync(resolveSocket');
    // The blind-unlink helper is gone from the module surface entirely.
    expect(await readSrc('src/core/context/resolve-ipc.ts').text()).not.toContain('export function cleanupStaleSocket');
  });

  it('the pre-bind owner probe reads a connect timeout as unknown, never as a dead owner (#4896 follow-up)', async () => {
    // A 250ms connect timeout used to count as "no live listener" and let the
    // caller clean the socket away — a long-lived serve with a busy event
    // loop was displaced, the very symptom #4896 fixed. Only a hard connect
    // error (ENOENT / ECONNREFUSED) may authorize cleanup.
    const src = await readSrc('src/core/context/resolve-ipc.ts').text();
    expect(src).toContain("probe.once('timeout', () => finish('unknown'))");
    expect(src).toContain("probe.once('error', () => finish('dead'))");
    expect(src).not.toContain("probe.once('timeout', () => finish(false))");
    // One budget constant, not a literal that can drift from the client's.
    expect(src).toContain('probe.setTimeout(CLIENT_TIMEOUT_MS)');
    expect(src).not.toContain('probe.setTimeout(250)');
  });

  it('bootstrap verify prefers a live serve socket over self-creating one', async () => {
    // verify.ts:hooks smoke used to ALWAYS start its own IPC server, which
    // manufactured the condition under test and masked serve postures that
    // never bind IPC. Pin the live-socket branch — probed for a listener, not
    // existsSync'd (a dead serve's leftover socket file is not a provider).
    const src = await readSrc('src/core/bootstrap/verify.ts').text();
    expect(src).toContain('const liveSocket = await socketHasLiveListener(socketPath)');
    expect(src).not.toContain('existsSync(socketPath)');
    expect(src).toMatch(/if \(!liveSocket\) \{/);
  });

  it('socketHasLiveListener: a leftover file at the socket path is not a live provider; a bound listener is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ipc-live-'));
    const sock = join(dir, 'ipc.sock');
    try {
      writeFileSync(sock, '');
      expect(await socketHasLiveListener(sock)).toBe(false);
      rmSync(sock);
      const server = net.createServer();
      await new Promise<void>((resolveListen) => server.listen(sock, resolveListen));
      try {
        expect(await socketHasLiveListener(sock)).toBe(true);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
