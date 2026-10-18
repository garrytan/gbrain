/**
 * #6650 (L3): writer terminal-failure counts on `GET /metrics`.
 *
 * Protects: the real `mountMetrics` handler appends per-source gauges (active blockers, unresolved, historical, new in
 * 24 h, defects) read from the same bounded aggregate doctor uses; the counts stay behind requireAdmin and never reach
 * the public `/health`; an aggregate that did not finish reports `known 0` with no per-source series, never zeros; scrapes
 * within `TERMINAL_METRICS_TTL_MS` (60 s) share one aggregate query.
 * PGLite in-memory, a bare Express app wired with the real mount functions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cachedTerminalSummary, createMetricsCounters, mountHealth, mountMetrics, renderTerminalFailureMetrics, TERMINAL_METRICS_TTL_MS } from '../src/commands/serve-http-metrics.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';

const SOURCE = 'metrics-src';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  for (const origin of ['owner_exception', 'owner_exception', 'file_database_drift']) {
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
        state,error_code,error_message,error_detail,intent,completed_at,updated_at,admitter_version)
      VALUES('local_cli','fixture',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,'failed',$5,'x',$6::text::jsonb,'{"content":"x"}'::jsonb,
        now()-interval '1 hour',now()-interval '1 hour','0.60.216.0')`,
    [randomUUID(), SOURCE, `notes/${randomUUID()}`, randomUUID(), origin === 'owner_exception' ? 'storage_error' : 'file_database_drift', JSON.stringify({ origin })]);
  }
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function withApp<T>(authed: boolean, fn: (base: string) => Promise<T>, brain: BrainEngine = engine): Promise<T> {
  const app = express();
  const requireAdmin = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (authed) { next(); return; }
    res.status(401).json({ error: 'Admin authentication required' });
  };
  const ctx = { engine: brain, config: { engine: 'pglite' }, requireAdmin, metricsCounters: createMetricsCounters() } as unknown as ServeHttpContext;
  mountHealth(app, ctx);
  mountMetrics(app, ctx);
  const server: Server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address();
  try { return await fn(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('terminal-failure gauges on /metrics', () => {
  test('an admin scrape carries per-source counts from the aggregate', async () => {
    await withApp(true, async base => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('gbrain_requests_total 0');
      expect(text).toContain('gbrain_writer_terminal_failures_known 1');
      expect(text).toContain(`gbrain_writer_terminal_failures_unresolved{source="${SOURCE}"} 3`);
      expect(text).toContain(`gbrain_writer_terminal_failures_defects{source="${SOURCE}"} 2`);
      expect(text).toContain(`gbrain_writer_terminal_failures_active_blockers{source="${SOURCE}"} 0`);
      expect(text).toContain(`gbrain_writer_terminal_failures_new_24h{source="${SOURCE}"} 3`);
      expect(text).toContain('# TYPE gbrain_writer_terminal_failures_historical gauge');
    });
  });

  test('the counts never leave the admin gate: 401 on /metrics, absent from /health', async () => {
    await withApp(false, async base => {
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(401);
      expect(await metrics.text()).not.toContain('terminal_failures');
      const health = await fetch(`${base}/health`);
      const body = await health.text();
      expect(body).not.toContain('terminal');
      expect(body).not.toContain(SOURCE);
    });
  });

  test('scrapes inside the TTL share one aggregate query; the next one after it reads again', async () => {
    let queries = 0;
    const counted = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: unknown) => {
        if (sql.includes('GROUPING SETS')) queries++;
        return target.executeRaw(sql, params, opts as never);
      };
      return Reflect.get(target, key);
    } }) as BrainEngine;
    await withApp(true, async base => {
      const [a, b] = await Promise.all([fetch(`${base}/metrics`), fetch(`${base}/metrics`)]);
      const c = await fetch(`${base}/metrics`);
      for (const res of [a, b, c]) expect(await res.text()).toContain(`gbrain_writer_terminal_failures_unresolved{source="${SOURCE}"} 3`);
    }, counted);
    expect(queries).toBe(1);
    await cachedTerminalSummary(counted, Date.now() + TERMINAL_METRICS_TTL_MS - 1_000);
    expect(queries).toBe(1);
    await cachedTerminalSummary(counted, Date.now() + TERMINAL_METRICS_TTL_MS + 1);
    expect(queries).toBe(2);
  });

  test('an unknown aggregate is known 0 with no per-source zeros', () => {
    const text = renderTerminalFailureMetrics({ status: 'unknown', window_days: 7, reason: 'deadline' });
    expect(text).toContain('gbrain_writer_terminal_failures_known 0');
    expect(text).not.toContain('{source=');
  });

  test('a source label is escaped for the exposition format', () => {
    const empty = { active_blockers: [], unresolved: { rows: 1, distinct_slugs: 1, distinct_intents: 1, oldest_at: null, oldest_age_seconds: null }, historical_rows: 0,
      new_last_24h: 0, new_last_24h_older_builds: { rows: 0, builds: [] }, daily_7d: [0, 0, 0, 0, 0, 0, 0], defects: [], categories: [] };
    const text = renderTerminalFailureMetrics({ status: 'ok', window_days: 7, window_clamped: false, retention_days: 30, sources: [{ source_id: 'a"b\\c', ...empty }] });
    expect(text).toContain('gbrain_writer_terminal_failures_unresolved{source="a\\"b\\\\c"} 1');
  });
});
