/**
 * Postgres arm of test/list-pages-window-prefix.test.ts: the same list_pages
 * `updated_before` + `slug_prefix` case table against PostgresEngine.
 *
 * Postgres-only risk this pins: postgres.js serializes a bare `::timestamptz`
 * string bind through a JS Date (millisecond precision), so an upper bound one
 * microsecond past a row would silently drop it. PGLite cannot show that; the
 * microsecond window case here can. Skips without DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LIST_PAGES_FILTER_CASES, LIST_PAGES_TIMESTAMP_ERROR_CASES, filterCtx, listError, listKeys, listPages, seedListPagesFilterCorpus } from '../helpers/list-pages-filter-cases.ts';

const describeIfDB = hasDatabase() ? describe : describe.skip;

let engine: PostgresEngine;

beforeAll(async () => {
  if (!hasDatabase()) return;
  engine = await setupDB();
  await seedListPagesFilterCorpus(engine);
});

afterAll(async () => {
  if (hasDatabase()) await teardownDB();
});

describeIfDB('list_pages updated_before + slug_prefix on Postgres', () => {
  for (const c of LIST_PAGES_FILTER_CASES) {
    test(c.name, async () => {
      expect(await listKeys(engine, c.remote, c.params)).toEqual(c.expected);
    });
  }

  for (const c of LIST_PAGES_TIMESTAMP_ERROR_CASES) {
    test(`unparsable timestamp ${JSON.stringify(c.params)} is invalid_params`, async () => {
      const err = await listError(engine, c.params);
      expect(err?.code).toBe('invalid_params');
      expect(err?.message).toContain(`list_pages: ${c.param} `);
    });
  }

  test('a remote keyset walk under both filters keeps them on every page', async () => {
    const keys: string[] = [];
    let next: Record<string, unknown> = { sort: 'updated_asc', slug_prefix: 'people', updated_before: '2026-03-01', limit: 1 };
    for (let guard = 0; guard < 10; guard++) {
      const notices: Array<{ fix: { mcp: { arguments: Record<string, unknown> } } }> = [];
      const rows = await listPages.handler(filterCtx(engine, true, { emitNotice: n => { notices.push(n as never); } }), next) as Array<{ source_id: string; slug: string }>;
      keys.push(...rows.map(r => `${r.source_id}:${r.slug}`));
      if (notices.length === 0) break;
      next = notices[0].fix.mcp.arguments;
    }
    expect(keys).toEqual(['default:people/alice-example', 'default:peoplex/sibling']);
  });
});
