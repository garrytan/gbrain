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

/** The page an origin check is about: its id, slug, recorded origin and tombstone time (null while live). */
export interface PageOriginRow { id: number; slug: string; source_path: string | null; deleted_at: Date | string | null }

/** A live page that records one of the origin spellings a check asked about. */
export interface OriginClaimRow { slug: string; source_path: string }

/** Which page: by id within the source when `pageId` is given, else by slug. */
export interface PageOriginTarget { sourceId: string; pageId?: number | null; slug?: string | null }

/** The page `target` names (live or a tombstone), or null when there is none or neither `pageId` nor `slug` is given. */
export async function readPageOrigin(exec: LegacyUnscopedRead, target: PageOriginTarget): Promise<PageOriginRow | null> {
  const [row] = target.pageId != null
    ? await exec.executeRaw<PageOriginRow>('SELECT id, slug, source_path, deleted_at FROM pages WHERE id=$1 AND source_id=$2', [target.pageId, target.sourceId])
    : target.slug ? await exec.executeRaw<PageOriginRow>('SELECT id, slug, source_path, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [target.sourceId, target.slug]) : [];
  return row ?? null;
}

/** A soft-deleted page a restore of its slug would revive. */
export interface RevivalPageRow { id: number; source_id: string }

// moved from persistence/origin-guard.ts assertRevivalUnclaimed unchanged
const REVIVAL_PAGES_SQL = 'SELECT id, source_id FROM pages WHERE slug=$1 AND deleted_at IS NOT NULL AND ($2::text IS NULL OR source_id=$2) ORDER BY source_id COLLATE "C"';

/** The soft-deleted pages with `slug` (of `sourceId` only, when given), by source id in byte order. */
export async function listRevivalPages(exec: LegacyUnscopedRead, slug: string, sourceId: string | null): Promise<RevivalPageRow[]> {
  return exec.executeRaw<RevivalPageRow>(REVIVAL_PAGES_SQL, [slug, sourceId]);
}

/**
 * Takes the transaction advisory lock of each origin key in `lockKeys` (in the order given), then returns the live
 * pages of `sourceId`, other than page `excludePageId`, whose origin is one of `spellings`, in slug order. On Windows
 * a stored origin is compared with `\` read as `/` and case folded, as the caller folds `spellings`.
 */
const ORIGIN_CLAIMS_SQL = 'SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[]) AND id<>$3 ORDER BY slug COLLATE "C"';
const ORIGIN_CLAIMS_WIN32_SQL = "SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND lower(replace(source_path,chr(92),'/'))=ANY($2::text[]) AND id<>$3 ORDER BY slug COLLATE \"C\"";

export async function listOriginClaims(exec: SqlExecutor, sourceId: string, spellings: readonly string[],
  opts: { lockKeys: readonly string[]; excludePageId?: number | null }): Promise<OriginClaimRow[]> {
  for (const key of opts.lockKeys) {
    await exec.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gbrain:origin:${JSON.stringify([sourceId, key])}`]);
  }
  return exec.executeRaw<OriginClaimRow>(process.platform === 'win32' ? ORIGIN_CLAIMS_WIN32_SQL : ORIGIN_CLAIMS_SQL,
  [sourceId, [...spellings], opts.excludePageId ?? -1]);
}

/**
 * Records `sourcePath` as the origin of the page `pageId` (else `slug`) names, and drops its `origin_twin`
 * database-only marker once it records that origin. `onlyIfUnset` fills a missing origin only; `liveOnly` never
 * touches a tombstone. Returns the number of pages whose origin changed. The caller holds the origin check
 * (`assertOriginUnclaimed`) in the same transaction and maps a unique violation on `pages_live_origin_key`.
 */
export async function bindPageOrigin(exec: SqlExecutor, target: PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }): Promise<number> {
  const page = target.pageId != null ? sqlFragment`id=${target.pageId}` : sqlFragment`slug=${target.slug}`;
  const differs = target.onlyIfUnset ? sqlFragment`source_path IS NULL` : sqlFragment`source_path IS DISTINCT FROM ${target.sourcePath}`;
  const live = trustedSql(target.liveOnly ? ' AND deleted_at IS NULL' : '');
  // origin-guard-ok: persistence/origin-guard.ts bindOrigin is the only caller and runs assertOriginUnclaimed first
  const changed = (await exec.run(sqlFragment`UPDATE pages SET source_path=${target.sourcePath} WHERE source_id=${target.sourceId} AND ${page} AND ${differs}${live} RETURNING id`)).rows.length;
  await exec.run(sqlFragment`UPDATE pages SET database_only_reason=NULL WHERE source_id=${target.sourceId} AND ${page} AND source_path=${target.sourcePath} AND database_only_reason='origin_twin'`);
  return changed;
}

/** Ingest provenance a write records on its page. `ingestedAt` is an ISO timestamp (or null). */
export interface PageIngestStamp { sourceId: string; sourceKind: string | null; ingestedVia: string | null; ingestedAt: string | null }

/** Records where page `slug` of `stamp.sourceId` came from (`source_kind`, `ingested_via`, `ingested_at`). A missing page writes nothing. */
export async function stampPageIngest(exec: SqlExecutor, slug: string, stamp: PageIngestStamp): Promise<void> {
  await exec.executeRaw(`UPDATE pages SET source_kind=$3,ingested_via=$4,ingested_at=$5::timestamptz
          WHERE source_id=$1 AND slug=$2`, [stamp.sourceId, slug, stamp.sourceKind, stamp.ingestedVia, stamp.ingestedAt]);
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

/** What a write's valid-time advisory compares of a page: its frontmatter and stored body, or a segmented body's content hash. */
export interface LivePageBodyRow { frontmatter: unknown; compiled_truth: string | null; timeline: string | null; body_storage: string | null; content_hash: string | null }

/** The body columns of live page `slug` of `opts.sourceId` (persistence/valid-time-advisory.ts), or null when it is not live. */
export async function readLivePageBody(exec: LegacyUnscopedRead, slug: string, opts: { sourceId: string }): Promise<LivePageBodyRow | null> {
  const [row] = await exec.executeRaw<LivePageBodyRow>(`SELECT frontmatter, compiled_truth, timeline, body_storage, content_hash FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [opts.sourceId, slug]);
  return row ?? null;
}

/** The body columns of a page, read raw (no withdrawal overlay): NULL on a segmented page. */
export interface InlinePageRegionsRow { compiled_truth: string | null; timeline: string | null }

/** The stored body columns of page `pageId`, live or a tombstone (page-body/tail-digest.ts inlineRegions), or null when no page has the id. */
export async function readInlinePageRegions(exec: LegacyUnscopedRead, pageId: number): Promise<InlinePageRegionsRow | null> {
  const [row] = await exec.executeRaw<InlinePageRegionsRow>('SELECT compiled_truth, timeline FROM pages WHERE id=$1', [pageId]);
  return row ?? null;
}

/** The stored `trust_tier` of the page `slug` names in the source, live or a tombstone (trust/page-write.ts storedPageTier), or null without one. */
export async function readStoredPageTier(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row ? row.trust_tier : null;
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

/**
 * Forgets the file page `pageId` records (`source_path` and `source_uri` set to NULL) and marks it database-only with
 * `reason` (`detached`, `origin_twin`): the repair detach statement origin-twins.ts, persistence/twin-merge.ts and
 * file-drift.ts sent. Live or a tombstone. The knowledge revision stays: neither column is part of it.
 */
export async function detachPageOrigin(exec: SqlExecutor, pageId: number, reason: string): Promise<void> {
  await exec.run(sqlFragment`UPDATE pages SET source_path=NULL, source_uri=NULL, database_only_reason=${reason} WHERE id=${pageId}`);
}

/** The `database_only_reason` of the page `slug` names in the source, live or a tombstone, or null (also for no such page). */
export async function readPageDatabaseOnlyReason(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ database_only_reason: string | null }>('SELECT database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row?.database_only_reason ?? null;
}

/** Gives page `pageId` a new knowledge revision (live or a tombstone), which also clears its text projection seal. */
export async function bumpPageKnowledgeRevision(exec: SqlExecutor, pageId: number): Promise<void> {
  await exec.run(sqlFragment`UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=${pageId}`);
}

/**
 * Removes `keys` from the frontmatter of live page `pageId` of the source. A page that held one of them takes a new
 * knowledge revision; a tombstone, another source's page or a page without the keys keeps its revision.
 */
export async function removePageFrontmatterKeys(exec: SqlExecutor, sourceId: string, pageId: number, keys: readonly string[]): Promise<void> {
  await exec.run(sqlFragment`UPDATE pages SET frontmatter=frontmatter-${[...keys]}::text[] WHERE id=${pageId} AND source_id=${sourceId} AND deleted_at IS NULL`);
}

/** Sets the `type` of the page `slug` names in the source, live or a tombstone. A changed type takes a new knowledge revision. */
export async function setPageType(exec: SqlExecutor, sourceId: string, slug: string, type: string): Promise<void> {
  await exec.run(sqlFragment`UPDATE pages SET type=${type} WHERE source_id=${sourceId} AND slug=${slug}`);
}
