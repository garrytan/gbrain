/**
 * Page write guards: the statements a page write runs to check and record a page's origin, stamp its ingest
 * provenance, seal an import's closing chunker version, read the page body a valid-time advisory compares and probe
 * segment storage. One SQL implementation for both engines. The statement text is what persistence/origin-guard.ts,
 * persistence/page-prepare.ts, page-state/projections.ts, persistence/valid-time-advisory.ts and
 * persistence/journal.ts sent through `executeRaw`; the origin bind and the import seal are composed fragments, so
 * their placeholders are numbered in order (test/fixtures/fold-hook-noop-6712.json pins every statement). The
 * decisions (which page, which spellings, whether a holder is the same file) stay in those callers; these functions
 * only read and write rows.
 */
import { pageSearchVectorSql } from '../fts-language.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { PageKind } from '../types.ts';
/** What a write's valid-time advisory compares of a page: its frontmatter and stored body, or a segmented body's content hash. */
export interface LivePageBodyRow { frontmatter: unknown; compiled_truth: string | null; timeline: string | null; body_storage: string | null; content_hash: string | null }


/** The page an origin check is about: its id, slug, recorded origin (file path and source URI) and tombstone time (null while live). */
export interface PageOriginRow { id: number; slug: string; source_path: string | null; source_uri: string | null; deleted_at: Date | string | null }

/** Which page: by id within the source when `pageId` is given, else by slug. */
export interface PageOriginTarget { sourceId: string; pageId?: number | null; slug?: string | null }

/** The page `target` names (live or a tombstone), or null when there is none or neither `pageId` nor `slug` is given. */
export async function readPageOrigin(exec: LegacyUnscopedRead, target: PageOriginTarget): Promise<PageOriginRow | null> {
  const [row] = target.pageId != null
    ? await exec.executeRaw<PageOriginRow>('SELECT id, slug, source_path, source_uri, deleted_at FROM pages WHERE id=$1 AND source_id=$2', [target.pageId, target.sourceId])
    : target.slug ? await exec.executeRaw<PageOriginRow>('SELECT id, slug, source_path, source_uri, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [target.sourceId, target.slug]) : [];
  return row ?? null;
}

/** The closing seal of a coordinated import (page-state/projections.ts `sealImportedPage`). */
export interface ImportedPageSeal { sourceId: string; revision: string | null; timelineText: string; chunkerVersion: number }

/**
 * Stamps `chunker_version` on page `slug` whatever its revision and, when its `knowledge_revision` is
 * `seal.revision`, seals its text projection at it and rebuilds its `search_vector` from its title and
 * `seal.timelineText` (already sanitized). Returns the page's id, or null when the page does not exist.
 */
export async function sealImportedPage(exec: SqlExecutor, slug: string, seal: ImportedPageSeal): Promise<{ id: number } | null> {
  // The timeline text is bound once (v.seal_input) so the shared vector expression splices as constant text.
  const [row] = (await exec.run<{ id: number }>(sqlFragment`UPDATE pages SET chunker_version=${seal.chunkerVersion},
    text_projection_revision=CASE WHEN knowledge_revision=${seal.revision}::uuid THEN knowledge_revision ELSE text_projection_revision END,
    search_vector=CASE WHEN knowledge_revision=${seal.revision}::uuid THEN ${trustedSql(pageSearchVectorSql('title', 'v.seal_input'))} ELSE search_vector END
    FROM (SELECT ${seal.timelineText}::text AS seal_input) v
    WHERE pages.source_id=${seal.sourceId} AND pages.slug=${slug} RETURNING pages.id`)).rows;
  return row ? { id: Number(row.id) } : null;
}

/** The page row columns a text projection is keyed on (page-state/projections.ts indexingContext). */
export interface PageIndexingState { chunker_version: number | null; corpus_generation: string | null; page_kind: PageKind }

/**
 * `readPageIndexingState`: page `pageId`'s stored chunker version, corpus generation and page kind, live or a tombstone,
 * or null when no page has that id. The two statements page-state/projections.ts sent, in the same order.
 */
export async function readPageIndexingState(exec: LegacyUnscopedRead, pageId: number): Promise<PageIndexingState | null> {
  const [projection] = await exec.executeRaw<{ chunker_version: number | null; corpus_generation: string | null }>(
    'SELECT chunker_version,corpus_generation FROM pages WHERE id=$1', [pageId]);
  const [kind] = await exec.executeRaw<{ page_kind: PageKind }>('SELECT page_kind FROM pages WHERE id=$1', [pageId]);
  if (!kind) return null;
  return { chunker_version: projection?.chunker_version ?? null, corpus_generation: projection?.corpus_generation ?? null, page_kind: kind.page_kind };
}

/** Whether the brain holds any segment storage: a body staging or a segment text. The vacuum skips its sweep without either. */
export async function hasSegmentStorage(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM page_body_stagings) OR EXISTS (SELECT 1 FROM page_segment_texts) AS present');
  return row?.present === true;
}

/** The body columns of live page `slug` of `opts.sourceId` (persistence/valid-time-advisory.ts), or null when it is not live. */
export async function readLivePageBody(exec: LegacyUnscopedRead, slug: string, opts: { sourceId: string }): Promise<LivePageBodyRow | null> {
  const [row] = await exec.executeRaw<LivePageBodyRow>(`SELECT frontmatter, compiled_truth, timeline, body_storage, content_hash FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [opts.sourceId, slug]);
  return row ?? null;
}

/** The stored `trust_tier` of the page `slug` names in the source, live or a tombstone (trust/page-write.ts storedPageTier), or null without one. */
export async function readStoredPageTier(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row ? row.trust_tier : null;
}
