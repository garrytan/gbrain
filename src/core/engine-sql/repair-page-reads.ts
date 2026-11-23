/**
 * The page reads and writes of the access and orphan-children repair kinds and of the origin index (#6948), moved
 * here verbatim from repair/access.ts, repair/orphan-children.ts, persistence/origin-index.ts and the doctor checks
 * that share them (member-access, child_table_orphans, origin_twins) so the Rust engine can serve them as typed
 * members. PGLite and Postgres run the same statements as before, unscoped through executeRaw; writes take the
 * engine's own executor. The Rust engine answers from its store (rust/docs/store/repair-bookkeeping.md, "Page repair
 * reads").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** One FK child of pages. `allowNull`: the FK is ON DELETE SET NULL, so NULL is valid and an orphan is cleared, not deleted. */
export interface PageChildTarget { table: string; col: string; allowNull: boolean }

/** FK children of pages. */
export const PAGE_CHILD_FK_TARGETS: ReadonlyArray<PageChildTarget> = [
  { table: 'content_chunks', col: 'page_id', allowNull: false },
  { table: 'page_versions', col: 'page_id', allowNull: false },
  { table: 'tags', col: 'page_id', allowNull: false },
  { table: 'takes', col: 'page_id', allowNull: false },
  { table: 'raw_data', col: 'page_id', allowNull: false },
  { table: 'timeline_entries', col: 'page_id', allowNull: false },
  { table: 'links', col: 'from_page_id', allowNull: false },
  { table: 'links', col: 'to_page_id', allowNull: false },
  { table: 'links', col: 'origin_page_id', allowNull: true },
  { table: 'files', col: 'page_id', allowNull: true },
];

/** The listed target named by `table` and `col`; anything else throws, so no caller text reaches the SQL. */
export function pageChildTarget(target: { table: string; col: string }): PageChildTarget {
  const found = PAGE_CHILD_FK_TARGETS.find(t => t.table === target.table && t.col === target.col);
  if (!found) throw new Error(`not a page child column: ${target.table}.${target.col}`);
  return found;
}

// The table and column names reach SQL only through these constant maps; `pageChildTarget` rejects anything else first.
const CHILD_TABLE_SQL = {
  content_chunks: 'content_chunks', page_versions: 'page_versions', tags: 'tags', takes: 'takes', raw_data: 'raw_data',
  timeline_entries: 'timeline_entries', links: 'links', files: 'files',
} as const;
const CHILD_COLUMN_SQL = { page_id: 'page_id', from_page_id: 'from_page_id', to_page_id: 'to_page_id', origin_page_id: 'origin_page_id' } as const;

function childTableSql(target: PageChildTarget): SqlFragment {
  return sqlFragment`${trustedSql(CHILD_TABLE_SQL[target.table as keyof typeof CHILD_TABLE_SQL])}`;
}

// NOT EXISTS (not `NOT IN (SELECT id FROM pages)`) so the planner can use a
// hash anti-join: once the page-id list outgrows work_mem, NOT IN degrades to a
// per-row rescan of pages. pages.id is the primary key (never NULL), so the
// semantics match NOT IN exactly. The column is table-qualified because the
// predicate also runs inside the repair's UPDATE and DELETE statements.
export function orphanPredicate(target: PageChildTarget): SqlFragment {
  const col = sqlFragment`${childTableSql(target)}.${trustedSql(CHILD_COLUMN_SQL[target.col as keyof typeof CHILD_COLUMN_SQL])}`;
  return sqlFragment`${target.allowNull ? sqlFragment`${col} IS NOT NULL AND ` : sqlFragment``}NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = ${col})`;
}

/** Rows of `target` whose page no longer exists (non-null references only for a SET NULL column). */
export async function countPageChildOrphans(exec: LegacyUnscopedRead, target: { table: string; col: string }): Promise<number> {
  const t = pageChildTarget(target);
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM ${childTableSql(t)} WHERE ${orphanPredicate(t)}`);
  const [row] = await exec.executeRaw<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

/** Deletes the orphans of `target`, or clears the reference of a SET NULL column, rechecking the predicate; the row count. */
export async function clearPageChildOrphans(exec: SqlExecutor, target: { table: string; col: string }): Promise<number> {
  const t = pageChildTarget(target);
  const col = trustedSql(CHILD_COLUMN_SQL[t.col as keyof typeof CHILD_COLUMN_SQL]);
  const { text, params } = renderFragment(t.allowNull
    ? sqlFragment`WITH cleared AS (UPDATE ${childTableSql(t)} SET ${col} = NULL WHERE ${orphanPredicate(t)} RETURNING 1) SELECT count(*)::int AS n FROM cleared`
    : sqlFragment`WITH removed AS (DELETE FROM ${childTableSql(t)} WHERE ${orphanPredicate(t)} RETURNING 1) SELECT count(*)::int AS n FROM removed`);
  const rows = await exec.executeRaw<{ n: number }>(text, params);
  return Number(rows[0]?.n ?? 0);
}

/** A page named by id, source and slug. */
export interface PageRef { id: number; source_id: string; slug: string }

/** Pages whose stored body cannot be read: how many, and the first 20 by id. */
export interface TornPages { count: number; named: PageRef[] }

const PROBE_BATCH = 500;
const PROBE_SQL = `SELECT id, length(compiled_truth) + length(COALESCE(timeline, '')) + length(COALESCE(frontmatter::text, '')) AS n
  FROM pages WHERE id = ANY($1::bigint[])`;

/**
 * Page rows whose body, timeline or frontmatter cannot be read back (a torn TOAST value): every page body read one
 * batch at a time, then row by row inside a failing batch. The ids and slugs are named after the probe.
 */
export async function probeTornPages(exec: LegacyUnscopedRead): Promise<TornPages> {
  const torn: number[] = [];
  let cursor = 0;
  for (;;) {
    const ids = (await exec.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id > $1 ORDER BY id LIMIT $2', [cursor, PROBE_BATCH])).map(r => Number(r.id));
    if (ids.length === 0) break;
    try { await exec.executeRaw(PROBE_SQL, [ids]); }
    catch {
      for (const id of ids) {
        try { await exec.executeRaw(PROBE_SQL, [[id]]); } catch { torn.push(id); }
      }
    }
    cursor = ids[ids.length - 1]!;
  }
  if (torn.length === 0) return { count: 0, named: [] };
  const named = await exec.executeRaw<PageRef>('SELECT id, source_id, slug FROM pages WHERE id = ANY($1::bigint[]) ORDER BY id LIMIT 20', [torn]);
  return { count: torn.length, named: named.map(p => ({ id: Number(p.id), source_id: p.source_id, slug: p.slug })) };
}

/**
 * Pages of `sourceIds` after id `afterId` whose stored readers differ from the readers their frontmatter names (GBRA-218),
 * by id: pages written before the member-access migration.
 */
export async function listAccessReaderDrift(exec: LegacyUnscopedRead, sourceIds: readonly string[], afterId: number): Promise<PageRef[]> {
  const rows = await exec.executeRaw<PageRef>(
    `SELECT id, source_id, slug FROM pages
        WHERE source_id = ANY($1::text[]) AND id > $2
          AND (frontmatter ? 'readable_by' OR page_readers IS NOT NULL)
          AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter)
        ORDER BY id`,
    [[...sourceIds], afterId]);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug }));
}

/** How many pages brain-wide name readers whose stored readers differ from them (doctor `access_page_readers_backfill`). */
export async function countAccessReaderDrift(exec: LegacyUnscopedRead): Promise<number> {
  const [row] = await exec.executeRaw<{ total: number }>(
    `SELECT count(*)::int AS total FROM pages
      WHERE (frontmatter->'readable_by' IS NOT NULL OR page_readers IS NOT NULL)
        AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter)`);
  return Number(row?.total ?? 0);
}

/** Stores the readers page `pageId`'s frontmatter names when they differ; false when nothing changed. */
export async function deriveAccessReaders(exec: SqlExecutor, pageId: number): Promise<boolean> {
  const rows = await exec.executeRaw<{ id: number }>(
    `UPDATE pages SET page_readers = gbrain_access_readers(frontmatter)
        WHERE id = $1 AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter) RETURNING id`, [pageId]);
  return rows.length > 0;
}

/** The state of the `pages_live_origin_key` index: missing, built but not yet valid (Postgres), or present. */
export type OriginIndexState = 'present' | 'missing' | 'invalid';

/** Live twin groups (same stored origin) of one source. */
export interface OriginTwinCount { source_id: string; groups: number; twins: number }

export const ORIGIN_INDEX_NAME = 'pages_live_origin_key';

/** The index's state; on PGLite an index is valid once it exists. */
export async function readOriginIndexState(exec: LegacyUnscopedRead): Promise<OriginIndexState> {
  if (exec.dialect !== 'postgres') {
    const [row] = await exec.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [ORIGIN_INDEX_NAME]);
    return row?.present ? 'present' : 'missing';
  }
  const [row] = await exec.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [ORIGIN_INDEX_NAME]);
  return !row ? 'missing' : row.valid ? 'present' : 'invalid';
}

/** Live twin groups (same stored origin) per source, by source id, at most `limit` sources. */
export async function listOriginTwinCounts(exec: LegacyUnscopedRead, limit: number): Promise<OriginTwinCount[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT source_id, count(*)::int AS groups, (sum(n) - count(*))::int AS twins
    FROM (SELECT source_id, count(*) AS n FROM pages WHERE deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_id, source_path HAVING count(*) > 1) g
    GROUP BY source_id ORDER BY source_id COLLATE "C" LIMIT ${Math.max(1, Math.floor(limit))}`);
  const rows = await exec.executeRaw<OriginTwinCount>(text, params);
  return rows.map(row => ({ source_id: row.source_id, groups: Number(row.groups), twins: Number(row.twins) }));
}
