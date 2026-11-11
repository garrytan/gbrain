/**
 * GBRA-449 fix 4: request_tools {surface, tools} in one call applies the
 * surface change exactly as a surface-only call does, then returns the
 * descriptors for tools against the resulting surface.
 *
 * Protects (red before: the pair was refused with invalid_params "pass either
 * {surface} (persist) or {tools} (descriptor fetch), not both"):
 *  - the OAuth client's surface row is written as a surface-only call writes
 *    it, the response's surface_change is that call's answer and its tools are
 *    the descriptors a tools-only call returns;
 *  - a surface refusal (above the server ceiling, operator-pinned) refuses the
 *    pair the same way and writes nothing;
 *  - a tool outside the ceiling is left out exactly as a tools-only call leaves
 *    it out;
 *  - each argument alone answers as before.
 * Database-only (repo-less) brain: the client rows live in oauth_clients, no
 * checkout. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { __resetRequestToolsPersistLimiterForTests, type AuthInfo } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe('[' + backend + '] request_tools {surface, tools} together (GBRA-449)', () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
      await engine.setConfig('mcp.publish_skills', 'false');
      await engine.setConfig('mcp.publish_advisor', 'false');
    }, 180_000);
    afterAll(async () => { await engine.disconnect(); });

    beforeEach(async () => {
      __resetRequestToolsPersistLimiterForTests();
      await engine.executeRaw("DELETE FROM oauth_clients WHERE client_id LIKE 'gbra449-%'");
      for (const [id, setBy] of [['gbra449-a', null], ['gbra449-b', null], ['gbra449-pinned', 'operator']] as const) {
        await engine.executeRaw('INSERT INTO oauth_clients (client_id, client_name, surface, surface_set_by) VALUES ($1, $1, $2, $3)',
          [id, setBy ? 'verbs' : null, setBy]);
      }
    });

    const auth = (clientId: string): AuthInfo => ({ token: 't', clientId, scopes: ['read'] });
    async function call(args: Record<string, unknown>, clientId: string, ceiling: 'verbs' | 'starter' | 'full' = 'full') {
      const r = await dispatchToolCall(engine, 'request_tools', args, { remote: true, transport: 'http', sourceId: 'default', surfaceCeiling: ceiling, auth: auth(clientId) } as never);
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
    }
    const surfaceOf = async (clientId: string) =>
      (await engine.executeRaw<{ surface: string | null; surface_set_by: string | null }>('SELECT surface, surface_set_by FROM oauth_clients WHERE client_id = $1', [clientId]))[0];
    const toolNames = (body: { tools?: Array<{ name: string }> }) => (body.tools ?? []).map(t => t.name);

    test('both: the surface is written as a surface-only call writes it, and the descriptors come back', async () => {
      const both = await call({ surface: 'starter', tools: ['search', 'get_page', 'list_pages'] }, 'gbra449-a');
      expect(both.isError).toBe(false);
      expect(await surfaceOf('gbra449-a')).toEqual({ surface: 'starter', surface_set_by: 'self' });
      const surfaceOnly = await call({ surface: 'starter' }, 'gbra449-b');
      expect(both.body.surface_change).toEqual(surfaceOnly.body);
      const toolsOnly = await call({ tools: ['search', 'get_page', 'list_pages'] }, 'gbra449-b');
      expect(toolNames(both.body)).toEqual(['search', 'get_page', 'list_pages']);
      expect({ ...both.body, surface_change: undefined }).toEqual({ ...toolsOnly.body, surface_change: undefined });
    });

    test('both: a surface above the ceiling refuses the pair as a surface-only call does, and writes nothing', async () => {
      const both = await call({ surface: 'full', tools: ['search'] }, 'gbra449-a', 'starter');
      const surfaceOnly = await call({ surface: 'full' }, 'gbra449-a', 'starter');
      expect(both.isError).toBe(true);
      expect(both.body).toEqual(surfaceOnly.body);
      expect(both.body.code).toBe('permission_denied');
      expect(await surfaceOf('gbra449-a')).toEqual({ surface: null, surface_set_by: null });
    });

    test('both: an operator-pinned client is refused as a surface-only call is', async () => {
      const both = await call({ surface: 'starter', tools: ['search'] }, 'gbra449-pinned');
      expect(both.isError).toBe(true);
      expect(both.body).toEqual((await call({ surface: 'starter' }, 'gbra449-pinned')).body);
      expect(await surfaceOf('gbra449-pinned')).toEqual({ surface: 'verbs', surface_set_by: 'operator' });
    });

    test('both: a tool outside the ceiling is left out as a tools-only call leaves it out', async () => {
      const both = await call({ surface: 'starter', tools: ['search', 'get_health'] }, 'gbra449-a', 'starter');
      const toolsOnly = await call({ tools: ['search', 'get_health'] }, 'gbra449-b', 'starter');
      expect(toolNames(toolsOnly.body)).toEqual(['search']);
      expect(toolNames(both.body)).toEqual(['search']);
      expect(both.body.surface_change).toMatchObject({ persisted: true, surface: 'starter' });
    });

    test('each argument alone keeps its answer', async () => {
      expect((await call({ surface: 'starter' }, 'gbra449-a')).body).toEqual({ persisted: true, surface: 'starter', note: 're-issue tools/list to see the new catalog' });
      const tools = (await call({ tools: ['search'] }, 'gbra449-a')).body;
      expect(Object.keys(tools)).toEqual(['tools']);
      expect(toolNames(tools)).toEqual(['search']);
    });
  });
}
