/**
 * #6383: the vendored driver's in-flight watchdog and live pool numbers.
 *
 * A connection whose head statement has waited `inflight_timeout` seconds
 * with nothing coming back from the server (a desynced pipeline, a
 * transaction pooler that swallowed a CancelRequest, a dead peer) is retired:
 * the statement and everything queued behind it reject with
 * `CONNECTION_STUCK`, the pool reports it once through `onstuck`, the
 * connection leaves rotation before its socket closes, and the next statement
 * runs on a fresh connection. A statement the server answers in time is never
 * retired, because the budget is at least the server's own statement timeout.
 *
 * `sql.pool` used to be a construction-time snapshot (Object.assign read the
 * getter once), so `busy` was always 0; it is live now and carries the oldest
 * in-flight age and the completed count the stall watch and `/health?deep=1`
 * read. Regression that fails it on master: `busy` stays 0 during `pg_sleep`,
 * and a statement the server never answers hangs forever instead of
 * rejecting with `CONNECTION_STUCK`.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];

afterEach(async () => {
  while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {});
});

type Settled = { rows: unknown[] } | { code: string } | { hung: true };

function settle(query: PromiseLike<unknown>, ms = 5000): Promise<Settled> {
  return Promise.race([
    Promise.resolve(query).then(rows => ({ rows: rows as unknown[] }), (e: { code?: string; message?: string }) => ({ code: e.code ?? e.message ?? 'error' })),
    new Promise<Settled>(resolve => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}

function pool(max: number, inflightTimeout: number | null, stucks: unknown[]) {
  assertSafeE2eDatabaseUrl(url!);
  const sql = postgres(url!, {
    max,
    prepare: false,
    onnotice: () => {},
    // No server-side statement_timeout on these connections: the watchdog is the only bound.
    connection: { application_name: `gbrain-6383-stuck-${Math.random().toString(36).slice(2)}` },
    inflight_timeout: inflightTimeout,
    onstuck: (info: unknown) => { stucks.push(info); },
  } as Parameters<typeof postgres>[1]);
  opened.push(sql);
  return sql;
}

describe.skipIf(!url)('#6383 in-flight watchdog and live pool numbers', () => {
  test('sql.pool is live: busy and inflight_oldest_ms move while a statement runs, completed counts settled statements', async () => {
    const sql = pool(2, null, []);
    await sql`SELECT 1`;
    const before = sql.pool;
    expect(before.open).toBe(1);
    expect(before.busy).toBe(0);
    const slow = sql`SELECT pg_sleep(0.4)`.execute();
    await new Promise(r => setTimeout(r, 150));
    const during = sql.pool;
    expect(during.busy + during.full).toBe(1);
    expect(during.inflight_oldest_ms).toBeGreaterThanOrEqual(100);
    await slow;
    const after = sql.pool;
    expect(after.busy + after.full).toBe(0);
    expect(after.inflight_oldest_ms).toBe(0);
    expect(after.completed).toBeGreaterThan(before.completed);
  });

  test('a statement the server never answers in time rejects with CONNECTION_STUCK, its queued follower too, and the pool recovers on a fresh connection', async () => {
    const stucks: Array<{ age_ms: number; queued: number; statement: string }> = [];
    const sql = pool(1, 1, stucks);
    await sql`SELECT 1`;
    const started = Date.now();
    const slow = settle(sql`SELECT pg_sleep(5), 'slow' AS who`);
    await new Promise(r => setTimeout(r, 100));
    const follower = settle(sql`SELECT 'follower' AS who`);
    expect(await slow).toEqual({ code: 'CONNECTION_STUCK' });
    expect(await follower).toEqual({ code: 'CONNECTION_STUCK' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stucks).toHaveLength(1);
    expect(stucks[0].queued).toBe(1);
    expect(stucks[0].age_ms).toBeGreaterThanOrEqual(900);
    expect(stucks[0].statement).toBe("SELECT pg_sleep(5), 'slow' AS who");
    expect(sql.pool.busy + sql.pool.full).toBe(0);
    expect(await settle(sql`SELECT 'fresh' AS who`)).toEqual({ rows: [{ who: 'fresh' }] });
    expect(sql.pool.inflight_oldest_ms).toBe(0);
  });

  test('a stuck reserved connection rejects its holder and the pool serves the next caller', async () => {
    const stucks: unknown[] = [];
    const sql = pool(1, 1, stucks);
    const reserved = await sql.reserve();
    expect(await settle(reserved`SELECT pg_sleep(5)`)).toEqual({ code: 'CONNECTION_STUCK' });
    expect(await settle(reserved`SELECT 1`)).toEqual({ code: 'CONNECTION_DESTROYED' });
    reserved.release();
    expect(await settle(sql`SELECT 'next' AS who`)).toEqual({ rows: [{ who: 'next' }] });
    expect(stucks).toHaveLength(1);
  });

  test('a statement answered within the budget is never retired, and a null budget disables the watchdog', async () => {
    const stucks: unknown[] = [];
    const bounded = pool(1, 2, stucks);
    expect(await settle(bounded`SELECT pg_sleep(0.5), 1 AS x`)).toEqual({ rows: [{ pg_sleep: '', x: 1 }] });
    const unbounded = pool(1, null, stucks);
    expect(await settle(unbounded`SELECT pg_sleep(1.2), 2 AS x`)).toEqual({ rows: [{ pg_sleep: '', x: 2 }] });
    expect(stucks).toEqual([]);
  });

  test('engine: a stuck connection is counted once, logged as one pg_connection_stuck line, and seen by getPoolDiagnostics', async () => {
    assertSafeE2eDatabaseUrl(url!);
    const previous = { grace: process.env.GBRAIN_PG_STUCK_GRACE_MS, timeout: process.env.GBRAIN_STATEMENT_TIMEOUT };
    // Budget = statement_timeout (500 ms) + grace (500 ms) = 1 s. The session below lifts its own server-side
    // statement_timeout first, so the sleep is only ever ended by the watchdog.
    process.env.GBRAIN_STATEMENT_TIMEOUT = '500ms';
    process.env.GBRAIN_PG_STUCK_GRACE_MS = '500';
    const engine = new PostgresEngine();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await engine.connect({ engine: 'postgres', database_url: url!, poolSize: 2 });
      const stuck = await settle(engine.withReservedConnection(async conn => {
        await conn.executeRaw('SET statement_timeout = 0');
        await conn.executeRaw('SELECT pg_sleep(5)');
      }), 6000);
      expect(stuck).toEqual({ code: 'CONNECTION_STUCK' });
      const diagnostics = engine.getPoolDiagnostics();
      expect(diagnostics?.stuckDiscards).toBe(1);
      expect(diagnostics?.pool?.inflight_oldest_ms).toBe(0);
      const rows = await engine.executeRaw<{ x: number }>('SELECT 1 AS x');
      expect(rows).toEqual([{ x: 1 }]);
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('pg_connection_stuck'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('pool=read');
      expect(lines[0]).toContain('sql=SELECT');
      expect(lines[0]).not.toContain('pg_sleep');
      expect(lines[0]).not.toContain(url!);
    } finally {
      warn.mockRestore();
      await engine.disconnect();
      if (previous.grace === undefined) delete process.env.GBRAIN_PG_STUCK_GRACE_MS; else process.env.GBRAIN_PG_STUCK_GRACE_MS = previous.grace;
      if (previous.timeout === undefined) delete process.env.GBRAIN_STATEMENT_TIMEOUT; else process.env.GBRAIN_STATEMENT_TIMEOUT = previous.timeout;
    }
  });
});
