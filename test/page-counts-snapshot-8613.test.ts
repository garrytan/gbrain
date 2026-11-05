import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countPagesBy } from '../src/core/engine-sql/page-lookup.ts';
import { scopedRead } from '../src/core/engine-sql/brands.ts';
import type { SqlExecutor, Row, QueryOpts } from '../src/core/engine-sql/executor.ts';
import type { SqlFragment } from '../src/core/engine-sql/fragment.ts';
import { collapseTypes } from '../src/core/page-counts.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`page count snapshot #8613 (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    // Commit after the first real storage result, before countPagesBy can issue
    // another statement. No timers, fabricated rows or SQL-text assertions.
    const interleaved = (afterRead: () => Promise<void>): SqlExecutor => {
      const base: SqlExecutor = (engine as any).engineSql;
      let reads = 0;
      return {
        ...base,
        async run<R = Row>(fragment: SqlFragment, opts?: QueryOpts) {
          const result = await base.run<R>(fragment, opts);
          if (++reads === 1) await afterRead();
          return result;
        },
      };
    };
    const put = (sourceId: string, slug: string, type: string) =>
      engine.putPage(slug, { title: slug, type, compiled_truth: 'Synthetic count fixture', frontmatter: {} }, { sourceId });
    const source = async (id: string) => {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
      return id;
    };

    for (const grouped of [false, true]) {
      test(`an insert cannot change totals after source/type counts (grouped=${grouped})`, async () => {
        const id = await source(`insert-${grouped}`);
        await put(id, 'notes/first', 'note');
        const result = await countPagesBy(scopedRead(interleaved(() => put(id, 'notes/second', 'note').then(() => {}))),
          { sourceId: id }, grouped ? types => types : undefined);
        expect(result).toEqual({
          bySourceType: [{ source_id: id, type: 'note', pages: 1 }],
          byTypeGroup: grouped ? [{ group: 'note', pages: 1, distinct_slugs: 1 }] : [],
          total: { pages: 1, distinct_slugs: 1 },
        });
        expect((await engine.countPagesBy({ sourceId: id })).total.pages).toBe(2);
      });

      test(`a deletion cannot erase the total of a counted group (grouped=${grouped})`, async () => {
        const id = await source(`delete-${grouped}`);
        await put(id, 'notes/only', 'note');
        const result = await countPagesBy(scopedRead(interleaved(async () => { await engine.softDeletePage('notes/only', { sourceId: id }); })),
          { sourceId: id }, grouped ? types => types : undefined);
        expect(result.total).toEqual({ pages: 1, distinct_slugs: 1 });
        expect(result.bySourceType).toEqual([{ source_id: id, type: 'note', pages: 1 }]);
        if (grouped) expect(result.byTypeGroup).toEqual([{ group: 'note', pages: 1, distinct_slugs: 1 }]);
        expect((await engine.countPagesBy({ sourceId: id })).total.pages).toBe(0);
      });
    }

    test('alias collapse and cross-source twins use the same type inventory and visibility snapshot', async () => {
      const a = await source('twins-a'), b = await source('twins-b');
      await put(a, 'calls/shared', 'transcript');
      await put(b, 'calls/shared', 'audio-transcript');
      await put(a, 'calls/unique', 'audio-transcript');
      await put(a, 'calls/private', 'transcript');
      await engine.executeRaw("UPDATE pages SET frontmatter = '{\"visibility\":\"private\"}'::jsonb WHERE source_id=$1 AND slug='calls/private'", [a]);
      const result = await countPagesBy(scopedRead(interleaved(async () => {
        await put(b, 'calls/shared', 'person');
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [a]);
      })), { sourceIds: [a, b], untrusted: { excludePrivate: true } }, types => {
        const collapsed = collapseTypes(types, null);
        return types.map(type => collapsed.get(type)!.group);
      });
      expect(result.total).toEqual({ pages: 3, distinct_slugs: 2 });
      expect(result.byTypeGroup).toEqual([{ group: 'transcript', pages: 3, distinct_slugs: 2 }]);
      expect(result.bySourceType.reduce((sum, row) => sum + row.pages, 0)).toBe(3);
      expect((await engine.countPagesBy({ sourceIds: [a, b] })).total).toEqual({ pages: 1, distinct_slugs: 1 });
    });

    test('separate type groups count a shared slug once in each group, but once in the total', async () => {
      const a = await source('groups-a'), b = await source('groups-b');
      await put(a, 'notes/shared', 'note');
      await put(b, 'notes/shared', 'person');
      await put(b, 'notes/other', 'note');
      await put(a, 'notes/old', 'note');
      await engine.executeRaw("UPDATE pages SET effective_date='2020-01-01' WHERE source_id=$1 AND slug='notes/old'", [a]);
      const result = await engine.countPagesBy({ sourceIds: [a, b], since: '2021-01-01' }, types => types);
      expect(result.total).toEqual({ pages: 3, distinct_slugs: 2 });
      expect(result.byTypeGroup.sort((a, b) => a.group.localeCompare(b.group))).toEqual([
        { group: 'note', pages: 2, distinct_slugs: 2 },
        { group: 'person', pages: 1, distinct_slugs: 1 },
      ]);
    });

    test('empty scoped results remain zero with and without a grouper', async () => {
      const id = await source('empty-counts');
      for (const grouper of [undefined, (types: string[]) => types]) {
        expect(await engine.countPagesBy({ sourceId: id }, grouper)).toEqual({ bySourceType: [], byTypeGroup: [], total: { pages: 0, distinct_slugs: 0 } });
      }
    });
  });
}
