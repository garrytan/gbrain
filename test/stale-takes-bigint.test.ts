import { describe, expect, test } from 'bun:test';
import { listStaleTakes as listPostgresStaleTakes } from '../src/core/postgres-engine/takes.ts';
import { listStaleTakes as listPgliteStaleTakes } from '../src/core/pglite-engine/takes.ts';
import type { PgTakesDeps } from '../src/core/postgres-engine/takes.ts';
import type { PgliteTakesDeps } from '../src/core/pglite-engine/takes.ts';

const rawRow = {
  take_id: 42n,
  page_slug: 'people/alice-example',
  row_num: 3n,
  claim: 'Strong DX intuition',
};

describe('listStaleTakes bigint normalization', () => {
  test('Postgres rows match the numeric StaleTakeRow contract', async () => {
    const sql = (async () => [rawRow]) as unknown as PgTakesDeps['sql'];
    const rows = await listPostgresStaleTakes({ sql } as PgTakesDeps);

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
    const rows = await listPgliteStaleTakes({ db } as unknown as PgliteTakesDeps);

    expect(rows[0]?.take_id).toBe(42);
    expect(rows[0]?.row_num).toBe(3);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
