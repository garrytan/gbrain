/**
 * #677 — delegated-sweep IPC kinds (resolve-ipc.ts + sweep-ipc.ts) protocol
 * pins, mirroring resolve-ipc-sync-kinds.test.ts:
 *
 *   - secret gating fails CLOSED (no secret → unauthorized, wrong secret →
 *     unauthorized) — the sweep kinds mutate the brain.
 *   - a serve WITHOUT sweep handlers answers unsupported_kind WITH the
 *     protocol echo — clients refuse politely.
 *   - a PRE-DELEGATION serve yields the typed stale_serve degrade.
 *   - validateDelegatedSweepOptions is default-deny.
 *
 * Parallel-safe: hermetic tmpdir sockets, no env mutation, no engine.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_UNAVAILABLE,
  requestSweepStart,
  requestSweepStatus,
  resolveSocketPath,
  startResolveIpcServer,
  type IpcHandlers,
} from '../../src/core/context/resolve-ipc.ts';
import {
  validateDelegatedSweepOptions,
  DELEGATED_SWEEP_BUDGET_MAX_MS,
  type SweepStartResponse,
  type SweepStatusResponse,
} from '../../src/core/context/sweep-ipc.ts';

const servers: Array<{ close: () => void }> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swi-'));
  dirs.push(d);
  return d;
}

const SECRET = 'test-secret';

function stubHandlers(): IpcHandlers {
  return {
    resolve: async () => null,
    sweep_start: (req) =>
      ({ ok: true, protocol: 2, jobId: `sweep-for-${req.clientToken}` }) satisfies SweepStartResponse,
    sweep_status: () =>
      ({ ok: true, protocol: 2, state: 'running', startedAt: 1, elapsedMs: 2 }) satisfies SweepStatusResponse,
  };
}

async function startServer(dir: string, handlers: IpcHandlers, secret?: string) {
  const sock = resolveSocketPath(dir);
  const server = await startResolveIpcServer(sock, handlers, { secret });
  expect(server).not.toBeNull();
  servers.push(server!);
  return sock;
}

describe('delegated-sweep IPC kinds (#677)', () => {
  test('round-trip: sweep_start reaches the handler and echoes protocol 2', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), SECRET);
    const r = await requestSweepStart(sock, { secret: SECRET, clientToken: 'tok-1', options: {} });
    expect(r).not.toBe(IPC_UNAVAILABLE);
    const resp = r as SweepStartResponse;
    expect(resp.ok).toBe(true);
    expect(resp.protocol).toBe(2);
    expect(resp.jobId).toBe('sweep-for-tok-1');
  });

  test('wrong secret → unauthorized (both kinds)', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), SECRET);
    const start = await requestSweepStart(sock, { secret: 'nope', clientToken: 't', options: {} });
    expect((start as SweepStartResponse).error).toBe('unauthorized');
    const status = await requestSweepStatus(sock, { secret: 'nope', jobId: 'j' });
    expect((status as SweepStatusResponse).error).toBe('unauthorized');
  });

  test('NO secret configured → unauthorized (fail closed, never open service)', async () => {
    const sock = await startServer(tmpDir(), stubHandlers(), undefined);
    const r = await requestSweepStart(sock, { secret: SECRET, clientToken: 't', options: {} });
    expect((r as SweepStartResponse).ok).toBe(false);
    expect((r as SweepStartResponse).error).toBe('unauthorized');
  });

  test('handlers absent (kill switch / build failure) → unsupported_kind WITH echo', async () => {
    const sock = await startServer(tmpDir(), { resolve: async () => null }, SECRET);
    const r = await requestSweepStart(sock, { secret: SECRET, clientToken: 't', options: {} });
    const resp = r as SweepStartResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unsupported_kind');
    expect(resp.protocol).toBe(2);
  });

  test('pre-delegation serve → stale_serve degrade (no protocol echo)', async () => {
    const dir = tmpDir();
    const sock = resolveSocketPath(dir);
    const net = await import('node:net');
    const raw = net.createServer((conn) => {
      conn.on('data', () => {
        conn.write(JSON.stringify({ ok: false, error: 'unknown_kind:sweep_start' }) + '\n');
        conn.end();
      });
    });
    await new Promise<void>((r) => raw.listen(sock, () => r()));
    servers.push(raw);
    const r = await requestSweepStart(sock, { secret: SECRET, clientToken: 't', options: {} });
    expect(r).toEqual({ degraded: 'stale_serve' });
  });

  test('absent socket → IPC_UNAVAILABLE', async () => {
    const r = await requestSweepStatus(resolveSocketPath(tmpDir()), { secret: SECRET, jobId: 'j' });
    expect(r).toBe(IPC_UNAVAILABLE);
  });
});

describe('validateDelegatedSweepOptions (#677) — default-deny', () => {
  test('accepts the allowlisted fields and clamps budgetMs', () => {
    const v = validateDelegatedSweepOptions({
      sourceId: 'my-source',
      budgetMs: DELEGATED_SWEEP_BUDGET_MAX_MS + 1,
      batchLimit: 5,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.options.sourceId).toBe('my-source');
      expect(v.options.budgetMs).toBe(DELEGATED_SWEEP_BUDGET_MAX_MS);
      expect(v.options.batchLimit).toBe(5);
    }
  });

  test('rejects unknown keys, wrong types, bad sourceId, negative numbers', () => {
    expect(validateDelegatedSweepOptions({ repoPath: '/etc' }).ok).toBe(false);
    expect(validateDelegatedSweepOptions({ budgetMs: 'fast' }).ok).toBe(false);
    expect(validateDelegatedSweepOptions({ budgetMs: -1 }).ok).toBe(false);
    expect(validateDelegatedSweepOptions({ sourceId: 'Not_Valid!' }).ok).toBe(false);
    expect(validateDelegatedSweepOptions(null).ok).toBe(false);
    expect(validateDelegatedSweepOptions([]).ok).toBe(false);
  });

  test('empty options are valid (all fields optional)', () => {
    expect(validateDelegatedSweepOptions({}).ok).toBe(true);
  });
});
