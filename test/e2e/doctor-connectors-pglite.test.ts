/**
 * doctor-connectors e2e (PGLite) — D3.2: re-auth-needed / stalled-sync / drift,
 * gated on a credential + auto_sync. A manual-lane user is NEVER nagged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { connectorsHealthCheck } from '../../src/commands/doctor/checks/connectors.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { authErrorAtKey, autoSyncKey, lastSyncAtKey } from '../../src/core/connectors/config-keys.ts';

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
  tmp = mkdtempSync(join(tmpdir(), 'gb-doctor-conn-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  delete process.env.GBRAIN_CONNECTOR_CHATGPT_COOKIE;
});

function saveCred(savedAt: string): void {
  saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'x', savedAt });
}

describe('connectorsHealthCheck', () => {
  test('no credentials → ok, no nag', async () => {
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toMatch(/no chat connectors/i);
  });

  test('credential present, manual lane (auto_sync off), fresh → ok (never nags on staleness)', async () => {
    saveCred('2026-08-25T00:00:00.000Z');
    // auto_sync unset, last_sync_at ancient → still OK because manual lane isn't gated on staleness.
    await engine.setConfig(lastSyncAtKey('chatgpt'), '2000-01-01T00:00:00.000Z');
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('ok');
  });

  test('auth_error_at newer than savedAt → warn: re-auth needed', async () => {
    saveCred('2026-08-25T00:00:00.000Z');
    await engine.setConfig(authErrorAtKey('chatgpt'), '2026-08-26T00:00:00.000Z');
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/re-auth/i);
  });

  test('stale auth_error (older than savedAt, i.e. resolved by re-auth) → not flagged', async () => {
    saveCred('2026-08-25T00:00:00.000Z');
    await engine.setConfig(authErrorAtKey('chatgpt'), '2026-08-20T00:00:00.000Z'); // before savedAt
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('ok');
  });

  test('auto_sync on + stale last_sync → warn: stalled', async () => {
    saveCred('2026-08-25T00:00:00.000Z');
    await engine.setConfig(autoSyncKey('chatgpt'), 'true');
    await engine.setConfig(lastSyncAtKey('chatgpt'), '2000-01-01T00:00:00.000Z');
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/stall/i);
  });
});
