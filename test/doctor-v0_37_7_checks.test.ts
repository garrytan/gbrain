/**
 * v0.37.7.0 doctor checks — T12, T13, T14.
 *
 * - checkSourceRoutingHealth (T12 / 5K) — multi-source brains with
 *   empty non-default sources surface the silent-collapse-to-default
 *   fingerprint from #1167.
 * - checkOauthConfidentialHealth (T13 / 5L) — confidential clients
 *   missing client_secret_hash fail loud.
 * - checkAutopilotLockScope (T14 / 5M) — stale lockfile outside
 *   GBRAIN_HOME surfaces a PID-safe hint.
 *
 * Hermetic via PGLite + tmpdir overrides.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  checkSourceRoutingHealth,
  checkOauthConfidentialHealth,
  checkAutopilotLockScope,
} from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate(): Promise<void> {
  for (const t of ['pages', 'oauth_tokens', 'oauth_codes', 'oauth_clients']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('checkSourceRoutingHealth (#1167)', () => {
  beforeEach(truncate);

  test('single-source brain (only default) → ok', async () => {
    const r = await checkSourceRoutingHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/single-source/i);
  });

  test('multi-source brain, all populated → ok', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('a', 'a'), ('b', 'b')`);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('p1', 'a', 'note', 'p1', '', ''), ('p2', 'b', 'note', 'p2', '', '')`,
    );
    const r = await checkSourceRoutingHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/all populated/i);
  });

  test('non-default source with zero pages → warn (the #1167 fingerprint)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('lonely', 'lonely')`);
    const r = await checkSourceRoutingHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/lonely/);
    expect(r.message).toMatch(/--source-id/);
    expect(r.message).toMatch(/gbrain sources current/);
  });
});

describe('checkOauthConfidentialHealth (#1166)', () => {
  beforeEach(truncate);

  test('no OAuth clients → ok', async () => {
    const r = await checkOauthConfidentialHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('public client (auth_method=none, hash=NULL) → ok (v0.34.1.0 shape preserved)', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method)
       VALUES ('pkce-pub', NULL, 'pub', $1, $2, 'read', 'none')`,
      [['https://e.test/cb'], ['authorization_code']],
    );
    const r = await checkOauthConfidentialHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('confidential client with NULL hash → fail (the #1166 regression fingerprint)', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method)
       VALUES ('conf-broken', NULL, 'broken', $1, $2, 'read', 'client_secret_post')`,
      [['https://e.test/cb'], ['authorization_code']],
    );
    const r = await checkOauthConfidentialHealth(engine);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/conf-broken/);
    expect(r.message).toMatch(/revoke-client/);
  });

  test('confidential client with proper hash → ok', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method)
       VALUES ('healthy', 'abc123def', 'h', $1, $2, 'read', 'client_secret_post')`,
      [['https://e.test/cb'], ['authorization_code']],
    );
    const r = await checkOauthConfidentialHealth(engine);
    expect(r.status).toBe('ok');
  });
});

describe('checkAutopilotLockScope (#1226)', () => {
  test('no lockfile → ok', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'doctor-lock-scope-'));
    await withEnv({ GBRAIN_HOME: sandbox, HOME: sandbox }, async () => {
      const r = checkAutopilotLockScope();
      expect(r.status).toBe('ok');
      expect(r.message).toMatch(/Lock path:/);
    });
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('stale lock outside GBRAIN_HOME → warn with PID-safe hint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-lock-home-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'doctor-lock-gbrain-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'autopilot.lock'), '99999');

    await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
      const r = checkAutopilotLockScope();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/Stale lockfile/);
      expect(r.message).toMatch(/99999/);
      expect(r.message).toMatch(/ps -p 99999/);
    });

    rmSync(home, { recursive: true, force: true });
    rmSync(gbrainHome, { recursive: true, force: true });
  });
});
