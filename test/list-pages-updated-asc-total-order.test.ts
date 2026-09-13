/**
 * `PAGE_SORT_SQL.updated_asc` is a TOTAL order (updated_at, slug, source_id, id).
 *
 * Slug uniqueness is per (source_id, slug), so under a federated scope two
 * sources can hold the same slug stamped with the same updated_at (a bulk sync
 * stamps one now() across a transaction). Under `p.updated_at ASC, p.slug ASC`
 * those two rows ordered arbitrarily, so limit/offset paging could duplicate or
 * skip one — the same class the `slug` sort's source_id + id tiebreakers fixed.
 * Pins the SQL string and the observable paging order.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_SORT_SQL } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    'INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING',
    ['team-alpha'],
  );
  const input = { type: 'note', title: 'Shared slug', compiled_truth: 'body' };
  await engine.putPage('messages/shared', input, { sourceId: 'team-alpha' });
  await engine.putPage('messages/shared', input);
  // One identical timestamp for both rows: the tie the tiebreakers must break.
  await engine.executeRaw(
    `UPDATE pages SET updated_at = '2026-08-10T12:00:00.000100Z'::timestamptz WHERE slug = 'messages/shared'`,
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('updated_asc sort is a total order across sources sharing slug + updated_at', () => {
  test('PAGE_SORT_SQL.updated_asc carries source_id + id tiebreakers', () => {
    expect(PAGE_SORT_SQL.updated_asc).toBe('p.updated_at ASC, p.slug ASC, p.source_id ASC, p.id ASC');
  });

  test('limit=1 paging over two sources yields each row exactly once, in a stable order', async () => {
    const pages = await Promise.all([0, 1].map(async (offset) => {
      const [page] = await engine.listPages({
        sourceIds: ['default', 'team-alpha'],
        sort: 'updated_asc',
        limit: 1,
        offset,
      });
      return `${page.source_id}:${page.slug}`;
    }));
    expect(pages).toEqual(['default:messages/shared', 'team-alpha:messages/shared']);
  });
});
