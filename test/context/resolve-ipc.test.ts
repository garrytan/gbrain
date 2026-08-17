/**
 * Retrieval Reflex resolve IPC round-trip tests (#1981, T3/T5).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSocketPath,
  resolveIpcRuntimeDirForConfig,
  resolveSocketPathForConfig,
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
  test('engine-uniform paths preserve PGLite and isolate Postgres by source and harness', () => {
    const pglite = { engine: 'pglite', database_path: '/tmp/example-brain' };
    expect(resolveIpcRuntimeDirForConfig(pglite, 'default')).toBe('/tmp/example-brain');
    expect(resolveSocketPathForConfig(pglite, 'default')).toBe(resolveSocketPath('/tmp/example-brain'));

    const postgres = { engine: 'postgres', database_url: 'postgresql://user:secret@example.invalid/brain' };
    const a = resolveIpcRuntimeDirForConfig(postgres, 'source-a', 'traecli');
    const b = resolveIpcRuntimeDirForConfig(postgres, 'source-b');
    const claude = resolveIpcRuntimeDirForConfig(postgres, 'source-a', 'claude-code');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a).not.toBe(claude);
    expect(a).not.toContain('user');
    expect(a).not.toContain('secret');
    expect(resolveSocketPathForConfig(postgres, 'source-a', 'traecli')).toBe(resolveSocketPath(a!));
  });

  test('incomplete config has no IPC runtime path', () => {
    expect(resolveSocketPathForConfig(null)).toBeNull();
    expect(resolveSocketPathForConfig({ engine: 'postgres' })).toBeNull();
    expect(resolveSocketPathForConfig({ engine: 'pglite' })).toBeNull();
  });

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
    await new Promise<void>((resolve) => s1!.close(() => resolve()));
    // bind again at the same path — startResolveIpcServer must unlink the stale file
    const s2 = await startResolveIpcServer(sock, async () => null);
    expect(s2).not.toBeNull();
    servers.push(s2!);
    expect(existsSync(sock)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a second server never unlinks an active owner socket', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const s1 = await startResolveIpcServer(sock, async () => ({ pointers: [], text: 'owner' }));
    expect(s1).not.toBeNull();
    servers.push(s1!);

    const s2 = await startResolveIpcServer(sock, async () => ({ pointers: [], text: 'standby' }));
    expect(s2).toBeNull();
    expect(existsSync(sock)).toBe(true);
    const got = await resolveViaIpc(sock, { candidates: [{ display: 'A', query: 'A' }] });
    expect(got).not.toBe(IPC_UNAVAILABLE);
    expect((got as PointerBlock).text).toBe('owner');
    rmSync(dir, { recursive: true, force: true });
  });
});
