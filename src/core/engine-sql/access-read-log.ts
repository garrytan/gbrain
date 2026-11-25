/**
 * The access read log (`access_read_log`, GST-2476 gap 1): the batched insert and the retention prune of
 * src/core/access/read-log.ts, and the reads of `gbrain access log` and `gbrain access who-read`
 * (src/commands/access-read-log.ts). One implementation for both engines; the Rust store keeps the same rows
 * (rust/crates/gbrain-store/src/access_read_log.rs) and serves the same members.
 *
 * Order: the log reads newest first, a tie by id. Two intended differences from the statements the callers sent: the
 * pages a slug names sort by source id in byte order (`COLLATE "C"`), and the who-read tally breaks a tie in its last
 * read time by who in byte order, so every engine and database locale agree.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One logged read: who, the operation, the transport, its result code and the ids of the pages it returned. */
export interface ReadLogRow {
  created_at: string;
  member: string | null;
  audience: string[] | null;
  operation: string;
  transport: string;
  result_code: string;
  page_ids: number[];
}

/** A logged read as the log reads return it: each page id as `source:slug`, or `#id` for a page no longer stored. */
export interface AccessReadLogEntryRow {
  created_at: string | Date;
  member: string | null;
  audience: string[] | null;
  operation: string;
  transport: string;
  result_code: string;
  pages: string[];
}

/** One reader of a set of pages in the window: who, how many reads and the last one. */
export interface AccessReadTallyRow { who: string; reads: number | string; last_at: string | Date }

const ACCESS_READ_LOG_INSERT_SQL = `INSERT INTO access_read_log (created_at, member, audience, operation, transport, result_code, page_ids)
  SELECT (r->>'created_at')::timestamptz, r->>'member',
    CASE WHEN jsonb_typeof(r->'audience') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'audience')) END,
    r->>'operation', r->>'transport', r->>'result_code', ARRAY(SELECT jsonb_array_elements_text(r->'page_ids')::int)
  FROM jsonb_array_elements($1::text::jsonb) r`;

const ACCESS_READ_LOG_SINCE_SQL = `SELECT l.created_at, l.member, l.audience, l.operation, l.transport, l.result_code,
  COALESCE((SELECT array_agg(COALESCE(p.source_id || ':' || p.slug, '#' || x.id) ORDER BY x.ord)
    FROM unnest(l.page_ids) WITH ORDINALITY AS x(id, ord) LEFT JOIN pages p ON p.id = x.id), '{}') AS pages
  FROM access_read_log l WHERE l.created_at >= $1::timestamptz
    AND ($2::text IS NULL OR l.member = $2 OR ('member:' || $2) = ANY(l.audience)) ORDER BY l.created_at DESC, l.id DESC LIMIT $3`;
const ACCESS_READ_LOG_PAGES_SQL = `SELECT l.created_at, l.member, l.audience, l.operation, l.transport, l.result_code,
  COALESCE((SELECT array_agg(COALESCE(p.source_id || ':' || p.slug, '#' || x.id) ORDER BY x.ord)
    FROM unnest(l.page_ids) WITH ORDINALITY AS x(id, ord) LEFT JOIN pages p ON p.id = x.id), '{}') AS pages
  FROM access_read_log l WHERE l.page_ids && $1::int[] AND l.created_at >= $2::timestamptz ORDER BY l.created_at DESC, l.id DESC LIMIT $3`;

/** Appends a batch of logged reads. */
export async function insertAccessReadLogRows(raw: EngineRawRead, rows: readonly ReadLogRow[]): Promise<void> {
  await raw(ACCESS_READ_LOG_INSERT_SQL, [JSON.stringify(rows)]);
}

/** Retention: rows past the window by time, then rows beyond the cap by id (oldest first). */
export async function pruneAccessReadLog(raw: EngineRawRead, days: number, maxRows: number): Promise<void> {
  await raw('DELETE FROM access_read_log WHERE created_at < now() - make_interval(days => $1::int)', [days]);
  await raw('DELETE FROM access_read_log WHERE id <= (SELECT max(id) FROM access_read_log) - $1::bigint', [maxRows]);
}

/** The logged reads since `since`, newest first, at most `limit`; with `member`, the reads it made and the audiences that named it. */
export function readAccessReadLog(raw: EngineRawRead, q: { since: string; member: string | null; limit: number }): Promise<AccessReadLogEntryRow[]> {
  return raw<AccessReadLogEntryRow>(ACCESS_READ_LOG_SINCE_SQL, [q.since, q.member, q.limit]);
}

/** Every stored page with this slug (in `sourceId` when given), soft-deleted ones too, by source id. */
export function listAccessReadPageRefs(raw: EngineRawRead, slug: string, sourceId: string | null): Promise<Array<{ id: number; source_id: string; slug: string }>> {
  return raw('SELECT id, source_id, slug FROM pages WHERE slug = $1 AND ($2::text IS NULL OR source_id = $2) ORDER BY source_id COLLATE "C"', [slug, sourceId]);
}

/** The logged reads that returned one of `pageIds` since `since`, newest first, at most `limit`. */
export function readAccessReadsOfPages(raw: EngineRawRead, q: { pageIds: readonly number[]; since: string; limit: number }): Promise<AccessReadLogEntryRow[]> {
  return raw<AccessReadLogEntryRow>(ACCESS_READ_LOG_PAGES_SQL, [[...q.pageIds], q.since, q.limit]);
}

/** Who read one of `pageIds` since `since` (the member, else the audience joined by `+`, else `(unbound)`), latest reader first. */
export function tallyAccessReadsOfPages(raw: EngineRawRead, q: { pageIds: readonly number[]; since: string }): Promise<AccessReadTallyRow[]> {
  return raw<AccessReadTallyRow>(`SELECT
      COALESCE(member, array_to_string(audience, '+'), '(unbound)') AS who, count(*) AS reads, max(created_at) AS last_at
    FROM access_read_log WHERE page_ids && $1::int[] AND created_at >= $2::timestamptz GROUP BY 1
    ORDER BY max(created_at) DESC, COALESCE(member, array_to_string(audience, '+'), '(unbound)') COLLATE "C"`, [[...q.pageIds], q.since]);
}
