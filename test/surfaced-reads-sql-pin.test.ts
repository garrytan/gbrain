/**
 * The surfaced-read members send PGLite and Postgres the statements their callers sent through executeRaw before the
 * move (src/core/engine-sql/schema-detect.ts path probes, query-cache-invalidate.ts, write-misc.ts
 * hasLabelledOnlyMemberAmong, access-read-log.ts), copied verbatim from the callers at b7b18e5ab3. Intended
 * differences: the who-read page lookup sorts its source ids COLLATE "C", and the who-read tally breaks a last-read tie
 * by who COLLATE "C", so every engine and locale agree. The sources_not_readable probe is main's readSourcesNotReadable
 * (engine-sql/sources.ts), pinned by its own goldens.
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
import * as ReadLog from '../src/core/engine-sql/access-read-log.ts';

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

  test('the access read log insert, prune and reads', async () => {
    const r = recorder([]);
    const row = { created_at: '2026-01-01T00:00:00.000Z', member: 'alice-example', audience: null, operation: 'search', transport: 'http', result_code: 'ok', page_ids: [1] };
    await ReadLog.insertAccessReadLogRows(r.raw, [row]);
    await ReadLog.pruneAccessReadLog(r.raw, 365, 1000);
    await ReadLog.readAccessReadLog(r.raw, { since: 's', member: 'alice-example', limit: 5 });
    await ReadLog.listAccessReadPageRefs(r.raw, 'notes/a', null);
    await ReadLog.readAccessReadsOfPages(r.raw, { pageIds: [1, 2], since: 's', limit: 5 });
    await ReadLog.tallyAccessReadsOfPages(r.raw, { pageIds: [1, 2], since: 's' });
    const SELECT = `SELECT l.created_at, l.member, l.audience, l.operation, l.transport, l.result_code,
  COALESCE((SELECT array_agg(COALESCE(p.source_id || ':' || p.slug, '#' || x.id) ORDER BY x.ord)
    FROM unnest(l.page_ids) WITH ORDINALITY AS x(id, ord) LEFT JOIN pages p ON p.id = x.id), '{}') AS pages
  FROM access_read_log l`;
    expect(r.log).toEqual([
      [`INSERT INTO access_read_log (created_at, member, audience, operation, transport, result_code, page_ids)
  SELECT (r->>'created_at')::timestamptz, r->>'member',
    CASE WHEN jsonb_typeof(r->'audience') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'audience')) END,
    r->>'operation', r->>'transport', r->>'result_code', ARRAY(SELECT jsonb_array_elements_text(r->'page_ids')::int)
  FROM jsonb_array_elements($1::text::jsonb) r`, [JSON.stringify([row])]],
      ['DELETE FROM access_read_log WHERE created_at < now() - make_interval(days => $1::int)', [365]],
      ['DELETE FROM access_read_log WHERE id <= (SELECT max(id) FROM access_read_log) - $1::bigint', [1000]],
      [`${SELECT} WHERE l.created_at >= $1::timestamptz
    AND ($2::text IS NULL OR l.member = $2 OR ('member:' || $2) = ANY(l.audience)) ORDER BY l.created_at DESC, l.id DESC LIMIT $3`, ['s', 'alice-example', 5]],
      ['SELECT id, source_id, slug FROM pages WHERE slug = $1 AND ($2::text IS NULL OR source_id = $2) ORDER BY source_id COLLATE "C"', ['notes/a', null]],
      [`${SELECT} WHERE l.page_ids && $1::int[] AND l.created_at >= $2::timestamptz ORDER BY l.created_at DESC, l.id DESC LIMIT $3`, [[1, 2], 's', 5]],
      [`SELECT
      COALESCE(member, array_to_string(audience, '+'), '(unbound)') AS who, count(*) AS reads, max(created_at) AS last_at
    FROM access_read_log WHERE page_ids && $1::int[] AND created_at >= $2::timestamptz GROUP BY 1
    ORDER BY max(created_at) DESC, COALESCE(member, array_to_string(audience, '+'), '(unbound)') COLLATE "C"`, [[1, 2], 's']],
    ]);
  });
});
