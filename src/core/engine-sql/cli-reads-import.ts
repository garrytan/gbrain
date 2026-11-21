/**
 * Reads the CLI import, extract and company-brain paths ran through `executeRaw`, unscoped, before they had typed
 * members. Each function keeps the statement text its call site ran, byte for byte (scripts/sql-move-check.mjs holds it
 * to that), so PGLite and Postgres answer exactly as before. The reads that splice trust or guest predicates into
 * their text (page and row trust, guest source lists) stay at their call sites.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One `sources` row as `listSourceRecords` returns it; `archived` and `newest_content_at` are absent on a schema that lacks them. */
export interface SourceRecordRow {
  id: string; name: string; local_path: string | null; last_commit: string | null; last_sync_at: Date | null;
  /** Postgres returns an object; PGLite may return JSON text. */
  config: Record<string, unknown> | string;
  created_at: Date; archived?: boolean; newest_content_at?: Date | null;
}
/** A source's config and incarnation (`readSourceIncarnation`). */
export interface SourceIncarnationRow { config: unknown; incarnation: string }
/** A live page with its frontmatter aliases and knowledge revision (`listLinkPageMetadata`). */
export interface LinkPageMetadataRow { slug: string; source_id: string; type: string; title: string; aliases?: unknown; knowledge_revision: string }
/** One stored non-event timeline row (`listStoredTimelineRows`); `date` is `YYYY-MM-DD`. */
export interface StoredTimelineRow { id: number; date: string; source: string; summary: string; detail: string | null }
/** A page and the knowledge revision `filterPagesAtRevision` checks it is still at. */
export interface PageAtRevisionRef { source_id: string; slug: string; revision: string }

/** Driver-tolerant 42703 detector (the copy sources-load.ts keeps for its single-row read). */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}

/**
 * Every source, `default` first, then by id, with the columns `loadAllSources` reads. A brain whose schema lacks
 * `archived` or `newest_content_at` (pre-v0.26.5, pre-v109) is read again with the historical minimal columns.
 */
export async function listSourceRecords(exec: LegacyUnscopedRead): Promise<SourceRecordRow[]> {
  return listSourceRecordsEach(run => run(exec));
}

/**
 * `listSourceRecords` with each of its two statements run through `read` (a bounded read on Postgres, as master's two
 * `executeRaw` calls were: the undefined-column error ends the first read's transaction, so the fallback cannot share it).
 */
export async function listSourceRecordsEach(read: (run: (exec: LegacyUnscopedRead) => Promise<SourceRecordRow[]>) => Promise<SourceRecordRow[]>): Promise<SourceRecordRow[]> {
  try {
    return await read(listSourceRecordsFull);
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    return read(listSourceRecordsMinimal);
  }
}

/** `listSourceRecords`' first statement. */
export async function listSourceRecordsFull(exec: LegacyUnscopedRead): Promise<SourceRecordRow[]> {
  return exec.executeRaw<SourceRecordRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
  );
}

/** `listSourceRecords`' fallback for a schema without `archived` or `newest_content_at`: the historical minimal columns. */
export async function listSourceRecordsMinimal(exec: LegacyUnscopedRead): Promise<SourceRecordRow[]> {
  return exec.executeRaw<SourceRecordRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
           FROM sources
         ORDER BY (id = 'default') DESC, id`,
  );
}

/**
 * One source's config and incarnation, or null for an unknown id (the company-brain profile read). It runs through the
 * engine's own `executeRaw`, as the profile read did, so a cancelled request and a wrapped `executeRaw` see it.
 */
export async function readSourceIncarnation(raw: EngineRawRead, sourceId: string): Promise<SourceIncarnationRow | null> {
  const [row] = await raw<SourceIncarnationRow>('SELECT config,incarnation FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/** Whether the source's current incarnation has a company-brain ingestion receipt. */
export async function hasCompanyBrainReceipt(raw: EngineRawRead, sourceId: string): Promise<boolean> {
  const rows = await raw(`SELECT r.id FROM source_ingestion_receipts r JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation
      WHERE r.source_id=$1 AND r.profile='company-brain' LIMIT 1`, [sourceId]);
  return rows.length > 0;
}

/** The database clock as a UTC ISO string with microseconds, independent of the session's DateStyle. */
export async function readDatabaseClock(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row!.at;
}

/** Every live page (of one source when given) with its aliases and knowledge revision, by source then slug. */
export async function listLinkPageMetadata(exec: LegacyUnscopedRead, sourceId?: string): Promise<LinkPageMetadataRow[]> {
  return exec.executeRaw<LinkPageMetadataRow>(`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision FROM pages
    WHERE deleted_at IS NULL${sourceId ? ' AND source_id=$1' : ''} ORDER BY source_id, slug`, sourceId ? [sourceId] : []);
}

/** Every stored non-event timeline row of one page, the date as `YYYY-MM-DD`, in no particular order. */
export async function listStoredTimelineRows(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<StoredTimelineRow[]> {
  return exec.executeRaw<StoredTimelineRow>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline_entries t
      JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.event_page_id IS NULL`, [sourceId, slug]);
}

/** The live pages among `refs` that are still at the knowledge revision each names, in no particular order. */
export async function filterPagesAtRevision(exec: LegacyUnscopedRead, refs: readonly PageAtRevisionRef[]): Promise<Array<{ slug: string; source_id: string }>> {
  if (refs.length === 0) return [];
  return exec.executeRaw<{ slug: string; source_id: string }>(`SELECT p.slug,p.source_id FROM pages p
      JOIN unnest($1::text[],$2::text[],$3::text[]) AS t(source_id,slug,revision) ON p.source_id=t.source_id AND p.slug=t.slug
      WHERE p.knowledge_revision::text=t.revision AND p.deleted_at IS NULL`, [refs.map(r => r.source_id), refs.map(r => r.slug), refs.map(r => r.revision)]);
}
