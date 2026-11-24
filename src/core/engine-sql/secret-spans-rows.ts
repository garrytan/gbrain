/**
 * The page-store reads and writes of `gbrain repair secret-spans` (repair/secret-spans.ts, GST-327 and GST-2988) as
 * typed members: the page and its stores read as one redaction input, the timeline rows a redaction's dedup key must
 * stay unique across, the retained versions, the chunk rows that may hold a value, and the writes of the rewrite. Both SQL
 * engines delegate here; the Rust store serves the same members from rust/crates/gbrain-store/src/repair_secret_spans.rs
 * (rust/docs/store/secret-store.md). The statement texts are the ones the kind ran through `executeRaw`.
 *
 * A value never travels in a parameter of a read: the kind matches values in TypeScript, so a statement log never holds
 * one. A write takes the redacted text (a marker, never the value it replaced).
 *
 * Row identity: `timeline_entries`, `facts`, `takes` and `links` rows are named by their `id`. The Rust store keeps no
 * serial id on `raw_data` rows (one row per page and source), so a raw data row is named by `(pageId, id)`: on the SQL
 * engines `id` is the table's serial and `pageId` is not read; on the Rust store `id` is the row's position, from 1, among
 * the page's raw data rows in source order.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;
type Json = Record<string, unknown>;

/** The page row a redaction reads: columns, the body's storage state and the page's tags. */
export interface PageRedactionRow {
  id: number; source_id: string; slug: string; title: string; type: string; page_kind: string; frontmatter: Json | null;
  compiled_truth: string | null; timeline: string | null; body_storage: string; body_bytes: number | string | null; generation: string;
  body_flags: Json | null; revision: string; contextual_retrieval_mode: string | null; corpus_generation: string | null; tags: string[];
}

export interface RedactionTimelineRow { id: number; summary: string; detail: string; source: string }
export interface RedactionFactRow { id: number; fact: string | null; context: string | null; value: string | null }
export interface RedactionTakeRow { id: number; claim: string | null; source: string | null; resolved_source: string | null }
export interface RedactionLinkRow { id: number; context: string | null }
export interface RedactionRawDataRow { id: number; data: unknown }

/** Every store of one page a redaction reads besides the page row, each in id order. */
export interface PageRedactionRows {
  timeline: RedactionTimelineRow[]; facts: RedactionFactRow[]; takes: RedactionTakeRow[]; links: RedactionLinkRow[]; rawData: RedactionRawDataRow[];
}

export interface TimelineDedupRow { id: number; page_id: number; date: string; summary: string; source: string }
export interface RetainedVersionBody { id: number; compiled_truth: string | null; frontmatter: unknown; body_storage: string | null }
export interface ChunkTextRow { id?: number; chunk_text: string; doc_comment: string | null }

/** The stores whose rows a redaction rewrites by id, with the columns it may rewrite in each. */
export const REDACTED_ROW_COLUMNS = {
  timeline_entries: ['summary', 'detail', 'source'],
  facts: ['fact', 'context', 'value'],
  takes: ['claim', 'source', 'resolved_source'],
  links: ['context'],
} as const;
export type RedactedRowStore = keyof typeof REDACTED_ROW_COLUMNS;

/** What the page row takes: the redacted text of every stored page field, with the content hash of the redacted page. */
export interface RedactedPageFields { title: string; frontmatter: Json; compiledTruth: string; timeline: string; contentHash: string }

const PAGE_SQL = `SELECT p.id,p.source_id,p.slug,p.title,p.type,p.page_kind,p.frontmatter,p.compiled_truth,p.timeline,p.body_storage,p.body_bytes,
    COALESCE(p.body_generation,0)::text AS generation,p.body_flags,p.knowledge_revision::text AS revision,p.contextual_retrieval_mode,p.corpus_generation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags
  FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`;

/** The live page at (source, slug) as a redaction reads it, or null. */
export async function readPageRedactionRow(exec: Raw, sourceId: string, slug: string): Promise<PageRedactionRow | null> {
  const [page] = await exec.executeRaw<PageRedactionRow>(PAGE_SQL, [sourceId, slug]);
  return page ?? null;
}

const asIds = <T extends { id: number | string }>(rows: T[]): Array<Omit<T, 'id'> & { id: number }> => rows.map(row => ({ ...row, id: Number(row.id) }));

/** The timeline rows (page or event page), fact rows (held by the page or naming it with no holder), takes, link contexts and raw data of page `pageId`. */
export async function readPageRedactionRows(exec: Raw, pageId: number, sourceId: string, slug: string): Promise<PageRedactionRows> {
  return {
    timeline: asIds(await exec.executeRaw<RedactionTimelineRow>('SELECT id,summary,detail,source FROM timeline_entries WHERE page_id=$1 OR event_page_id=$1 ORDER BY id', [pageId])),
    facts: asIds(await exec.executeRaw<RedactionFactRow>(`SELECT id,fact,context,value FROM facts
    WHERE source_id=$1 AND (source_markdown_slug=$2 OR (source_markdown_slug IS NULL AND entity_slug=$2)) ORDER BY id`, [sourceId, slug])),
    takes: asIds(await exec.executeRaw<RedactionTakeRow>('SELECT id,claim,source,resolved_source FROM takes WHERE page_id=$1 ORDER BY id', [pageId])),
    links: asIds(await exec.executeRaw<RedactionLinkRow>('SELECT id,context FROM links WHERE from_page_id=$1 ORDER BY id', [pageId])),
    rawData: asIds(await exec.executeRaw<RedactionRawDataRow>('SELECT id,data FROM raw_data WHERE page_id=$1 ORDER BY id', [pageId])),
  };
}

/** Every timeline row of the pages whose rows belong to page `pageId` (its own and its event rows'): the rows a redacted dedup key must stay unique across. */
export async function listTimelineDedupRows(exec: Raw, pageId: number): Promise<TimelineDedupRow[]> {
  return asIds(await exec.executeRaw<TimelineDedupRow>(`SELECT id,page_id,date::text AS date,summary,source
    FROM timeline_entries WHERE page_id IN (SELECT page_id FROM timeline_entries WHERE page_id=$1 OR event_page_id=$1)`, [pageId]));
}

/** The page's retained versions in id order. */
export async function listVersionBodiesForRedaction(exec: Raw, pageId: number): Promise<RetainedVersionBody[]> {
  return asIds(await exec.executeRaw<RetainedVersionBody>('SELECT id,compiled_truth,frontmatter,body_storage FROM page_versions WHERE page_id=$1 ORDER BY id', [pageId]));
}

export async function countPageVersionRows(exec: Raw, pageId: number): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [pageId]);
  return Number(row?.n ?? 0);
}

/** Rewrites a retained version's text and frontmatter (`pageId` names its page for the store; the SQL names only the id). */
export async function setRetainedVersionBody(exec: Raw, _pageId: number, id: number, compiledTruth: string | null, frontmatter: unknown): Promise<void> {
  await exec.executeRaw('UPDATE page_versions SET compiled_truth=$2,frontmatter=$3::text::jsonb WHERE id=$1', [id, compiledTruth, JSON.stringify(frontmatter)]);
}

/**
 * Every stored chunk row of the page, staged and retired included. `rewrite` reads the ids too (the rows a rewrite may
 * delete); `scan` is the residual scan's read of the texts alone.
 */
export async function listChunkTextsForRedaction(exec: Raw, pageId: number, purpose: 'rewrite' | 'scan'): Promise<ChunkTextRow[]> {
  if (purpose === 'scan') {
    return exec.executeRaw<ChunkTextRow>(
      'SELECT chunk_text,doc_comment FROM content_chunks WHERE page_id=$1 -- chunk-visibility-ok: the residual scan reads every stored chunk row, staged and retired included', [pageId]);
  }
  return asIds(await exec.executeRaw<ChunkTextRow & { id: number }>(
    'SELECT id,chunk_text,doc_comment FROM content_chunks WHERE page_id=$1 -- chunk-visibility-ok: every stored row of the page is checked for a value', [pageId]));
}

/** Deletes chunk rows by id (`pageId` names their page for the store; the SQL names only the ids). */
export async function deleteChunksByIds(exec: Raw, _pageId: number, ids: readonly number[]): Promise<void> {
  await exec.executeRaw('DELETE FROM content_chunks WHERE id=ANY($1::int[])', [[...ids]]);
}

/** Rewrites the page row's text fields and content hash and stamps `updated_at`. */
export async function setRedactedPageFields(exec: Raw, pageId: number, fields: RedactedPageFields): Promise<void> {
  await exec.executeRaw('UPDATE pages SET title=$2,frontmatter=$3::text::jsonb,compiled_truth=$4,timeline=$5,content_hash=$6,updated_at=now() WHERE id=$1',
    [pageId, fields.title, JSON.stringify(fields.frontmatter), fields.compiledTruth, fields.timeline, fields.contentHash]);
}

/** The data of one raw data row (see the row identity note above). */
export async function readRawDataValue(exec: Raw, _pageId: number, id: number): Promise<unknown> {
  return (await exec.executeRaw<{ data: unknown }>('SELECT data FROM raw_data WHERE id=$1', [id]))[0]?.data;
}

export async function setRawDataValue(exec: Raw, _pageId: number, id: number, data: unknown): Promise<void> {
  await exec.executeRaw('UPDATE raw_data SET data=$2::text::jsonb WHERE id=$1', [id, JSON.stringify(data)]);
}

/** One constant UPDATE per (store, column) a redaction rewrites; a fact or take loses its embedding, and a take stamps `updated_at`. */
const ROW_TEXT_SQL: Record<string, string> = {
  'timeline_entries.summary': 'UPDATE timeline_entries SET summary=$2 WHERE id=$1',
  'timeline_entries.detail': 'UPDATE timeline_entries SET detail=$2 WHERE id=$1',
  'timeline_entries.source': 'UPDATE timeline_entries SET source=$2 WHERE id=$1',
  'facts.fact': 'UPDATE facts SET fact=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL WHERE id=$1',
  'facts.context': 'UPDATE facts SET context=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL WHERE id=$1',
  'facts.value': 'UPDATE facts SET value=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL WHERE id=$1',
  'takes.claim': 'UPDATE takes SET claim=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL,updated_at=now() WHERE id=$1',
  'takes.source': 'UPDATE takes SET source=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL,updated_at=now() WHERE id=$1',
  'takes.resolved_source': 'UPDATE takes SET resolved_source=$2,embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL,updated_at=now() WHERE id=$1',
  'links.context': 'UPDATE links SET context=$2 WHERE id=$1',
};

/**
 * Rewrites one text column of a row of `store` that page `pageId`'s redaction read (`pageId` names the page for the store;
 * the SQL names only the id). A fact or take loses its embedding with the rewrite (the vector was computed from the old
 * text), and a take stamps `updated_at`.
 */
export async function setRedactedRowText(exec: Raw, _pageId: number, store: RedactedRowStore, id: number, column: string, text: string): Promise<void> {
  const sql = Object.hasOwn(ROW_TEXT_SQL, `${store}.${column}`) ? ROW_TEXT_SQL[`${store}.${column}`] : undefined;
  if (!sql) throw new Error(`setRedactedRowText: ${store}.${column} is not a column a redaction rewrites`);
  await exec.executeRaw(sql, [id, text]);
}
