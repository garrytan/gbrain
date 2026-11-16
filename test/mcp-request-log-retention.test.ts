/**
 * Request-log retention (#6770 rewrite): `cycle.purge.mcp_request_log_retention_days`
 * prunes `mcp_request_log` rows past the window into the per-token tally
 * `mcp_request_log_rollup`, in the same statement that deletes them.
 *
 * Authoring gate: (1) protects the opt-in deletion contract (off by default,
 * 30-day minimum, audit rows never pruned, lifetime totals exact, a failed
 * tally deletes nothing, a capped run resumes and never overstates how far it
 * pruned) and the two places it runs (the cycle purge phase, and the PGLite
 * lock owner's resident ticker under a live `serve --http`); (2) fails when a
 * prune drops rows without counting them, touches an audit row or a row inside
 * the window, or runs with retention unset; (3) nothing pruned this table
 * before; (4) the prune takes batch-size and cap options that production
 * leaves at their defaults.
 *
 * Repo-less: every brain here is a database with no git checkout, the default
 * keyless install. PGLite always; PostgreSQL too when DATABASE_URL is set
 * (test/e2e/mcp-request-log-retention-postgres.test.ts), which adds the
 * two-prunes-at-once case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runConfig } from '../src/commands/config.ts';
import { runServe } from '../src/commands/serve.ts';
import {
  MCP_LOG_RETENTION_KEY,
  lifetimeUsage,
  mcpLogRetentionRefusal,
  pruneMcpRequestLog,
  readLastMcpLogPrune,
  readMcpLogRetentionDays,
  runMcpLogRetention,
  startMcpLogPruneTicker,
} from '../src/core/mcp-request-log-retention.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

async function seed(engine: BrainEngine, token: string | null, operation: string, count: number, daysAgo: number, status = 'success'): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, created_at)
       VALUES ($1, $1, $2, 5, $3, now() - ($4::float8 * interval '1 day') - ($5::int * interval '1 second'))`,
      [token, operation, status, daysAgo, i],
    );
  }
}

async function logCount(engine: BrainEngine, where = 'TRUE'): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_request_log WHERE ${where}`);
  return row!.n;
}

async function rollup(engine: BrainEngine): Promise<Map<string, { requests: number; last_used_at: string | null; pruned_through: string | null }>> {
  const rows = await engine.executeRaw<{ token_name: string; requests: string | number; last_used_at: unknown; pruned_through: unknown }>(
    'SELECT token_name, requests, last_used_at, pruned_through FROM mcp_request_log_rollup');
  const iso = (v: unknown) => (v === null ? null : new Date(v as string).toISOString());
  return new Map(rows.map(r => [r.token_name, { requests: Number(r.requests), last_used_at: iso(r.last_used_at), pruned_through: iso(r.pruned_through) }]));
}

async function purgeDetails(engine: BrainEngine): Promise<Record<string, unknown>> {
  const report = await runCycle(engine, { brainDir: mkdtempSync(join(tmpdir(), 'gb-mcp-log-cycle-')), phases: ['purge'] });
  const phase = report.phases.find(p => p.phase === 'purge')!;
  expect(phase.status).not.toBe('fail');
  return phase.details;
}

for (const kind of testBackends()) {
  describe(`request-log retention (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM mcp_request_log');
      await engine.executeRaw('DELETE FROM mcp_request_log_rollup');
      await engine.unsetConfig(MCP_LOG_RETENTION_KEY);
    });

    test('retention is off by default: the cycle purge deletes nothing and reports nothing', async () => {
      await seed(engine, 'alice-client', 'query', 5, 400);
      expect(await readMcpLogRetentionDays(engine)).toBeNull();
      const details = await purgeDetails(engine);
      expect(details.purged_mcp_request_log_count).toBeUndefined();
      expect(await logCount(engine)).toBe(5);
      expect((await rollup(engine)).size).toBe(0);
      expect(await runMcpLogRetention(engine)).toBeNull();
    }, 60_000);

    test('retention 30: the cycle purge moves every row class past the window into the tally and lifetime totals stay exact', async () => {
      // Every row class the dashboard's total_requests counts today.
      await seed(engine, 'alice-client', 'query', 3, 40);
      await seed(engine, 'alice-client', 'tools/list', 2, 41);
      await seed(engine, 'alice-client', 'advisor', 1, 42, 'denied_after_list');
      await seed(engine, 'alice-client', 'search', 1, 43, 'error');
      await seed(engine, 'alice-client', 'webhook_ingest', 1, 44);
      await seed(engine, 'alice-client', 'tools/call:search', 1, 45);
      await seed(engine, 'alice-client', 'query', 2, 5);
      await seed(engine, null, 'tools/list', 2, 50);
      await seed(engine, 'acme-client', 'query', 1, 10);
      const before = new Map((await engine.executeRaw<{ token_name: string; n: number; last: unknown }>(
        `SELECT token_name, count(*)::int AS n, max(created_at) AS last FROM mcp_request_log WHERE token_name IS NOT NULL GROUP BY token_name`))
        .map(r => [r.token_name, { requests: r.n, last_used_at: new Date(r.last as string).toISOString() }]));

      await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
      const details = await purgeDetails(engine);
      expect(details.purged_mcp_request_log_count).toBe(11);
      expect(await logCount(engine)).toBe(3);
      expect(await logCount(engine, "created_at < now() - interval '30 days'")).toBe(0);

      const after = await lifetimeUsage(engine, ['alice-client', 'acme-client']);
      expect(after.get('alice-client')).toEqual(before.get('alice-client'));
      expect(after.get('acme-client')).toEqual(before.get('acme-client'));
      const tally = await rollup(engine);
      expect(tally.get('alice-client')?.requests).toBe(9);
      // A NULL token_name counts under '' so the pruned-before date is never lost.
      expect(tally.get('')?.requests).toBe(2);
      expect(tally.has('acme-client')).toBe(false);

      const last = await readLastMcpLogPrune(engine);
      expect(last).toMatchObject({ deleted: 11, capped: false });
      expect(Date.now() - Date.parse(last!.at)).toBeLessThan(60_000);
    }, 60_000);

    test('surface_change, memory_setting_change and access_admin audit rows survive past the window', async () => {
      await seed(engine, 'alice-client', 'surface_change', 2, 400);
      await seed(engine, 'alice-client', 'memory_setting_change', 1, 400);
      await seed(engine, 'admin-api', 'access_admin', 1, 400);
      await seed(engine, 'alice-client', 'query', 4, 400);
      await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
      expect((await runMcpLogRetention(engine))?.deleted).toBe(4);
      expect(await logCount(engine, "operation IN ('surface_change', 'memory_setting_change', 'access_admin')")).toBe(4);
      expect(await logCount(engine)).toBe(4);
    }, 60_000);

    test('a capped run leaves the rest for the next run, and pruned_through never passes the oldest surviving row', async () => {
      await seed(engine, 'alice-client', 'query', 10, 60);
      const first = await pruneMcpRequestLog(engine, 30, { batchSize: 3, maxBatches: 2 });
      expect(first).toMatchObject({ deleted: 6, capped: true, skipped: null });
      const [oldest] = await engine.executeRaw<{ at: unknown }>('SELECT min(created_at) AS at FROM mcp_request_log');
      const through = (await rollup(engine)).get('alice-client')!.pruned_through!;
      expect(Date.parse(through)).toBeLessThanOrEqual(new Date(oldest!.at as string).getTime());
      expect(first.pruned_through).toBe(through);
      const second = await pruneMcpRequestLog(engine, 30);
      expect(second).toMatchObject({ deleted: 4, capped: false });
      expect(await logCount(engine)).toBe(0);
      expect((await rollup(engine)).get('alice-client')!.requests).toBe(10);
    }, 60_000);

    test('a failure inside the delete-and-tally statement deletes nothing', async () => {
      await seed(engine, 'alice-client', 'query', 5, 60);
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION mcp_rollup_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced tally failure'; END $$`);
      await engine.executeRaw('CREATE TRIGGER mcp_rollup_test_fail BEFORE INSERT ON mcp_request_log_rollup FOR EACH ROW EXECUTE FUNCTION mcp_rollup_test_fail()');
      try {
        await expect(pruneMcpRequestLog(engine, 30)).rejects.toThrow('forced tally failure');
        expect(await logCount(engine)).toBe(5);
        expect((await rollup(engine)).size).toBe(0);
      } finally {
        await engine.executeRaw('DROP TRIGGER mcp_rollup_test_fail ON mcp_request_log_rollup');
        await engine.executeRaw('DROP FUNCTION mcp_rollup_test_fail()');
      }
    }, 60_000);

    test('a brain without the tally table (not migrated yet) skips the prune and deletes nothing', async () => {
      await seed(engine, 'alice-client', 'query', 5, 60);
      await engine.executeRaw('ALTER TABLE mcp_request_log_rollup RENAME TO mcp_request_log_rollup_hidden');
      try {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(await pruneMcpRequestLog(engine, 30)).toMatchObject({ deleted: 0, capped: false, skipped: 'no_rollup_table' });
        } finally { warn.mockRestore(); }
        expect(await logCount(engine)).toBe(5);
        expect((await lifetimeUsage(engine, ['alice-client'])).get('alice-client')?.requests).toBe(5);
      } finally {
        await engine.executeRaw('ALTER TABLE mcp_request_log_rollup_hidden RENAME TO mcp_request_log_rollup');
      }
    }, 60_000);

    test('config set refuses 1-29, fractions and values above 3650; nothing is written', async () => {
      for (const bad of ['1', '7', '29', '45.5', '3651', 'thirty']) {
        const refusal = mcpLogRetentionRefusal(bad);
        expect(refusal).toContain('nothing was written');
        expect(refusal).toContain('30');
      }
      for (const ok of ['30', '90', '3650', '0', 'off', 'OFF']) expect(mcpLogRetentionRefusal(ok)).toBeNull();

      const errs: string[] = [];
      let exit: number | null = null;
      const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
      try { await runConfig(engine, ['set', MCP_LOG_RETENTION_KEY, '7']); }
      catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
      finally { errSpy.mockRestore(); logSpy.mockRestore(); exitSpy.mockRestore(); }
      expect(exit).not.toBeNull();
      expect(exit).not.toBe(0);
      expect(errs.join('\n')).toContain('nothing was written');
      expect(await engine.getConfig(MCP_LOG_RETENTION_KEY)).toBeNull();

      await engine.setConfig(MCP_LOG_RETENTION_KEY, 'off');
      expect(await readMcpLogRetentionDays(engine)).toBeNull();
      await engine.setConfig(MCP_LOG_RETENTION_KEY, '0');
      expect(await readMcpLogRetentionDays(engine)).toBeNull();
      await engine.setConfig(MCP_LOG_RETENTION_KEY, '90');
      expect(await readMcpLogRetentionDays(engine)).toBe(90);
    }, 60_000);

    test('the resident prune ticker arms only on PGLite, where a live serve owns the lock', async () => {
      await seed(engine, 'alice-client', 'query', 4, 60);
      await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
      const armed: number[] = [];
      const ticker = startMcpLogPruneTicker(engine, { setInterval: (_fn, ms) => { armed.push(ms); return armed.length; }, clearInterval: () => {} });
      try {
        if (kind === 'pglite') {
          expect(armed).toHaveLength(1);
          expect((await ticker.tick())?.deleted).toBe(4);
          expect(await logCount(engine)).toBe(0);
        } else {
          expect(armed).toHaveLength(0);
          expect(await ticker.tick()).toBeNull();
          expect(await logCount(engine)).toBe(4);
        }
      } finally { ticker.stop(); }
    }, 60_000);

    if (kind === 'postgres') {
      test('two prunes at once never double-count (SKIP LOCKED)', async () => {
        await engine.executeRaw(
          `INSERT INTO mcp_request_log (token_name, operation, status, created_at)
           SELECT 'alice-client', 'query', 'success', now() - interval '60 days' - (g * interval '1 second') FROM generate_series(1, 6000) g`);
        const [a, b] = await Promise.all([pruneMcpRequestLog(engine, 30, { batchSize: 500 }), pruneMcpRequestLog(engine, 30, { batchSize: 500 })]);
        expect(a.deleted + b.deleted).toBe(6000);
        expect(await logCount(engine)).toBe(0);
        expect((await rollup(engine)).get('alice-client')!.requests).toBe(6000);
      }, 120_000);
    }
  });
}

if (!testBackends().every(kind => kind === 'postgres')) {
  describe('a PGLite brain under a live serve --http prunes on its own (repo-less)', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }, 120_000);
    afterAll(async () => { await engine.disconnect().catch(() => {}); });

    test('the serve lane arms the ticker while the HTTP server runs and stops it after', async () => {
      await seed(engine, 'alice-client', 'query', 3, 60);
      await seed(engine, 'alice-client', 'query', 2, 1);
      await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
      const ticks: Array<() => unknown> = [];
      let cleared = 0;
      let deletedWhileServing = -1;
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runServe(engine as unknown as BrainEngine, ['--http'], {
          exit: () => {},
          log: () => {},
          stallWatchdogMs: 0,
          armCorpusDrain: () => null,
          mcpLogPrune: { setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => { cleared++; } },
          runServeHttp: async () => {
            expect(ticks).toHaveLength(1);
            await ticks[0]!();
            deletedWhileServing = 3 - (await logCount(engine, "created_at < now() - interval '30 days'"));
          },
        });
      } finally { errSpy.mockRestore(); }
      expect(deletedWhileServing).toBe(3);
      expect(cleared).toBe(1);
    }, 60_000);
  });
}
