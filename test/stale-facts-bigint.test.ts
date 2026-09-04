import { describe, expect, test } from 'bun:test';
import { listFactsNeedingEmbedding as listPostgresStaleFacts } from '../src/core/postgres-engine/facts.ts';
import { listFactsNeedingEmbedding as listPgliteStaleFacts } from '../src/core/pglite-engine/facts.ts';
import type { PgFactsDeps } from '../src/core/postgres-engine/facts.ts';
import type { PgliteFactsDeps } from '../src/core/pglite-engine/facts.ts';

// facts.id is BIGSERIAL: postgres.js hands int8 back as BigInt (or a string on
// the routed path), so the boundary must normalize exactly like takes (#4628).
const rawRow = {
  fact_id: 42n,
  fact: 'Alice prefers async standups',
  entity_slug: 'people/alice-example',
};

describe('listFactsNeedingEmbedding bigint normalization', () => {
  test('Postgres rows match the numeric StaleFactRow contract', async () => {
    const sql = (async () => [rawRow]) as unknown as PgFactsDeps['sql'];
    const rows = await listPostgresStaleFacts({ sql } as PgFactsDeps, { limit: 10 });

    expect(rows).toEqual([{
      fact_id: 42,
      fact: 'Alice prefers async standups',
      entity_slug: 'people/alice-example',
    }]);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  test('PGLite rows use the same normalized boundary', async () => {
    const db = { query: async () => ({ rows: [{ ...rawRow, entity_slug: null }] }) };
    const rows = await listPgliteStaleFacts({ db } as unknown as PgliteFactsDeps, { limit: 10 });

    expect(rows[0]?.fact_id).toBe(42);
    expect(rows[0]?.entity_slug).toBeNull();
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
