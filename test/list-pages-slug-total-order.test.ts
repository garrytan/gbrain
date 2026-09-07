/**
 * `PAGE_SORT_SQL.slug` is a TOTAL order (slug, source_id, id).
 *
 * Slug uniqueness is per (source_id, slug), so a federated listing can hold
 * the same slug from several sources. Under the bare `p.slug ASC`, slug+offset
 * paging over such a set was not deterministic (a tie cluster wider than the
 * page could duplicate or skip rows) — the same class the v0.45.7 updated_asc
 * tiebreaker fixed. Pins the SQL string and the observable paging order.
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
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('slug sort is a total order across sources sharing a slug', () => {
  test('PAGE_SORT_SQL.slug carries source_id + id tiebreakers', () => {
    expect(PAGE_SORT_SQL.slug).toBe('p.slug ASC, p.source_id ASC, p.id ASC');
  });

  test('limit=1 paging over two sources yields each row exactly once, in a stable order', async () => {
    const pages = await Promise.all([0, 1].map(async (offset) => {
      const [page] = await engine.listPages({
        sourceIds: ['default', 'team-alpha'],
        sort: 'slug',
        limit: 1,
        offset,
      });
      return `${page.source_id}:${page.slug}`;
    }));
    expect(pages).toEqual(['default:messages/shared', 'team-alpha:messages/shared']);
  });
});
