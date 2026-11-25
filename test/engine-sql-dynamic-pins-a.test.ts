/**
 * Rendered-SQL pins for the engine-sql members rewritten into the house form (`sqlFragment` + `renderFragment`):
 * repair-page-scans.ts, repair-page-reads.ts, repair-fence-scans.ts, source-archive.ts and the two facts-repair.ts
 * candidate reads.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends the engine exactly the statement text and bound values pinned below. Whitespace is
 *    compared collapsed. The text differs from the hand-numbered statements it replaced only where noted: parameters
 *    are numbered in the order they appear (a repeated value is bound once per use with the same cast), a LIMIT that
 *    was spliced as a number is now a bound value, `IN (<literals>)` is `= ANY(<array>::text[])`, and `IN ($1::int,
 *    $2::int)` is `= ANY(<array>::int[])`. Rows and result shapes are unchanged and are covered by the engine-parity
 *    cases.
 *  - Regression: a member that shifts a placeholder number against its value, drops the cast Postgres needs to infer
 *    a type, or splices a value instead of binding it still passes the PGLite parity cases on a small fixture, then
 *    fails or misbinds on Postgres.
 *  - Why existing coverage misses it: test/engine-parity/*.test.ts compares results, never statement text, and the
 *    sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts).
 *  - Seam: a recording `executeRaw` / `raw` that returns no rows; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { unscopedExecutor } from '../src/core/engine-sql/brands.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';
import {
  countLiveFileBackedPages, listFileTombstones, listLegacyOriginPairs, listOriginTwinGroups, listRepairScanPages,
  listSafeChunksPending, listTwinMergeLosers, twinLinkLosersStatement, twinMoveRowsStatement, twinTransitionLosersStatement,
} from '../src/core/engine-sql/repair-page-scans.ts';
import { clearPageChildOrphans, countPageChildOrphans, listOriginTwinCounts } from '../src/core/engine-sql/repair-page-reads.ts';
import { listContactRowPages } from '../src/core/engine-sql/repair-fence-scans.ts';
import { archiveSource, restoreArchivedSource } from '../src/core/engine-sql/source-archive.ts';
import {
  DUPLICATE_SQL, EXPIRY_TEXT, listOntologyFactCandidates, listPurgedPageFactCandidates, PURGED_EXCLUDED_SQL, PURGED_HEAD_SQL, PURGED_PAGE_SQL,
} from '../src/core/engine-sql/facts-repair.ts';
import { PAGE_EXTRACTION_SOURCE_LIST } from '../src/core/facts/gone-page-facts.ts';
import { CREDENTIAL_RESEAL_HELD } from '../src/core/page-state/credential-reseal-hold.ts';
import { syncDeleteOrigin } from '../src/core/persistence/sync-delete-tombstones.ts';
import { NOT_CONVERSATION_SLOT_SQL } from '../src/core/chronicle/ontology.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../src/core/source-config-sql.ts';

interface Call { text: string; params: unknown[] | undefined }

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** An executor and a raw read that record every statement and answer with no rows. */
function recorder() {
  const calls: Call[] = [];
  const executeRaw = async (text: string, params?: unknown[]) => { calls.push({ text: norm(text), params }); return []; };
  const exec = unscopedExecutor({ dialect: 'pglite', executeRaw } as unknown as SqlExecutor, 'rendered-sql pin');
  return { calls, exec, raw: executeRaw as <R>(text: string, params?: unknown[]) => Promise<R[]> };
}

const SCAN_SELECT = `SELECT id, slug, knowledge_revision::text AS revision, content_hash, source_path, source_uri, revision_write_request_id::text AS request_id, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms, deleted_at IS NOT NULL AS deleted, database_only_reason FROM pages`;
const BLANK = `COALESCE(btrim(source_path), '')=''`;

describe('repair-page-scans.ts rendered SQL', () => {
  test('listRepairScanPages by ids binds the id array with its bigint cast', async () => {
    const { calls, exec } = recorder();
    await listRepairScanPages(exec, 'src-a', { ids: [3, 4] });
    expect(calls).toEqual([{ text: `${SCAN_SELECT} WHERE source_id=$1 AND id=ANY($2::bigint[]) ORDER BY id`, params: ['src-a', [3, 4]] }]);
  });

  test('listRepairScanPages by slugs binds the slug array and skips blank origins', async () => {
    const { calls, exec } = recorder();
    await listRepairScanPages(exec, 'src-a', { slugs: ['a', 'b'] });
    expect(calls).toEqual([{ text: `${SCAN_SELECT} WHERE source_id=$1 AND deleted_at IS NULL AND slug=ANY($2::text[]) AND NOT ${BLANK} ORDER BY id`, params: ['src-a', ['a', 'b']] }]);
  });

  test('listRepairScanPages past an id binds the id and the LIMIT instead of splicing the limit', async () => {
    const { calls, exec } = recorder();
    await listRepairScanPages(exec, 'src-a', { afterId: 7, limit: 50.9 });
    expect(calls).toEqual([{ text: `${SCAN_SELECT} WHERE source_id=$1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, params: ['src-a', 7, 50] }]);
  });

  test('listRepairScanPages legacy keeps blank origins without a database-only stamp and floors the limit at 1', async () => {
    const { calls, exec } = recorder();
    await listRepairScanPages(exec, 'src-a', { afterId: 0, limit: 0, legacy: true });
    expect(calls).toEqual([{
      text: `${SCAN_SELECT} WHERE source_id=$1 AND deleted_at IS NULL AND id > $2 AND ${BLANK} AND database_only_reason IS NULL ORDER BY id LIMIT $3`,
      params: ['src-a', 0, 1],
    }]);
  });

  test('listSafeChunksPending binds the source array and the chunker version', async () => {
    const { calls, exec } = recorder();
    await listSafeChunksPending(exec, ['s1', 's2']);
    expect(calls).toEqual([{
      text: norm(`SELECT p.id,p.source_id,p.slug,p.page_kind,
        (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)) AS rebuildable,
        length(p.compiled_truth)+length(COALESCE(p.timeline,'')) AS chars
        FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL
        AND (p.chunker_version < $2::int OR (${CREDENTIAL_RESEAL_HELD} AND p.body_storage IS DISTINCT FROM 'segmented'))
        ORDER BY p.id`),
      params: [['s1', 's2'], 4],
    }]);
  });

  test('listOriginTwinGroups binds the limit', async () => {
    const { calls, exec } = recorder();
    await listOriginTwinGroups(exec, 'src-a', 9);
    expect(calls).toEqual([{
      text: `SELECT source_path, array_agg(id ORDER BY id) AS ids, array_agg(source_path ORDER BY id) AS paths FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1 ORDER BY source_path COLLATE "C" LIMIT $2`,
      params: ['src-a', 9],
    }]);
  });

  test('listLegacyOriginPairs numbers the prefix before the source because the join names it first', async () => {
    const { calls, exec } = recorder();
    await listLegacyOriginPairs(exec, 'src-a', 'legacy/', 20);
    expect(calls).toEqual([{
      text: `SELECT l.id AS legacy_id, l.source_path AS legacy_path, l.slug AS legacy_slug, o.source_path AS origin FROM pages l JOIN pages o ON o.source_id=l.source_id AND l.source_path = $1 || o.source_path WHERE l.source_id=$2 AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.id <> o.id ORDER BY l.id, o.id LIMIT $3`,
      params: ['legacy/', 'src-a', 20],
    }]);
  });

  test('listFileTombstones binds the cursor once per use with its bigint cast, and a null cursor too', async () => {
    const withCursor = recorder();
    await listFileTombstones(withCursor.exec, 'src-a', { before: 12, limit: 5 });
    const noCursor = recorder();
    await listFileTombstones(noCursor.exec, 'src-a', { before: null, limit: 5 });
    const text = norm(`SELECT p.id, p.slug, p.source_path, p.source_uri, p.deleted_at, p.knowledge_revision::text AS revision, ${syncDeleteOrigin('p')} AS by_sync
      FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NOT NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND ($2::bigint IS NULL OR p.id < $3::bigint)
      ORDER BY p.id DESC LIMIT $4`);
    expect(withCursor.calls).toEqual([{ text, params: ['src-a', 12, 12, 5] }]);
    expect(noCursor.calls).toEqual([{ text, params: ['src-a', null, null, 5] }]);
  });

  test('countLiveFileBackedPages keeps its text for both origin modes', async () => {
    const any = recorder();
    await countLiveFileBackedPages(any.exec, 'src-a');
    const nonBlank = recorder();
    await countLiveFileBackedPages(nonBlank.exec, 'src-a', { nonBlank: true });
    const head = 'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND';
    expect(any.calls).toEqual([{ text: `${head} source_path IS NOT NULL`, params: ['src-a'] }]);
    expect(nonBlank.calls).toEqual([{ text: `${head} NOT ${BLANK}`, params: ['src-a'] }]);
  });

  test('listTwinMergeLosers reads links, transitions, timeline and raw data with the twin and survivor bound at each use', async () => {
    const { calls, exec } = recorder();
    await listTwinMergeLosers(exec, 9, 7);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ text: LINK_LOSERS_TEXT, params: LOSER_PARAMS });
    expect(calls[1]).toEqual({ text: TRANSITION_LOSERS_TEXT, params: LOSER_PARAMS });
    expect(calls[2]).toEqual({
      text: `SELECT s.id FROM timeline_entries s JOIN timeline_entries o ON o.page_id=$1::int AND o.date=s.date AND md5(o.summary)=md5(s.summary) AND o.source=s.source WHERE s.page_id=$2::int AND o.detail<>s.detail ORDER BY s.id`,
      params: [9, 7],
    });
    expect(calls[3]).toEqual({
      text: `SELECT s.source FROM raw_data s JOIN raw_data o ON o.page_id=$1::int AND o.source=s.source WHERE s.page_id=$2::int AND o.data IS DISTINCT FROM s.data ORDER BY s.source COLLATE "C"`,
      params: [9, 7],
    });
  });

  test('the twin merge statements the persistence layer runs render the same text as the reads', () => {
    expect({ text: norm(twinLinkLosersStatement(7, 9).text), params: twinLinkLosersStatement(7, 9).params }).toEqual({ text: LINK_LOSERS_TEXT, params: LOSER_PARAMS });
    expect({ text: norm(twinTransitionLosersStatement(7, 9).text), params: twinTransitionLosersStatement(7, 9).params }).toEqual({ text: TRANSITION_LOSERS_TEXT, params: LOSER_PARAMS });
    for (const table of ['links', 'link_transitions'] as const) {
      const move = twinMoveRowsStatement(table, 7, 9);
      expect({ text: norm(move.text), params: move.params }).toEqual({
        text: `UPDATE ${table} SET from_page_id=CASE WHEN from_page_id=$1::int THEN $2::int ELSE from_page_id END, to_page_id=CASE WHEN to_page_id=$3::int THEN $4::int ELSE to_page_id END, origin_page_id=CASE WHEN origin_page_id=$5::int THEN $6::int ELSE origin_page_id END WHERE (from_page_id=$7::int OR to_page_id=$8::int OR origin_page_id IS NOT DISTINCT FROM $9::int) AND NOT (from_page_id = ANY($10::int[]) AND to_page_id = ANY($11::int[])) RETURNING id`,
        params: [7, 9, 7, 9, 7, 9, 7, 7, 7, [7, 9], [7, 9]],
      });
    }
  });
});

const LOSER_PARAMS = [7, 7, 7, 7, 9, 7, 9, 7, 9, [7, 9], [7, 9], [7, 9], [7, 9], [7, 9]];
const LOSER_MAPS = `CASE WHEN from_page_id=$4::int THEN $5::int ELSE from_page_id END AS f, CASE WHEN to_page_id=$6::int THEN $7::int ELSE to_page_id END AS t, CASE WHEN origin_page_id=$8::int THEN $9::int ELSE origin_page_id END AS o`;
const LOSER_WHERE = `(from_page_id = ANY($10::int[]) OR to_page_id = ANY($11::int[]) OR origin_page_id = ANY($12::int[])) AND NOT (from_page_id = ANY($13::int[]) AND to_page_id = ANY($14::int[]))`;
const MOVING_TEXT = `(from_page_id=$1::int OR to_page_id=$2::int OR origin_page_id IS NOT DISTINCT FROM $3::int)`;
const LINK_LOSERS_TEXT = `WITH m AS ( SELECT id, link_type, link_source, context, origin_field, link_kind, resolution_type, assertion_tense, ${MOVING_TEXT} AS moving, ${LOSER_MAPS} FROM links WHERE ${LOSER_WHERE}) SELECT s.id, s.link_source, bool_and(s.context=k.context AND s.origin_field IS NOT DISTINCT FROM k.origin_field AND s.link_kind IS NOT DISTINCT FROM k.link_kind AND s.resolution_type IS NOT DISTINCT FROM k.resolution_type AND s.assertion_tense IS NOT DISTINCT FROM k.assertion_tense) AS same FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type AND k.link_source IS NOT DISTINCT FROM s.link_source AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id) GROUP BY s.id, s.link_source ORDER BY s.id`;
const TRANSITION_LOSERS_TEXT = `WITH m AS ( SELECT id, link_type, kind, occurred_on, producer, date_precision, ${MOVING_TEXT} AS moving, ${LOSER_MAPS} FROM link_transitions WHERE ${LOSER_WHERE}) SELECT s.id, s.producer, bool_and(s.date_precision=k.date_precision) AS same FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type AND k.kind=s.kind AND k.occurred_on=s.occurred_on AND k.producer=s.producer AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id) GROUP BY s.id, s.producer ORDER BY s.id`;

describe('repair-page-reads.ts rendered SQL', () => {
  test('countPageChildOrphans renders the table and column from the listed targets and the NOT EXISTS predicate', async () => {
    const plain = recorder();
    await countPageChildOrphans(plain.exec, { table: 'tags', col: 'page_id' });
    const nullable = recorder();
    await countPageChildOrphans(nullable.exec, { table: 'links', col: 'origin_page_id' });
    expect(plain.calls).toEqual([{ text: 'SELECT count(*)::int AS n FROM tags WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id)', params: [] }]);
    expect(nullable.calls).toEqual([{
      text: 'SELECT count(*)::int AS n FROM links WHERE links.origin_page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.origin_page_id)',
      params: [],
    }]);
  });

  test('countPageChildOrphans refuses a table or column that is not a listed page child', async () => {
    const { calls, exec } = recorder();
    await expect(countPageChildOrphans(exec, { table: 'pages; DROP TABLE pages', col: 'page_id' })).rejects.toThrow('not a page child column');
    await expect(countPageChildOrphans(exec, { table: 'tags', col: 'tag' })).rejects.toThrow('not a page child column');
    expect(calls).toEqual([]);
  });

  test('clearPageChildOrphans deletes the orphans of a required column and clears a SET NULL one', async () => {
    const del = recorder();
    await clearPageChildOrphans(del.exec, { table: 'takes', col: 'page_id' });
    const clear = recorder();
    await clearPageChildOrphans(clear.exec, { table: 'files', col: 'page_id' });
    expect(del.calls).toEqual([{
      text: 'WITH removed AS (DELETE FROM takes WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id) RETURNING 1) SELECT count(*)::int AS n FROM removed',
      params: [],
    }]);
    expect(clear.calls).toEqual([{
      text: 'WITH cleared AS (UPDATE files SET page_id = NULL WHERE files.page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = files.page_id) RETURNING 1) SELECT count(*)::int AS n FROM cleared',
      params: [],
    }]);
  });

  test('listOriginTwinCounts binds the limit', async () => {
    const { calls, exec } = recorder();
    await listOriginTwinCounts(exec, 3);
    expect(calls).toEqual([{
      text: 'SELECT source_id, count(*)::int AS groups, (sum(n) - count(*))::int AS twins FROM (SELECT source_id, count(*) AS n FROM pages WHERE deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_id, source_path HAVING count(*) > 1) g GROUP BY source_id ORDER BY source_id COLLATE "C" LIMIT $1',
      params: [3],
    }]);
  });
});

describe('repair-fence-scans.ts rendered SQL', () => {
  test('listContactRowPages binds the slug list at both uses and the limit', async () => {
    const { calls, exec } = recorder();
    await listContactRowPages(exec, ['s1'], { afterId: 4, limit: 25, slugs: ['a', 'b'] });
    expect(calls).toEqual([{
      text: `SELECT id, source_id, slug FROM pages WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND body_storage='inline' AND id>$2 AND CASE WHEN jsonb_typeof(frontmatter->'contacts')='array' THEN jsonb_array_length(frontmatter->'contacts') ELSE 0 END>1 AND (cardinality($3::text[])=0 OR slug=ANY($4::text[])) ORDER BY id LIMIT $5`,
      params: [['s1'], 4, ['a', 'b'], ['a', 'b'], 25],
    }]);
  });
});

describe('source-archive.ts rendered SQL', () => {
  test('archiveSource binds the whole-hour ttl as text and the source id', async () => {
    const { calls, exec } = recorder();
    await archiveSource(exec, 'src-a', 36.7);
    expect(calls).toEqual([{
      text: norm(`UPDATE sources SET archived = true, archived_at = now(), archive_expires_at = now() + ($1::text || ' hours')::interval, config = ${SOURCE_CONFIG_OBJECT_SQL} || '{"federated": false}'::jsonb WHERE id = $2 AND archived = false RETURNING id, name, archived_at, archive_expires_at`),
      params: ['36', 'src-a'],
    }]);
  });

  test('restoreArchivedSource keeps its text and binds the federated flag before the source id', async () => {
    const on = recorder();
    await restoreArchivedSource(on.exec, 'src-a', true);
    const off = recorder();
    await restoreArchivedSource(off.exec, 'src-a', false);
    const text = norm(`UPDATE sources SET archived = false, archived_at = NULL, archive_expires_at = NULL, config = ${SOURCE_CONFIG_OBJECT_SQL} || $1::text::jsonb WHERE id = $2 AND archived = true RETURNING id`);
    expect(on.calls).toEqual([{ text, params: ['{"federated": true}', 'src-a'] }]);
    expect(off.calls).toEqual([{ text, params: ['{"federated": false}', 'src-a'] }]);
  });
});

describe('facts-repair.ts rendered SQL', () => {
  test('listOntologyFactCandidates binds the source array and splices the constant predicates', async () => {
    const { calls, raw } = recorder();
    await listOntologyFactCandidates(raw, ['s1', 's2']);
    expect(calls).toEqual([{
      text: norm(`SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.source, f.source_markdown_slug AS page, f.row_num,
        ${EXPIRY_TEXT('f.expired_at')} AS expired_at,
        EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
          AND (w.subject='*' OR w.subject=f.entity_slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))) AS withdrawn,
        f.consolidated_into IS NOT NULL AS consolidated,
        ${DUPLICATE_SQL('f')} AS duplicate
        FROM facts f
        WHERE f.source_id=ANY($1::text[]) AND f.dimension IS NOT NULL AND f.entity_slug IS NOT NULL AND f.source IS NOT NULL
        AND (f.row_num IS NOT NULL OR f.source_markdown_slug IS DISTINCT FROM f.source) AND ${NOT_CONVERSATION_SLOT_SQL}
        ORDER BY f.id`),
      params: [['s1', 's2']],
    }]);
  });

  test('listPurgedPageFactCandidates binds the extraction sources as an array and the id filter at both uses', async () => {
    const some = recorder();
    await listPurgedPageFactCandidates(some.raw, ['s1'], [5, 6]);
    const all = recorder();
    await listPurgedPageFactCandidates(all.raw, ['s1'], null);
    const x = PURGED_EXCLUDED_SQL;
    const text = norm(`SELECT f.id, f.source_id, ${PURGED_HEAD_SQL} AS slug, f.fact, f.context, f.entity_slug, f.visibility, f.source,
      ${x.withdrawn} AS withdrawn, ${x.superseded} AS superseded, ${x.referenced} AS referenced,
      ${x.open_loop} AS open_loop, ${PURGED_PAGE_SQL} AS purged
      FROM facts f
      WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.source_markdown_slug IS NULL AND f.source = ANY($2::text[])
      AND ${PURGED_HEAD_SQL} <> '' AND ${PURGED_HEAD_SQL} !~ '[[:space:]]' AND (strpos(${PURGED_HEAD_SQL}, '/') > 0 OR ${PURGED_PAGE_SQL})
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = ${PURGED_HEAD_SQL})
      AND ($3::bigint[] IS NULL OR f.id = ANY($4::bigint[]))
      ORDER BY f.source_id, ${PURGED_HEAD_SQL}, f.id`);
    const sources = [...PAGE_EXTRACTION_SOURCE_LIST];
    expect(some.calls).toEqual([{ text, params: [['s1'], sources, [5, 6], [5, 6]] }]);
    expect(all.calls).toEqual([{ text, params: [['s1'], sources, null, null] }]);
  });
});
