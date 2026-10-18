/**
 * doctor-connectors e2e (PGLite) — D3.2: re-auth-needed / stalled-sync / drift,
 * gated on a credential + auto_sync. A manual-lane user is NEVER nagged.
 * #6387: unresolved conversations warn "archive incomplete" (doctor and
 * `connectors status`); a legacy Claude entry only `--full` can retry carries
 * an ask-first fix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { connectorsHealthCheck } from '../../src/commands/doctor/checks/connectors.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { authErrorAtKey, autoSyncKey, connectorSourceKey, lastSyncAtKey } from '../../src/core/connectors/config-keys.ts';
import { runConnectorStatus } from '../../src/commands/connectors/status.ts';

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
    await engine.setConfig(lastSyncAtKey('chatgpt', 'default'), '2000-01-01T00:00:00.000Z');
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
    await engine.setConfig(lastSyncAtKey('chatgpt', 'default'), '2000-01-01T00:00:00.000Z');
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toMatch(/stall/i);
  });

  test('unresolved conversations → warn: archive incomplete, retried automatically, no fix needed', async () => {
    saveCred('2026-08-25T00:00:00.000Z');
    await engine.setConfig(connectorSourceKey('chatgpt', 'default', 'failed'),
      JSON.stringify({ 'conv-1': { attempts: 3, updatedAt: '2026-07-01T00:00:00.000Z', nextRetryAt: '2026-10-11T00:00:00.000Z' } }));
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('chatgpt: 1 unresolved conversation(s) — archive incomplete');
    expect(c.fix).toBeUndefined();
  });

  test('a legacy Claude failure without an organization → ask-first --full fix; status lists it', async () => {
    saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: 'sessionKey=x', savedAt: '2026-08-25T00:00:00.000Z' });
    await engine.setConfig(connectorSourceKey('claude', 'default', 'failed'),
      JSON.stringify({ 'conv-legacy': { attempts: 3, updatedAt: '2026-07-01T00:00:00.000Z' } }));
    const c = await connectorsHealthCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('archive incomplete');
    expect(c.fix?.argv).toEqual(['gbrain', 'connectors', 'sync', 'claude', '--full', '--source', 'default']);
    expect(c.fix?.consent).toEqual(['credentials']);

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => { lines.push(msg); };
    try {
      await runConnectorStatus(engine, ['claude', '--json']);
    } finally {
      console.log = orig;
    }
    const out = JSON.parse(lines.join('\n'));
    expect(out.providers[0].unresolved).toEqual([
      { id: 'conv-legacy', attempts: 3, updated_at: '2026-07-01T00:00:00.000Z', next_retry_at: null, needs_full_sync: true },
    ]);
  });
});
