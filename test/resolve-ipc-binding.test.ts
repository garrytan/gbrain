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
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';
import { resolveSocketPath } from '../src/core/context/resolve-ipc.ts';
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

  it('bootstrap verify prefers a live serve socket over self-creating one', async () => {
    // verify.ts:hooks smoke used to ALWAYS start its own IPC server, which
    // manufactured the condition under test and masked serve postures that
    // never bind IPC. Pin the live-socket branch.
    const src = await readSrc('src/core/bootstrap/verify.ts').text();
    expect(src).toContain('const liveSocket = existsSync(socketPath)');
    expect(src).toMatch(/if \(!liveSocket\) \{/);
  });
});
