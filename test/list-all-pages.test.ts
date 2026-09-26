/**
 * `listAllPages` reads a complete page set in offset batches over the
 * `slug` sort (slug, source_id, id: a total order). Pinned: same-slug rows
 * from two sources straddling a batch boundary are neither repeated nor
 * dropped, filters pass through, and the read runs until an empty batch so
 * an engine that clamps `limit` cannot truncate it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listAllPages } from '../src/core/list-all-pages.ts';
import type { Page, PageFilters } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('connector-a', 'Connector A') ON CONFLICT DO NOTHING`,
  );
  const rows: Array<[string, string, 'note' | 'person']> = [
    ['default', 'notes/a', 'note'],
    ['connector-a', 'notes/a', 'note'],
    ['default', 'notes/b', 'note'],
    ['connector-a', 'notes/b', 'note'],
    ['default', 'people/alice-example', 'person'],
  ];
  for (const [sourceId, slug, type] of rows) {
    await engine.putPage(slug, { type, title: slug, compiled_truth: 'body', timeline: '' }, { sourceId });
  }
});

afterAll(async () => {
  await engine.disconnect();
});

const identity = (pages: Page[]) => pages.map((p) => `${p.source_id}:${p.slug}`);

describe('listAllPages', () => {
  test.each([1, 2, 3, 1000])('batch size %i returns every row once, in slug order', async (batchSize) => {
    const pages = await listAllPages(engine, {}, batchSize);
    expect(identity(pages)).toEqual([
      'connector-a:notes/a',
      'default:notes/a',
      'connector-a:notes/b',
      'default:notes/b',
      'default:people/alice-example',
    ]);
  });

  test.each([
    { filters: { sourceId: 'connector-a' }, expected: ['connector-a:notes/a', 'connector-a:notes/b'] },
    { filters: { type: 'person' as const }, expected: ['default:people/alice-example'] },
    { filters: { slugPrefix: 'notes/b' }, expected: ['connector-a:notes/b', 'default:notes/b'] },
  ])('passes filters through: $filters', async ({ filters, expected }) => {
    expect(identity(await listAllPages(engine, filters, 1))).toEqual([...expected]);
  });

  test('a row shifted into the next batch is returned once', async () => {
    // A concurrent insert ahead of the cursor pushes the last row of one
    // batch into the next; the wrapper replays that overlap.
    const shifted = {
      listPages: (filters?: PageFilters) => {
        const offset = filters?.offset ?? 0;
        return engine.listPages({ ...filters, offset: offset > 0 ? offset - 1 : 0 });
      },
    };
    const pages = await listAllPages(shifted, {}, 2);
    expect(identity(pages)).toEqual([
      'connector-a:notes/a',
      'default:notes/a',
      'connector-a:notes/b',
      'default:notes/b',
      'default:people/alice-example',
    ]);
  });

  test('keeps reading past a batch the engine clamped below the request', async () => {
    const calls: PageFilters[] = [];
    const clamped = {
      listPages: (filters?: PageFilters) => {
        calls.push(filters ?? {});
        return engine.listPages({ ...filters, limit: Math.min(filters?.limit ?? 100, 2) });
      },
    };
    const pages = await listAllPages(clamped, {}, 1000);
    expect(pages).toHaveLength(5);
    expect(calls.map((c) => c.offset)).toEqual([0, 2, 4, 5]);
    expect(calls.every((c) => c.sort === 'slug')).toBe(true);
  });
});
