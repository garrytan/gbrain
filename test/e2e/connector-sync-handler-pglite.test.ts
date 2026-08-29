/**
 * connector-sync-handler e2e (PGLite) — the minion handler contract:
 * single-flight lock (already_in_progress, not a throw), terminal auth_required
 * returned (not thrown), and lock released so a later job proceeds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeConnectorSyncHandler, connectorSyncLockId } from '../../src/core/minions/handlers/connector-sync.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';

let engine: PGLiteEngine;
let tmp: string;
let prevHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
});
beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-conn-handler-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp; // no credential on disk → runConnectorSync returns auth_required
  // clean any connector env creds from the ambient environment
  delete process.env.GBRAIN_CONNECTOR_CHATGPT_COOKIE;
  delete process.env.GBRAIN_CONNECTOR_CHATGPT_TOKEN;
});

function fakeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1,
    name: 'connector-sync',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    deadlineAtMs: null,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as unknown as MinionJobContext;
}

describe('connector-sync handler', () => {
  test('bad provider → parseParams throws', async () => {
    const handler = makeConnectorSyncHandler(engine);
    await expect(handler(fakeJob({ provider: 'bogus' }))).rejects.toThrow(/invalid provider/i);
  });

  test('no credential → returns auth_required (NOT thrown), releases the lock', async () => {
    const handler = makeConnectorSyncHandler(engine);
    const r = (await handler(fakeJob({ provider: 'chatgpt', sourceId: 'default' }))) as { status: string };
    expect(r.status).toBe('auth_required');
    // Lock must be released: a fresh acquire of the same id succeeds.
    const relock = await tryAcquireDbLock(engine, connectorSyncLockId('chatgpt'), 5);
    expect(relock).not.toBeNull();
    await relock!.release();
  });

  test('lock contention → already_in_progress (not a throw)', async () => {
    const held = await tryAcquireDbLock(engine, connectorSyncLockId('chatgpt'), 5);
    expect(held).not.toBeNull();
    try {
      const handler = makeConnectorSyncHandler(engine);
      const r = (await handler(fakeJob({ provider: 'chatgpt', sourceId: 'default' }))) as { status: string };
      expect(r.status).toBe('already_in_progress');
    } finally {
      await held!.release();
    }
  });
});
