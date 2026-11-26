/**
 * Doctor page reads: the page-table statements `gbrain doctor` checks ran through `executeRaw`, each with the same text
 * and parameters, on the engine's own `executeRaw`; only their home moved (src/commands/doctor/**, src/core/backup,
 * src/core/maintenance, src/core/trust). Each variant is one constant statement, so no clause is spliced into SQL.
 * The Rust engine answers the same members from its store records
 * (rust/crates/gbrain-store/src/cli_reads/doctor_pages.rs, rust/docs/store/cli-reads-doctor-pages.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_PAGES_MEMBERS: readonly string[] = [
  'listOversizedPages', 'listScraperJunkCandidates', 'countMarkedPages', 'countOversizedCorePages', 'readRawProvenanceGaps',
  'countUnverifiedExtractions', 'listContentHashDuplicates', 'countTranscriptImportPages', 'countPageRows',
  'countPagesBySlugPrefix', 'countLivePages', 'readOldestPageCreatedAt', 'countPageTrustTiers', 'countPagesWithMentionLinks',
  'countImageModalityMismatches', 'readImagePageCoverage', 'listFactsPageBodies', 'listBracketPathPages', 'listSlugPathCandidates',
];
/** Every slug slugifyPath changes matches: a hyphen run or edge hyphen, an empty segment, any character outside a-z0-9/._- (a superset: a CJK slug matches and derives unchanged). */
export const SLUG_PATH_CANDIDATE_PATTERN = '[^a-z0-9/._-]|--|-/|/-|^-|-$|//';

export interface OversizedPageRow { slug: string; source_id: string; bytes: number }
export interface ScraperJunkRow { slug: string; source_id: string; title: string; body_head: string | null; tl_head: string; frontmatter: Record<string, unknown> | null }
export interface RawProvenanceGaps { count: number; slugs: string[] }
export interface ContentHashDuplicateRow { source_id: string; content_hash: string; slugs: string }
export interface TrustTierCount { tier: string | null; n: number }
export interface ImagePageCoverage { image_pages: number; without_image_vector: number; null_source_path: number }
export interface FactsPageBody { slug: string; source_id: string; segmented: boolean; body: string | null }
export interface BracketPathPage { slug: string; source_id: string; source_path: string }
export interface SlugPathCandidate { source_id: string; slug: string; source_path: string }
/** A frontmatter key doctor counts pages by. */
export type PageMarker = 'quarantine' | 'content_flag';

const OVERSIZED_PAGES_SQL = `SELECT p.slug, p.source_id,
              octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) AS bytes
       FROM pages p
       WHERE p.deleted_at IS NULL
         AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) > $1
       ORDER BY bytes DESC
       LIMIT 101`;

const SCRAPER_JUNK_LIMITED_SQL = `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            LIMIT $1`;

const SCRAPER_JUNK_ALL_SQL = `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL`;

const MARKED_PAGES_SQL: Readonly<Record<PageMarker, string>> = {
  quarantine: `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'quarantine'`,
  content_flag: `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'content_flag'`,
};

const OVERSIZED_CORE_PAGES_SQL = `SELECT COUNT(*)::int AS n FROM pages p
    WHERE p.deleted_at IS NULL AND p.frontmatter @> '{"always_load": true}'::jsonb AND p.body_storage = 'segmented' AND p.body_bytes > $1`;

const RAW_PROVENANCE_COUNT_SQL = `SELECT COUNT(*)::int AS n FROM pages p WHERE 
        p.deleted_at IS NULL
    AND (COALESCE(p.frontmatter->>'dream_generated', '') = 'true' OR p.type = 'synthesis')
    AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['raw_trace', 'raw_source', 'source_uri'])
    AND COALESCE(p.frontmatter->>'raw_trace_exempt', '') <> 'true'
    AND NOT (p.type = 'atom'
      AND COALESCE(p.frontmatter->>'extracted_by', '') LIKE 'extract\\_atoms%'
      AND COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['source_slug', 'source_path'])
    AND NOT EXISTS (SELECT 1 FROM raw_data rd WHERE rd.page_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM synthesis_evidence se WHERE se.synthesis_page_id = p.id)`;

const RAW_PROVENANCE_SAMPLE_SQL = `SELECT p.slug FROM pages p WHERE 
        p.deleted_at IS NULL
    AND (COALESCE(p.frontmatter->>'dream_generated', '') = 'true' OR p.type = 'synthesis')
    AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['raw_trace', 'raw_source', 'source_uri'])
    AND COALESCE(p.frontmatter->>'raw_trace_exempt', '') <> 'true'
    AND NOT (p.type = 'atom'
      AND COALESCE(p.frontmatter->>'extracted_by', '') LIKE 'extract\\_atoms%'
      AND COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['source_slug', 'source_path'])
    AND NOT EXISTS (SELECT 1 FROM raw_data rd WHERE rd.page_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM synthesis_evidence se WHERE se.synthesis_page_id = p.id) ORDER BY p.slug COLLATE "C" LIMIT 5`;

const UNVERIFIED_EXTRACTIONS_SQL = `SELECT COUNT(*)::int AS n FROM pages p
       WHERE p.deleted_at IS NULL
         AND (COALESCE(p.frontmatter, '{}'::jsonb) ->> 'provenance') = 'auto-extracted' AND (COALESCE(p.frontmatter, '{}'::jsonb) ->> 'status') = 'unverified'
         AND p.created_at < now() - ($1 || ' days')::interval
         `;

const UNVERIFIED_EXTRACTIONS_IN_SOURCE_SQL = `SELECT COUNT(*)::int AS n FROM pages p
       WHERE p.deleted_at IS NULL
         AND (COALESCE(p.frontmatter, '{}'::jsonb) ->> 'provenance') = 'auto-extracted' AND (COALESCE(p.frontmatter, '{}'::jsonb) ->> 'status') = 'unverified'
         AND p.created_at < now() - ($1 || ' days')::interval
         AND p.source_id = $2`;

const CONTENT_HASH_DUPLICATES_SQL = `SELECT source_id, content_hash,
              string_agg(slug, '|' ORDER BY length(slug), slug COLLATE "C") AS slugs
         FROM pages
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash <> ''
        GROUP BY source_id, content_hash
       HAVING count(*) > 1
        LIMIT 51`;

const TRANSCRIPT_IMPORT_PAGES_SQL = `SELECT count(*) AS n FROM pages WHERE type = 'conversation' AND deleted_at IS NULL AND frontmatter ? 'transcript_import'`;

const PAGE_ROWS_SQL = 'SELECT COUNT(*)::int AS n FROM pages';

const PAGES_BY_SLUG_PREFIX_SQL = `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE $1 ESCAPE '\\'`;

const LIVE_PAGES_SQL = 'SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL';

const OLDEST_PAGE_SQL = 'SELECT MIN(created_at) AS oldest FROM pages';

const PAGE_TRUST_TIERS_SQL = 'SELECT trust_tier AS tier, count(*) AS n FROM pages GROUP BY trust_tier';

const PAGES_WITH_MENTIONS_SQL = `SELECT COUNT(DISTINCT l.from_page_id)::int AS count
       FROM links l
       JOIN pages p ON p.id = l.from_page_id
      WHERE l.link_source = 'mentions'
        AND p.deleted_at IS NULL`;

// chunk-visibility-ok: moved from doctor/checks/data-integrity.ts unchanged; it audits every stored image-asset chunk row, staged included
const IMAGE_MODALITY_MISMATCH_SQL = `SELECT COUNT(*)::text AS count FROM content_chunks
       WHERE embedding_image IS NOT NULL
         AND chunk_source = 'image_asset'
         AND (modality IS NULL OR modality != 'image')`;

// chunk-visibility-ok: moved from doctor/checks/image-embedding-coverage.ts unchanged; image vectors live on image pages, which are never segmented (chooseBodyStorage)
const IMAGE_PAGE_COVERAGE_SQL = `SELECT count(*)::int AS image_pages,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL))::int AS without_image_vector,
         count(*) FILTER (WHERE p.source_path IS NULL)::int AS null_source_path
       FROM pages p WHERE p.page_kind = 'image' AND p.deleted_at IS NULL`;

const FACTS_PAGE_BODIES_SQL = `SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, left(coalesce(p.compiled_truth, p.truth_lead), 65536) AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`;

const BRACKET_PATH_PAGES_SQL = `SELECT slug, source_id, source_path FROM pages
          WHERE source_path IS NOT NULL AND deleted_at IS NULL
            AND (source_path LIKE '%[%' OR source_path LIKE '%]%'
                 OR source_path ~ '[[:cntrl:]]')`;

const SLUG_PATH_CANDIDATES_SQL = `SELECT p.source_id, p.slug, p.source_path FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
        WHERE p.deleted_at IS NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND p.slug ~ $1
        ORDER BY p.id LIMIT 20001`;

const SLUG_PATH_CANDIDATES_IN_SOURCES_SQL = `SELECT p.source_id, p.slug, p.source_path FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
        WHERE p.deleted_at IS NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND p.slug ~ $1 AND p.source_id = ANY($2::text[])
        ORDER BY p.id LIMIT 20001`;

/** Live pages without an `embed_skip` marker whose body and timeline together are over `minBytes`, largest first (at most 101). */
export async function listOversizedPages(raw: EngineRawRead, minBytes: number): Promise<OversizedPageRow[]> {
  return raw<OversizedPageRow>(OVERSIZED_PAGES_SQL, [minBytes]);
}

/** Live pages with their title, body and timeline heads and frontmatter, newest update first (`limit` of them), or all of them (`null`). */
export async function listScraperJunkCandidates(raw: EngineRawRead, limit: number | null): Promise<ScraperJunkRow[]> {
  return limit ? raw<ScraperJunkRow>(SCRAPER_JUNK_LIMITED_SQL, [limit]) : raw<ScraperJunkRow>(SCRAPER_JUNK_ALL_SQL);
}

/** Live pages whose frontmatter holds the key `marker`. */
export async function countMarkedPages(raw: EngineRawRead, marker: PageMarker): Promise<number> {
  const sql = MARKED_PAGES_SQL[marker];
  if (!sql) throw new Error(`countMarkedPages: '${String(marker)}' is not a page marker`);
  const [row] = await raw<{ n: string | number }>(sql);
  return Number(row?.n ?? 0);
}

/** Live `always_load` pages stored in segments with more than `maxBytes` body bytes. */
export async function countOversizedCorePages(raw: EngineRawRead, maxBytes: number): Promise<number> {
  const [row] = await raw<{ n: string | number }>(OVERSIZED_CORE_PAGES_SQL, [maxBytes]);
  return Number(row?.n ?? 0);
}

/** Synthesized pages with no raw trace, raw data or evidence and no exemption: their count and, when there are some, five slugs. */
export async function readRawProvenanceGaps(raw: EngineRawRead): Promise<RawProvenanceGaps> {
  const [row] = await raw<{ n: string | number }>(RAW_PROVENANCE_COUNT_SQL);
  const count = Number(row?.n ?? 0);
  if (count === 0) return { count, slugs: [] };
  const sample = await raw<{ slug: string }>(RAW_PROVENANCE_SAMPLE_SQL);
  return { count, slugs: sample.map((r) => r.slug) };
}

/** Live unverified auto-extracted pages created more than `days` days ago (in `sourceId` when given). */
export async function countUnverifiedExtractions(raw: EngineRawRead, days: number, sourceId: string | null): Promise<number> {
  const [row] = sourceId
    ? await raw<{ n: string | number }>(UNVERIFIED_EXTRACTIONS_IN_SOURCE_SQL, [String(days), sourceId])
    : await raw<{ n: string | number }>(UNVERIFIED_EXTRACTIONS_SQL, [String(days)]);
  return Number(row?.n ?? 0);
}

/** Groups of live pages sharing a content hash within a source (at most 51). */
export async function listContentHashDuplicates(raw: EngineRawRead): Promise<ContentHashDuplicateRow[]> {
  return raw<ContentHashDuplicateRow>(CONTENT_HASH_DUPLICATES_SQL);
}

/** Live conversation pages imported from a transcript. */
export async function countTranscriptImportPages(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: string | number }>(TRANSCRIPT_IMPORT_PAGES_SQL);
  return Number(row?.n ?? 0);
}

/** Every page row, soft-deleted pages included. */
export async function countPageRows(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: string | number }>(PAGE_ROWS_SQL);
  return Number(row?.n ?? 0);
}

/** Page rows (soft-deleted included) whose slug starts with `prefix`, the prefix taken literally. */
export async function countPagesBySlugPrefix(raw: EngineRawRead, prefix: string): Promise<number> {
  const [row] = await raw<{ n: string | number }>(PAGES_BY_SLUG_PREFIX_SQL, [`${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`]);
  return Number(row?.n ?? 0);
}

/** Live page rows. */
export async function countLivePages(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: string | number }>(LIVE_PAGES_SQL);
  return Number(row?.n ?? 0);
}

/** The earliest `created_at` of any page row (soft-deleted included), as the engine returns it, or null. */
export async function readOldestPageCreatedAt(raw: EngineRawRead): Promise<string | Date | null> {
  const [row] = await raw<{ oldest: string | Date | null }>(OLDEST_PAGE_SQL);
  return row?.oldest ?? null;
}

/** Page rows per stored `trust_tier`. */
export async function countPageTrustTiers(raw: EngineRawRead): Promise<TrustTierCount[]> {
  const rows = await raw<{ tier: string | null; n: string | number }>(PAGE_TRUST_TIERS_SQL);
  return rows.map((row) => ({ tier: row.tier, n: Number(row.n) }));
}

/** Live pages with at least one outgoing `mentions` link. */
export async function countPagesWithMentionLinks(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ count: string | number }>(PAGES_WITH_MENTIONS_SQL);
  return Number(row?.count ?? 0);
}

/** Image-asset chunks with an image vector whose modality is not `image`. */
export async function countImageModalityMismatches(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ count: string | number }>(IMAGE_MODALITY_MISMATCH_SQL);
  return parseInt(String(row?.count ?? '0'), 10);
}

/** Live image pages, those with no image vector and those with no recorded `source_path`. */
export async function readImagePageCoverage(raw: EngineRawRead): Promise<ImagePageCoverage> {
  const [row] = await raw<{ image_pages: number | string; without_image_vector: number | string; null_source_path: number | string }>(IMAGE_PAGE_COVERAGE_SQL);
  return { image_pages: Number(row?.image_pages ?? 0), without_image_vector: Number(row?.without_image_vector ?? 0), null_source_path: Number(row?.null_source_path ?? 0) };
}

/** Live `facts` pages in (source, slug) order with the bounded body prefix. */
export async function listFactsPageBodies(raw: EngineRawRead): Promise<FactsPageBody[]> {
  return raw<FactsPageBody>(FACTS_PAGE_BODIES_SQL);
}

/** Live pages whose `source_path` has a bracket or a control character. */
export async function listBracketPathPages(raw: EngineRawRead): Promise<BracketPathPage[]> {
  return raw<BracketPathPage>(BRACKET_PATH_PAGES_SQL);
}

/** Live pages of an unarchived source whose slug matches the slug-change pattern (in `sourceIds` when given), in id order. */
export async function listSlugPathCandidates(raw: EngineRawRead, sourceIds: string[] | null): Promise<SlugPathCandidate[]> {
  return sourceIds
    ? raw<SlugPathCandidate>(SLUG_PATH_CANDIDATES_IN_SOURCES_SQL, [SLUG_PATH_CANDIDATE_PATTERN, sourceIds])
    : raw<SlugPathCandidate>(SLUG_PATH_CANDIDATES_SQL, [SLUG_PATH_CANDIDATE_PATTERN]);
}
