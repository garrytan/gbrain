/**
 * The surfaced-read members send PGLite and Postgres the statements their callers sent through executeRaw before the
 * move (src/core/engine-sql/schema-detect.ts path probes, query-cache-invalidate.ts, write-misc.ts
 * hasLabelledOnlyMemberAmong, unscoped-read-reach.ts), copied verbatim from the callers at b7b18e5ab3. One intended
 * difference: the sources_not_readable probe binds its source list once per use ($1, $2, $3), as engine-sql numbers
 * every bound value, where the caller reused $1.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly the text and parameters below for every shape its caller builds.
 *  - Regression: a member that drops a filter, a collation or the owner exclusion answers differently on a fixture the
 *    parity cases do not hold (a locale-ordered sample, a trailing-space owner key, a quarantined page elsewhere).
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only.
 *  - Seam: a recording executeRaw stand-in; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { countLivePagesAtPathPrefix, probeUntypedPathPrefix } from '../src/core/engine-sql/schema-detect.ts';
import { invalidateQueryCacheRows } from '../src/core/engine-sql/query-cache-invalidate.ts';
import { hasLabelledOnlyMemberAmong } from '../src/core/engine-sql/write-misc.ts';
import { readUnscopedReadRefusal } from '../src/core/engine-sql/unscoped-read-reach.ts';
import { quarantineFilterFragment } from '../src/core/quarantine.ts';
import { remoteReadFloorSql } from '../src/core/search/private-visibility.ts';

function recorder(answer: Record<string, unknown>[] = [{ cnt: '2', n: 0, refuse: false }]) {
  const log: Array<[string, unknown[]]> = [];
  const raw = async (sql: string, params?: unknown[]) => { log.push([sql, params ?? []]); return answer as never; };
  return { log, raw: raw as never, exec: { executeRaw: raw } as never };
}

describe('surfaced-read members send their callers\' statements', () => {
  test('the schema-pack path probes', async () => {
    const r = recorder();
    await countLivePagesAtPathPrefix(r.raw, 'people/');
    await probeUntypedPathPrefix(r.raw, 'people/');
    await probeUntypedPathPrefix(r.raw, 'people/', 'work');
    const where = `WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1`;
    const scoped = where + ` AND source_id = $2`;
    expect(r.log).toEqual([
      ['SELECT COUNT(*)::text AS cnt FROM pages WHERE deleted_at IS NULL AND source_path LIKE $1', ['people/%']],
      [`SELECT COUNT(*)::text AS cnt FROM pages ${where}`, ['people/%']],
      [`SELECT slug FROM pages ${where} ORDER BY slug COLLATE "C" LIMIT 10`, ['people/%']],
      [`SELECT COUNT(*)::text AS cnt FROM pages ${scoped}`, ['people/%', 'work']],
      [`SELECT slug FROM pages ${scoped} ORDER BY slug COLLATE "C" LIMIT 10`, ['people/%', 'work']],
    ]);
  });

  test('the query-cache invalidation, one source or all', async () => {
    const r = recorder();
    await invalidateQueryCacheRows(r.raw, 'work');
    await invalidateQueryCacheRows(r.raw);
    expect(r.log).toEqual([
      [`WITH deleted AS (
         DELETE FROM query_cache
         WHERE source_id = $1
            OR source_id = '__unscoped__'
            OR (source_id LIKE '\\_\\_set\\_\\_:%'
                AND (',' || substring(source_id from 9) || ',') LIKE ('%,' || $1 || ',%'))
         RETURNING 1
       )
       SELECT COUNT(*)::int AS n FROM deleted`, ['work']],
      [`WITH deleted AS (DELETE FROM query_cache RETURNING 1)
         SELECT COUNT(*)::int AS n FROM deleted`, []],
    ]);
  });

  test('the labelled-only test of a caller\'s members', async () => {
    const r = recorder([]);
    await hasLabelledOnlyMemberAmong(r.exec, ['alice-example', 'bob-example']);
    expect(r.log).toEqual([[`SELECT 1 FROM access_members WHERE labelled_only AND id = ANY($1::text[])
      AND id IS DISTINCT FROM (SELECT btrim(value) FROM config WHERE key = $2) LIMIT 1`, [['alice-example', 'bob-example'], 'access.owner_member']]]);
  });

  test('the sources_not_readable probe, with and without facts and the floor', async () => {
    for (const withFacts of [false, true]) {
      for (const floor of [false, true]) {
        const r = recorder();
        await readUnscopedReadRefusal(r.raw, { readable: ['default', 'wiki'], withFacts, floor });
        const visible = ` AND ${quarantineFilterFragment('p')}` + (floor ? ` AND ${remoteReadFloorSql('p')}` : '');
        const facts = withFacts
          ? ` OR EXISTS (SELECT 1 FROM facts WHERE source_id = ANY($2::text[]) AND visibility = 'world'
                       AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()))`
          : '';
        const last = withFacts ? '$3' : '$2';
        expect(r.log).toEqual([[
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL${visible})${facts} THEN false
                   ELSE EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
                                 WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND NOT (p.source_id = ANY(${last}::text[]))${visible})
              END AS refuse`,
          Array(withFacts ? 3 : 2).fill(['default', 'wiki']),
        ]]);
      }
    }
  });
});
