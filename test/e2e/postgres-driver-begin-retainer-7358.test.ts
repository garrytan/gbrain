/**
 * #7358: the vendored driver's `begin` races a transaction against the connection's close handler. The handler used to
 * stay on the pooled connection after the transaction settled, and through the rejected race it kept that transaction's
 * result reachable until the connection's next `begin`: a resident serve held one large result per pooled connection.
 * Now the handler leaves the connection when the transaction settles, so the result is collectable after plain queries.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

describe.skipIf(!hasDatabase())('postgres driver: a settled transaction is not kept by its connection (#7358)', () => {
  test('the last begin\'s result is collectable after plain queries on the same connection', async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL);
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const refs: Array<WeakRef<object>> = [];
      await (async () => {
        const result = await sql.begin(async tx => {
          await tx`SELECT 1`;
          return { rows: Array.from({ length: 1000 }, (_, i) => ({ i, text: 'x'.repeat(64) })) };
        });
        refs.push(new WeakRef(result));
      })();
      for (let i = 0; i < 3; i++) await sql`SELECT ${i}::int AS n`;
      Bun.gc(true);
      expect(refs.map(ref => ref.deref() === undefined)).toEqual([true]);
      const [{ ok }] = await sql.begin(async tx => tx`SELECT true AS ok`);
      expect(ok).toBe(true);
    } finally { await sql.end({ timeout: 5 }); }
  }, 30_000);
});
