/**
 * Transport + gate integration for the skill-catalog ops (codex P2-d).
 *
 * Drives the REAL dispatch path (`dispatchToolCall` → buildOperationContext →
 * op.handler) so we prove `ctx.remote` + `ctx.auth.scopes` + the publish gate
 * behave per transport: HTTP-remote enforces the gate, local CLI bypasses it,
 * scope shapes the D7 tool split, and the frontmatter allowlist holds end to end.
 *
 * Config is driven via the DB plane (engine.setConfig) — the plane `gbrain
 * config set` writes and the plane the gate reads first. GBRAIN_HOME is pinned
 * to a tmp dir so loadConfig()'s file plane can't leak the dev's real config in.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'skill-catalog', 'skills');

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'skill-tx-home-'));
});

afterAll(async () => {
  await engine.disconnect();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Point the catalog at the fixture via the DB plane on every test.
  await engine.setConfig('mcp.skills_dir', FIXTURE);
});

/** Parse the JSON envelope dispatchToolCall wraps every result/error in. */
function unpack(res: { content: { text: string }[]; isError?: boolean }): {
  isError: boolean;
  body: any;
} {
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
}

async function call(
  name: string,
  params: Record<string, unknown>,
  opts: { remote: boolean; auth?: AuthInfo },
) {
  return unpack(await dispatchToolCall(engine, name, params, { sourceId: 'default', ...opts }));
}

describe('list_skills over dispatch', () => {
  test('HTTP-remote + gate OFF → permission_denied', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await call('list_skills', {}, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['read'] } });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('permission_denied');
    });
  });

  test('local (remote=false) bypasses the gate even when OFF', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await call('list_skills', {}, { remote: false });
      expect(r.isError).toBe(false);
      expect(r.body.schema_version).toBe(1);
      expect(r.body.skills.map((s: any) => s.name)).toContain('brain-ops');
    });
  });

  test('HTTP-remote + gate ON → catalog with scope-aware D7 split', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('mcp.publish_skills', 'true');
      const r = await call('list_skills', {}, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['read'] } });
      expect(r.isError).toBe(false);
      const bo = r.body.skills.find((s: any) => s.name === 'brain-ops');
      expect(bo.usable_tools.sort()).toEqual(['query', 'search']);
      expect(bo.unavailable_tools).toContain('put_page'); // write op, read token can't call
      expect(r.body.instructions.available_brain_tools).not.toContain('put_page');
    });
  });

  test('admin scope widens usable_tools', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('mcp.publish_skills', 'true');
      const r = await call('list_skills', {}, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['admin'] } });
      const bo = r.body.skills.find((s: any) => s.name === 'brain-ops');
      expect(bo.usable_tools).toContain('put_page');
    });
  });

  test('DB-plane disable wins (gbrain config set mcp.publish_skills false)', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('mcp.publish_skills', 'false');
      const r = await call('list_skills', {}, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['read'] } });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('permission_denied');
    });
  });
});

describe('get_skill over dispatch', () => {
  test('remote + ON returns prose body, frontmatter allowlisted (no writes_to/sources)', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('mcp.publish_skills', 'true');
      const r = await call('get_skill', { name: 'brain-ops' }, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['read'] } });
      expect(r.isError).toBe(false);
      expect(r.body.body).toContain('Brain-first lookup');
      const blob = JSON.stringify(r.body);
      expect(blob).not.toContain('/abs/path/should/be/dropped.ts');
      expect(blob).not.toContain('people/');
      expect(r.body.usable_tools.sort()).toEqual(['query', 'search']);
    });
  });

  test('remote + OFF → permission_denied (gate before fetch)', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const r = await call('get_skill', { name: 'brain-ops' }, { remote: true, auth: { token: 't', clientId: 'c', scopes: ['read'] } });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('permission_denied');
    });
  });

  test('unknown skill → page_not_found', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('mcp.publish_skills', 'true');
      const r = await call('get_skill', { name: 'nope' }, { remote: false });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('page_not_found');
    });
  });
});
