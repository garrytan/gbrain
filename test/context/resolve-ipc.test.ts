/**
 * Retrieval Reflex resolve IPC round-trip tests (#1981, T3/T5).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSocketPath,
  startResolveIpcServer,
  resolveViaIpc,
  IPC_UNAVAILABLE,
} from '../../src/core/context/resolve-ipc.ts';
import type { PointerBlock } from '../../src/core/context/retrieval-reflex.ts';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rr-ipc-'));
}

describe('resolve IPC', () => {
  test('round-trip: client gets the pointer block the server returns', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const block: PointerBlock = {
      pointers: [{ display: 'Alice', slug: 'people/alice', source_id: 'default', synopsis: 'x', arm: 'alias', confidence: 0.9 }],
      text: 'BLOCK',
    };
    const server = await startResolveIpcServer(sock, async (req) => {
      expect(req.candidates[0].query).toBe('Alice');
      return block;
    });
    expect(server).not.toBeNull();
    servers.push(server!);

    const got = await resolveViaIpc(sock, { candidates: [{ display: 'Alice', query: 'Alice' }] });
    expect(got).not.toBe(IPC_UNAVAILABLE);
    expect((got as PointerBlock).text).toBe('BLOCK');
    rmSync(dir, { recursive: true, force: true });
  });

  test('absent socket → IPC_UNAVAILABLE (caller falls through ladder)', async () => {
    const dir = tmpDir();
    const got = await resolveViaIpc(resolveSocketPath(dir), { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).toBe(IPC_UNAVAILABLE);
    rmSync(dir, { recursive: true, force: true });
  });

  // Windows regression (community #1294-cluster follow-up). On win32,
  // net.createServer()/createConnection() silently translate a plain path
  // into \\.\pipe\<name> — no file is ever created on disk, so a client-side
  // existsSync(socketPath) pre-check is always false there even while a live
  // server is listening and a real connection would succeed. Verified
  // manually against Bun 1.3.14 / Windows 11 (listen()+connect() round trip
  // on the same plain path succeeds while existsSync() on that path stays
  // false throughout) — CI here is Ubuntu-only so that positive path can't
  // run in this suite. What CAN run cross-platform: the win32 branch must
  // still degrade to IPC_UNAVAILABLE (not throw, not hang) when there is
  // truly no server — this proves it delegates to the connection-level
  // error/timeout handlers instead of silently short-circuiting.
  test('win32: absent server still degrades to IPC_UNAVAILABLE without the existsSync fast-path', async () => {
    const dir = tmpDir();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const got = await resolveViaIpc(resolveSocketPath(dir), { candidates: [{ display: 'A', query: 'A' }] });
      expect(got).toBe(IPC_UNAVAILABLE);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('win32: a real listening server is still reachable when existsSync would say false (POSIX fixture proxy)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const block: PointerBlock = { pointers: [], text: 'WIN32-OK' };
    const server = await startResolveIpcServer(sock, async () => block);
    servers.push(server!);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // On this (POSIX) CI box the socket file genuinely exists, so this
      // does not reproduce the Windows bug end-to-end — it only proves the
      // win32 branch does not regress the case where a server IS reachable
      // (no new false-negative introduced by skipping the pre-check there).
      const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
      expect(got).not.toBe(IPC_UNAVAILABLE);
      expect((got as PointerBlock).text).toBe('WIN32-OK');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('server returning null relays as null (resolved, nothing found)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, async () => null);
    servers.push(server!);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('stale socket file is cleaned up so a fresh server can bind', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const s1 = await startResolveIpcServer(sock, async () => null);
    servers.push(s1!);
    s1!.close();
    // bind again at the same path — startResolveIpcServer must unlink the stale file
    const s2 = await startResolveIpcServer(sock, async () => null);
    expect(s2).not.toBeNull();
    servers.push(s2!);
    // win32: the rebind itself is the real assertion — s2 must be non-null,
    // i.e. listen() didn't fail with an "address in use" equivalent against
    // the stale pipe. existsSync() can't observe a named pipe on Windows
    // (see the round-trip fix above), so the file-presence check is POSIX-only.
    if (process.platform !== 'win32') {
      expect(existsSync(sock)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
