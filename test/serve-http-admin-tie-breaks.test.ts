/**
 * Admin dashboard lists cut by a limit pick the same tied rows on every database.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: three admin routes return the same rows, in the same order, on PGLite and Postgres when the sort key
 *    ties. GET /admin/api/calibration/pattern/:id keeps the first 25 resolved takes by lowest take id when weight and
 *    since_date tie; GET /admin/api/calibration/charts/abandoned-threads keeps the first 5 by lowest take id when
 *    since_date ties; GET /admin/api/requests pages the request log newest first with the highest id first when
 *    created_at ties, so page 1 and page 2 neither repeat nor skip a row.
 *  - Regression: the three statements ended at a sort key that rows share (weight and since_date, since_date,
 *    created_at), so a limit or an offset cut a tied set in whatever order the engine met the rows.
 *  - Why existing coverage misses it: serve-http-admin-request-log-retention seeds one row per distinct created_at,
 *    and no test covers the two calibration routes with more tied rows than the limit.
 *  - Seam: none. The real routes are mounted on an Express app over a real socket, as the retention test does. This is
 *    an HTTP route test, not a parityTest case: it seeds through executeRaw, so the Rust arm does not run it. The routes
 *    read through listTopResolvedTakesForHolder, listAbandonedTakes and readMcpRequestLogPage (engine-sql/takes-reads.ts
 *    and telemetry.ts), so the statements under test are those members' SQL. Tied rows are rewritten one by one in a scrambled order after the insert, so their heap order is
 *    neither id order nor reverse id order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountAdminApi } from '../src/commands/serve-http-admin-api.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const pad = (n: number) => String(n).padStart(2, '0');
/** A permutation of 0..count-1 that is neither ascending nor descending. */
const scrambled = (count: number) => Array.from({ length: count }, (_, i) => (i * 7 + 3) % count);

for (const kind of testBackends()) {
  describe('admin lists cut by a limit over tied sort keys (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: Server;
    let base = '';

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      const app = express();
      const ctx = {
        engine, config: { engine: kind }, sql: sqlQueryForEngine(engine),
        requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
        adminSessions: new Map(), sseClients: new Set(), oauthProvider: {},
        issuerUrl: new URL('http://127.0.0.1/'), mcpResourceUrl: new URL('http://127.0.0.1/mcp'),
      } as unknown as ServeHttpContext;
      mountAdminApi(app, ctx);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', () => r()));
      base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    }, 120_000);
    afterAll(async () => {
      server?.closeAllConnections();
      await new Promise<void>(r => server ? server.close(() => r()) : r());
      await close?.();
    });

    /** Insert `count` takes in claim order, then rewrite them one by one in a scrambled order. */
    async function seedTakes(slug: string, holder: string, count: number, tied: { weight: number; since: string }, resolved: boolean): Promise<void> {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body of ' + slug, timeline: '' });
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
      await engine.addTakesBatch(Array.from({ length: count }, (_, i) => ({
        page_id: page!.id, row_num: i + 1, claim: `${slug} claim ${pad(i + 1)}`, kind: 'take', holder,
        weight: tied.weight, since_date: tied.since,
      })));
      for (const i of scrambled(count)) {
        await engine.executeRaw(
          resolved
            ? 'UPDATE takes SET resolved_at = now() WHERE page_id = $1 AND row_num = $2'
            : 'UPDATE takes SET updated_at = now() WHERE page_id = $1 AND row_num = $2',
          [page!.id, i + 1]);
      }
    }

    test('pattern drill-down keeps the 25 lowest take ids when weight and since_date tie', async () => {
      await engine.executeRaw(
        `INSERT INTO calibration_profiles (source_id, holder, total_resolved, domain_scorecards, pattern_statements, voice_gate_passed, voice_gate_attempts, active_bias_tags, model_id)
         VALUES ('default', 'tie-holder', 30, '{}'::jsonb, ARRAY['you hedge'], true, 1, ARRAY[]::text[], 'test-model')`);
      await seedTakes('tie/pattern', 'tie-holder', 30, { weight: 0.8, since: '2025-03-01' }, true);

      const res = await fetch(base + '/admin/api/calibration/pattern/1?holder=tie-holder');
      expect(res.status).toBe(200);
      const body = await res.json() as { takes: Array<{ id: string; claim: string }> };
      expect(body.takes.map(t => t.claim)).toEqual(Array.from({ length: 25 }, (_, i) => `tie/pattern claim ${pad(i + 1)}`));
      const ids = body.takes.map(t => Number(t.id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    test('abandoned-threads chart keeps the 5 lowest take ids when since_date ties', async () => {
      await seedTakes('tie/abandoned', 'tie-abandoned', 9, { weight: 0.9, since: '2020-01-01' }, false);

      const res = await fetch(base + '/admin/api/calibration/charts/abandoned-threads?holder=tie-abandoned');
      expect(res.status).toBe(200);
      const svg = await res.text();
      const claims = [...svg.matchAll(/tie\/abandoned claim \d+/g)].map(m => m[0]);
      expect(claims).toEqual(Array.from({ length: 5 }, (_, i) => `tie/abandoned claim ${pad(i + 1)}`));
    });

    test('request log pages split a created_at tie by highest id with no repeat or skip', async () => {
      // One statement: every row gets the same now().
      await engine.executeRaw(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status)
         SELECT 'tie-agent', 'tie-agent', 'query', g, 'success' FROM generate_series(1, 120) AS g`);
      const logged = await engine.executeRaw<{ id: number }>("SELECT id FROM mcp_request_log WHERE token_name = 'tie-agent' ORDER BY id");
      expect(logged.length).toBe(120);
      for (const i of scrambled(120)) {
        await engine.executeRaw('UPDATE mcp_request_log SET latency_ms = latency_ms + 1000 WHERE id = $1', [logged[i]!.id]);
      }

      const page = async (n: number) => (await (await fetch(base + `/admin/api/requests?agent=tie-agent&page=${n}`)).json() as { rows: Array<{ id: number }>; total: number });
      const [one, two] = [await page(1), await page(2)];
      expect(one.total).toBe(120);
      const ids = [...one.rows, ...two.rows].map(r => Number(r.id));
      const wanted = logged.map(r => Number(r.id)).sort((a, b) => b - a).slice(0, 100);
      expect(one.rows.length).toBe(50);
      expect(two.rows.length).toBe(50);
      expect(ids).toEqual(wanted);
    });
  });
}
