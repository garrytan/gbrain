/**
 * Vendored driver (vendor/postgres): a query cancelled while it waited behind another one on the same connection
 * had already been written to the server. The stock ReadyForQuery loop skipped it, so the answer the server still
 * sent for it was read for the next query: the next query resolved with the cancelled statement's rows (a bare
 * count resolved to []) and the cancelled query never settled. The cancelled query now stays current, absorbs its
 * own answer and rejects as cancelled (57014); every later query reads its own rows. q3 sleeps, so a server cancel
 * sent for q2 while q3 is pipelined behind it would land on q3; none is sent. Runs direct and, when
 * the CI PgBouncer fixture is configured (GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL), through PgBouncer
 * in transaction mode against a database of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('The cancel pipeline PgBouncer twin requires the configured CI PgBouncer fixture.');
const pooledDatabase = `gbrain_test_driver_cancel_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const targets: Array<[string, () => string]> = [];
if (process.env.DATABASE_URL) targets.push(['direct', () => process.env.DATABASE_URL!]);
if (pooled && pooledAdmin) targets.push(['pgbouncer', () => { const url = new URL(pooled); url.pathname = `/${pooledDatabase}`; return url.toString(); }]);

beforeAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  assertSafeE2eDatabaseUrl(pooledAdmin);
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${pooledDatabase}`); } finally { await admin.end(); }
}, 60_000);

afterAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${pooledDatabase} WITH (FORCE)`); } finally { await admin.end(); }
});
type Outcome = { value: unknown[] } | { error: string } | { hung: true };
const settle = (p: Promise<Iterable<unknown>>): Promise<Outcome> => Promise.race([p.then(value => ({ value: [...value] }), (error: { code?: string }) => ({ error: error?.code ?? String(error) })),
  new Promise<{ hung: true }>(resolve => setTimeout(() => resolve({ hung: true }), 5_000))]);

describe.skipIf(targets.length === 0)('vendored driver: a query cancelled while queued behind another on one connection', () => {
  for (const [target, resolveUrl] of targets) for (const prepare of [true, false]) {
    for (const second of ["SELECT 'q2' AS who WHERE false", 'SELECT pg_sleep(0.3) AS slept']) {
      test(`the next query reads its own row and the cancelled one rejects 57014 (${target}, prepare ${prepare}, ${second})`, async () => {
        const databaseUrl = resolveUrl();
        assertSafeE2eDatabaseUrl(databaseUrl);
        const sql = postgres(databaseUrl, { max: 1, prepare, onnotice: () => {} });
        const table = `driver_cancel_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        try {
          await sql.unsafe(`CREATE TABLE ${table} (id int PRIMARY KEY); INSERT INTO ${table} VALUES (1)`);
          for (const scope of ['reserved', 'transaction'] as const) {
            const run = async (q: Pick<postgres.Sql, 'unsafe'>): Promise<Record<string, Outcome>> => {
              const q1 = q.unsafe('SELECT pg_sleep(0.2) AS slept').execute();
              const q2 = q.unsafe(second).execute();
              const q3 = q.unsafe(`SELECT count(*)::int AS n FROM ${table}, pg_sleep(0.15)`).execute();
              await new Promise(resolve => setTimeout(resolve, 50));
              expect((q2 as unknown as { active: boolean }).active).toBe(false);
              const cancelled = q2.cancel();
              const [r1, r2, r3] = await Promise.all([settle(q1), settle(q2), settle(q3)]);
              await cancelled;
              const q4 = await settle(q.unsafe("SELECT 'q4' AS who").execute());
              return { r1, r2, r3, q4 };
            };
            const out = scope === 'reserved'
              ? await (async () => { const r = await sql.reserve(); try { return await run(r); } finally { r.release(); } })()
              : await sql.begin(async tx => run(tx)).catch((error: { code?: string }) => ({ txError: error?.code })) as Record<string, unknown>;
            if (scope === 'transaction' && 'txError' in out) {
              expect(out).toEqual({ txError: '57014' });
              continue;
            }
            expect(out.r1).toEqual({ value: [{ slept: '' }] });
            expect(out.r2).toEqual({ error: '57014' });
            expect(out.r3).toEqual({ value: [{ n: 1 }] });
            expect(out.q4).toEqual({ value: [{ who: 'q4' }] });
          }
          expect([...await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)] as unknown[]).toEqual([{ n: 1 }]);
        } finally {
          await sql.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
          await sql.end();
        }
      }, 30_000);
    }
  }
});
