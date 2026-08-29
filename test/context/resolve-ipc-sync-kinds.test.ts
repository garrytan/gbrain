/**
 * Delegated-sync IPC kinds — protocol pins (resolve-ipc.ts + sync-ipc.ts).
 *
 * What these protect:
 *   - secret gating fails CLOSED (no secret configured → unauthorized, wrong
 *     secret → unauthorized) — the sync kinds are mutating/admin class.
 *   - a serve WITHOUT sync handlers (kill switch, or handler-build failure)
 *     answers unsupported_kind with the protocol echo — clients refuse politely.
 *   - a PRE-DELEGATION serve (legacy resolve-only) yields the typed
 *     stale_serve degrade, never a trusted empty response.
 *   - the protocol echo rides every response (the [A9] stale-serve detector).
 *
 * Parallel-safe: hermetic tmpdir sockets, no env mutation, no engine.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_UNAVAILABLE,
  requestSyncAbort,
  requestSyncStart,
  requestSyncStatus,
  resolveSocketPath,
  startResolveIpcServer,
  type IpcHandlers,
} from '../../src/core/context/resolve-ipc.ts';
import type { SyncStartResponse, SyncStatusResponse } from '../../src/core/context/sync-ipc.ts';

const servers: Array<{ close: () => void }> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ssi-'));
  dirs.push(d);
  return d;
}

const SECRET = 'test-secret';

function stubHandlers(): IpcHandlers {
  return {
    resolve: async () => null,
    sync_start: (req) =>
      ({ ok: true, protocol: 2, jobId: `job-for-${req.clientToken}` }) satisfies SyncStartResponse,
    sync_status: (req) =>
      ({ ok: true, protocol: 2, state: 'running', startedAt: 1, elapsedMs: 2, phase: 'import', ...(req.jobId === 'gone' ? { ok: false, error: 'unknown_job', state: undefined } : {}) }) as SyncStatusResponse,
    sync_abort: () => ({ ok: true, protocol: 2, state: 'aborting' }),
  };
}

async function startServer(dir: string, handlers: IpcHandlers, secret?: string) {
  const sock = resolveSocketPath(dir);
  const server = await startResolveIpcServer(sock, handlers, { secret });
  expect(server).not.toBeNull();
  servers.push(server!);
  return sock;
}

describe('delegated-sync IPC kinds', () => {
  test('round-trip: sync_start reaches the handler and echoes protocol 2', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), SECRET);
    const r = await requestSyncStart(sock, {
      secret: SECRET,
      clientToken: 'tok-1',
      options: { timeoutSeconds: 60 },
    });
    expect(r).not.toBe(IPC_UNAVAILABLE);
    const resp = r as SyncStartResponse;
    expect(resp.ok).toBe(true);
    expect(resp.protocol).toBe(2);
    expect(resp.jobId).toBe('job-for-tok-1');
  });

  test('wrong secret → unauthorized (all three kinds)', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), SECRET);
    const start = await requestSyncStart(sock, { secret: 'nope', clientToken: 't', options: { timeoutSeconds: 60 } });
    expect((start as SyncStartResponse).error).toBe('unauthorized');
    const status = await requestSyncStatus(sock, { secret: 'nope', jobId: 'j' });
    expect((status as SyncStatusResponse).error).toBe('unauthorized');
    const abort = await requestSyncAbort(sock, { secret: 'nope', jobId: 'j' });
    expect((abort as SyncStatusResponse).error).toBe('unauthorized');
  });

  test('NO secret configured → unauthorized (fail closed, never open service)', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), undefined);
    const r = await requestSyncStart(sock, { secret: SECRET, clientToken: 't', options: { timeoutSeconds: 60 } });
    expect((r as SyncStartResponse).ok).toBe(false);
    expect((r as SyncStartResponse).error).toBe('unauthorized');
  });

  test('handlers absent (kill switch / build failure) → unsupported_kind WITH echo', async () => {
    const sock = await startServer(tmpDir(), { resolve: async () => null }, SECRET);
    const r = await requestSyncStart(sock, { secret: SECRET, clientToken: 't', options: { timeoutSeconds: 60 } });
    const resp = r as SyncStartResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unsupported_kind');
    expect(resp.protocol).toBe(2);
  });

  test('pre-delegation serve → stale_serve degrade (no protocol echo on unknown_kind)', async () => {
    // A genuinely OLD serve's dispatcher has no sync branches: it answers
    // `{ok:false, error:'unknown_kind:sync_start'}` WITHOUT the protocol echo.
    // (A NEW serve without handlers answers unsupported_kind WITH the echo —
    // pinned above.) Simulate the old wire shape with a raw NDJSON server.
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const net = await import('node:net');
    const raw = net.createServer((conn) => {
      conn.on('data', () => {
        conn.write(JSON.stringify({ ok: false, error: 'unknown_kind:sync_start' }) + '\n');
        conn.end();
      });
    });
    await new Promise<void>((r) => raw.listen(sock, () => r()));
    servers.push(raw);
    const r = await requestSyncStart(sock, { secret: SECRET, clientToken: 't', options: { timeoutSeconds: 60 } });
    expect(r).toEqual({ degraded: 'stale_serve' });
  });

  test('absent socket → IPC_UNAVAILABLE (caller re-probes the holder)', async () => {
    const r = await requestSyncStatus(resolveSocketPath(tmpDir()), { secret: SECRET, jobId: 'j' });
    expect(r).toBe(IPC_UNAVAILABLE);
  });

  test('handler exceptions surface as typed ok:false, never a dropped connection', async () => {
    const handlers = stubHandlers();
    handlers.sync_abort = () => { throw new Error('boom'); };
    const sock = await startServer(tmpDir(), handlers, SECRET);
    const r = await requestSyncAbort(sock, { secret: SECRET, jobId: 'j' });
    expect(r).toEqual({ ok: false, protocol: 2, error: 'boom' });
  });
});
