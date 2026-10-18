/**
 * #6543: three vendored-driver defects behind the managed Supabase serve wedge
 * (Supavisor transaction pooler, port 6543). Each runs against direct Postgres;
 * no pooler is needed to show the driver's half.
 *
 * 1. A socket that closed under a failed statement left its ErrorResponse
 *    behind, and the replacement connection handed it to its first statement:
 *    a stale `57P01` on direct Postgres, `XX000 DbHandler exited` through
 *    Supavisor, so one terminated backend cost two failures.
 * 2. A statement that failed to build reported its connection ready for more,
 *    so a pool built with `max_pipeline: 0` (gbrain's transaction-pooler pools)
 *    still pipelined the next statement behind the Unbuildable query.
 * 3. `UNDEFINED_VALUE` did not say which parameter was undefined, so the
 *    report's two build failures could not be traced to a column.
 *
 * Regression that fails it on the base driver: case 1's queued statement
 * rejects `57P01`; case 2's pool reads `{ busy: 1, full: 0, queued: 0 }`;
 * case 3's `onbuilderror` gets two arguments.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
afterEach(async () => { while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {}); });

type Settled = { rows: unknown[] } | { code: string } | { hung: true };
function settle(query: PromiseLike<unknown>, ms = 8000): Promise<Settled> {
  return Promise.race([
    Promise.resolve(query).then(rows => ({ rows: Array.from(rows as unknown[]) }), (e: { code?: string; message?: string }) => ({ code: e.code ?? e.message ?? 'error' })),
    new Promise<Settled>(resolve => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}
function pool(options: Record<string, unknown>) {
  assertSafeE2eDatabaseUrl(url!);
  const appName = `gbrain-6543-${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: appName }, ...options } as Parameters<typeof postgres>[1]);
  opened.push(sql);
  return { sql, appName };
}
function admin() {
  assertSafeE2eDatabaseUrl(url!);
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  opened.push(sql);
  return sql;
}

describe.skipIf(!url)('#6543 vendored driver', () => {
  test('a terminated backend does not hand its 57P01 to the first statement of the replacement connection', async () => {
    const { sql, appName } = pool({});
    await sql`SELECT 1`;
    const head = settle(sql`SELECT pg_sleep(5), 'head' AS who`);
    // Describe-first (an untyped parameter under prepare: false): the pool routes nothing more to the connection behind it.
    const describeFirst = settle(sql`SELECT 'n1' AS who, ${1}::int AS n`);
    const queued = settle(sql`SELECT 'n2' AS who`);
    await new Promise(r => setTimeout(r, 500));
    const a = admin();
    await a`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${appName}`;
    expect(await head).toEqual({ code: 'CONNECTION_CLOSED' });
    expect(await describeFirst).toEqual({ code: 'CONNECTION_CLOSED' });
    expect(await queued).toEqual({ rows: [{ who: 'n2' }] });
  }, 30_000);

  test('a statement that fails to build leaves the connection unroutable when max_pipeline forbids pipelining', async () => {
    const { sql } = pool({ max_pipeline: 0 });
    await sql`SELECT 1`;
    const culprit = settle(sql`SELECT ${undefined as unknown as string}::text AS who`);
    const next = settle(sql`SELECT 'next' AS who`);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const routed = (sql as unknown as { pool: { busy: number; full: number; queued: number } }).pool;
    expect({ busy: routed.busy, full: routed.full, queued: routed.queued }).toEqual({ busy: 0, full: 1, queued: 1 });
    expect(await culprit).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await next).toEqual({ rows: [{ who: 'next' }] });
  }, 30_000);

  test('UNDEFINED_VALUE names the parameter', async () => {
    const builds: unknown[][] = [];
    const { sql } = pool({ onbuilderror: (...args: unknown[]) => builds.push(args) });
    const r = await settle(sql`SELECT ${'a'}::text, ${undefined as unknown as string}::text`);
    expect(r).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(builds).toEqual([['UNDEFINED_VALUE', 'SELECT $1::text, $2::text', 2]]);
  }, 30_000);
});
