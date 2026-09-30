import { describe, expect, test } from 'bun:test';
import { listStaleTakes } from '../src/core/engine-sql/takes.ts';
import { unscopedExecutor } from '../src/core/engine-sql/brands.ts';
import { postgresExecutor } from '../src/core/engine-sql/dialect-postgres.ts';
import { pgliteExecutor } from '../src/core/engine-sql/dialect-pglite.ts';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';

const rawRow = {
  take_id: 42n,
  page_slug: 'people/alice-example',
  row_num: 3n,
  claim: 'Strong DX intuition',
};

describe('listStaleTakes bigint normalization', () => {
  test('Postgres rows match the numeric StaleTakeRow contract', async () => {
    const exec = postgresExecutor({} as never, { runUnsafe: (async () => [rawRow]) as never, gauge: new CheckoutGauge() });
    const rows = await listStaleTakes(unscopedExecutor(exec, 'test: fake driver'));

    expect(rows).toEqual([{
      take_id: 42,
      page_slug: 'people/alice-example',
      row_num: 3,
      claim: 'Strong DX intuition',
    }]);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  test('PGLite rows use the same normalized boundary', async () => {
    const db = { query: async () => ({ rows: [rawRow] }) };
    const rows = await listStaleTakes(unscopedExecutor(pgliteExecutor(db as never), 'test: fake driver'));

    expect(rows[0]?.take_id).toBe(42);
    expect(rows[0]?.row_num).toBe(3);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
