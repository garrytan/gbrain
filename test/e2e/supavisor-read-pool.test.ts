/**
 * #6543 (A3): through Supavisor's transaction mode, pipelined statements that
 * span transaction boundaries come back with another statement's rows or hang
 * (lane A: 13-22 wrong-row answers in 20 s on 8 workers over a pool of 3).
 * gbrain's engine read pool on a port-6543 URL is built with
 * `max_pipeline: 0`; this file drives that engine pool with concurrent
 * autocommit and transaction statements and requires every statement to read
 * its own rows with no connection errors.
 *
 * Runs only when GBRAIN_SUPAVISOR_URL names a Supavisor transaction-mode URL
 * (port 6543) for a test database; scripts/run-e2e.sh passes it through.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const supavisor = process.env.GBRAIN_SUPAVISOR_URL;

describe.skipIf(!supavisor)('#6543 engine read pool through Supavisor transaction mode', () => {
  test('the read pool does not pipeline, and concurrent statements each read their own rows', async () => {
    assertSafeE2eDatabaseUrl(supavisor!);
    await withEnv({ PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
      const engine = new PostgresEngine();
      await engine.connect({ engine: 'postgres', database_url: supavisor!, poolSize: 3 });
      try {
        const sql = engine.sql;
        expect((sql as unknown as { options: { max_pipeline: number } }).options.max_pipeline).toBe(0);
        let ok = 0;
        const wrong: string[] = [];
        const errors: string[] = [];
        const check = async (label: string, run: () => Promise<boolean>) => {
          try { if (await run()) ok++; else wrong.push(label); } catch (e) { errors.push(String((e as { code?: string }).code ?? (e as Error).message)); }
        };
        const deadline = Date.now() + 8_000;
        await Promise.all(Array.from({ length: 8 }, async (_, w) => {
          for (let i = 0; Date.now() < deadline; i++) {
            const tag = `w${w}-${i}`;
            const n = (w * 1_000_003 + i) % 2_000_000_000;
            await Promise.all([
              check('param', async () => { const [r] = await sql`SELECT ${tag}::text AS who, ${n}::int AS n`; return r?.who === tag && r?.n === n; }),
              check('shape', async () => { const [r] = await sql.unsafe(`SELECT $1::text AS who, ${i} AS shape`, [tag]); return r?.who === tag && Number(r?.shape) === i; }),
              check('tx', async () => {
                const rows = await sql.begin(async t => {
                  const [a] = await t`SELECT ${tag}::text AS who`;
                  if (a?.who !== tag) return null;
                  return t`SELECT ${tag + 'b'}::text AS who`;
                });
                return Array.isArray(rows) && rows[0]?.who === tag + 'b';
              }),
            ]);
          }
        }));
        expect({ wrong: wrong.length, errors }).toEqual({ wrong: 0, errors: [] });
        expect(ok).toBeGreaterThan(100);
      } finally {
        await engine.disconnect();
      }
    });
  }, 60_000);
});
