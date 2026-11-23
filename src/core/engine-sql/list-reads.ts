/**
 * The page-list, slug-source, access and storage-shelf reads their callers ran through `executeRaw`. Each function keeps
 * the statement text its call site ran, byte for byte, so PGLite and Postgres answer exactly as before; a Rust brain
 * answers from its store (rust/docs/store/list-reads.md). Every read runs through the engine's own executeRaw
 * (`EngineRawRead`), as its caller did, so a statement fault, a request abort and a read deadline reach it as before.
 */
import type { PageReadPolicy, PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { accessAllowedSql, folderRulesAllowedSql, privatePagesFilterFragmentFast } from '../search/private-visibility.ts';
import { ownerOnlyPageSql, type OwnerOnlyForm } from '../access/owner-only.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { LIVE_STAGING_STATES } from './page-body.ts';

/** Filters on a storage-shelf card's frontmatter (storage-manifest/find.ts). */
export interface CardFilters { store?: string; status?: string; onSourceMachine?: boolean }
/** A storage-shelf card as `CARD_COLUMNS` selects it. */
export interface CardRow { id: string; title: string; status: string | null; kind: string | null; stores: string[]; original_path: string | null; on_source_machine: boolean | null; updated_at: string }
/** The shelf query of `listCards`: the shelf source and card type, the card filters, the read policy and the page. */
export interface CardListQuery { sourceId: string; type: string; filters: CardFilters; policy?: PageReadScope; limit: number; offset: number }
/** A shelf page as `readShelfCards` reads it. */
export interface ShelfPageRow { slug: string; title: string; type: string | null; frontmatter: unknown }

/** Filters on the card's frontmatter, appended to `where` with bound params. */
export function cardFilterSql(alias: string, filters: CardFilters, params: unknown[]): string {
  const clauses: string[] = [];
  if (filters.status) { params.push(filters.status); clauses.push(`${alias}.frontmatter->'storage'->>'status' = $${params.length}`); }
  if (filters.store) { params.push(filters.store); clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.frontmatter->'storage'->'locations') = 'array' THEN ${alias}.frontmatter->'storage'->'locations' ELSE '[]'::jsonb END) loc WHERE loc->>'store' = $${params.length})`); }
  if (filters.onSourceMachine !== undefined) { params.push(String(filters.onSourceMachine)); clauses.push(`${alias}.frontmatter->'storage'->>'on_source_machine' = $${params.length}`); }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

export const CARD_COLUMNS = `p.slug AS id, p.title, p.frontmatter->'storage'->>'status' AS status, p.frontmatter->'storage'->>'kind' AS kind,
  COALESCE((SELECT array_agg(DISTINCT loc->>'store') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.frontmatter->'storage'->'locations') = 'array' THEN p.frontmatter->'storage'->'locations' ELSE '[]'::jsonb END) loc), ARRAY[]::text[]) AS stores,
  p.frontmatter->'storage'->>'original_path' AS original_path,
  CASE p.frontmatter->'storage'->>'on_source_machine' WHEN 'true' THEN true WHEN 'false' THEN false END AS on_source_machine,
  p.updated_at::text AS updated_at`;

/** A link's two pages by slug and title (`readCompanyBrainEvidenceRows`). */
export interface EvidenceLinkRow { from_slug: string; from_title: string; to_slug: string; to_title: string }

/** The three picks of the company-brain evidence read, each a row or null. */
export interface CompanyBrainEvidenceRows { owner: EvidenceLinkRow | null; decision: EvidenceLinkRow | null; page: { slug: string; title: string } | null }

/** One retype-rule probe (schema-pack/retype.ts probeRule): the rule's type, its optional `LIKE` filters and source. */
export interface RetypeProbeQuery { fromType: string; pathFilter?: string; slugFilter?: string; sourceId?: string }
/** A page's slug, body and frontmatter as the schema-pack page rules read them. */
export interface PageBodyRow { slug: string; compiled_truth: string; frontmatter: Record<string, unknown> | string | null }
/** A source scope: `sourceIds` when not empty, else `sourceId`, else every source. */
export interface SourceIdScope { sourceId?: string; sourceIds?: string[] }

/** A scanned page of the stale-mention scan (by-mention.ts scanStaleMentions). */
export interface MentionScanPageRow { id: number; slug: string; source_id: string | null; body: string; title: string | null; body_storage: string | null }
/** A mention link from a scanned page. */
export interface MentionScanLinkRow { from_id: number; from_slug: string; to_slug: string; to_source_id: string | null; link_kind: string | null; link_type: string }

/** One page of the attendance-repair scan window (`PAGE_PIN_SQL` of attendance-repair.ts, plus `deleted`). */
export interface AttendanceWindowRow { id: string; slug: string; source_id: string; type: string; revision: string; deleted: boolean }

/** A page id and its source (`resolveChainAnchorRows`). */
export interface PageSourceIdRow { id: number; source_id: string }

/** One readable live copy of a slug as `explain_target` probes it, counts as the driver returns them (`probeTargetRows`). */
export interface TargetProbeSqlRow { source_id: string; chunks: number; embedded: number; current: boolean; chunker_version: number | null }

/**
 * The sources holding a live page at `slug`, by id in byte order: the ambiguity check of a page ref with no source
 * (trust/refs.ts resolvePageRef), `gbrain quarantine clear` and `extract-conversation-facts --grammar`.
 */
export async function listLiveSlugSourceIds(raw: EngineRawRead, slug: string): Promise<string[]> {
  const rows = await raw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id COLLATE "C"', [slug]);
  return rows.map(r => r.source_id);
}

/** Every live copy of `slug` the read policy admits, by source id (search/relational-chain.ts resolveChainAnchors). */
export async function resolveChainAnchorRows(raw: EngineRawRead, slug: string, policy: PageReadPolicy): Promise<PageSourceIdRow[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  return raw<PageSourceIdRow>(
    `SELECT p.id, p.source_id FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id COLLATE "C"`, params);
}

/**
 * Every readable live copy of `slug` under the caller's policy, with its live-body chunk and vector counts, whether its
 * text projection is current, and its chunker version, by source id (search/explain-target.ts probeTarget).
 */
export async function probeTargetRows(raw: EngineRawRead, slug: string, policy: PageReadPolicy, chunkManifest = true): Promise<TargetProbeSqlRow[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  return raw<TargetProbeSqlRow>(
    `SELECT p.source_id,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc', chunkManifest)}) AS chunks,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND cc.embedding IS NOT NULL AND ${chunkGenerationFilter('p', 'cc', chunkManifest)}) AS embedded,
       ((p.text_projection_revision = p.knowledge_revision) IS TRUE) AS current,
       p.chunker_version
     FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id COLLATE "C"`, params);
}

/**
 * The company-brain evidence picks of a source (company-brain/evidence.ts): the first ownership link (a customer page
 * first), the first decision supersession, and the first live page, each by slug in byte order.
 */
export async function readCompanyBrainEvidenceRows(raw: EngineRawRead, sourceId: string): Promise<CompanyBrainEvidenceRows> {
  const [owner] = await raw<EvidenceLinkRow>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND l.link_type='owned_by' AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY CASE WHEN f.type='customer' THEN 0 ELSE 1 END,f.slug COLLATE "C",t.slug COLLATE "C" LIMIT 1`, [sourceId]);
  const [decision] = await raw<EvidenceLinkRow>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND f.type='decision' AND t.type='decision' AND l.link_type='supersedes'
       AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY f.slug COLLATE "C",t.slug COLLATE "C" LIMIT 1`, [sourceId]);
  const [page] = await raw<{ slug: string; title: string }>(
    'SELECT slug,title FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug COLLATE "C" LIMIT 1', [sourceId]);
  return { owner: owner ?? null, decision: decision ?? null, page: page ?? null };
}

/** The shelf's card count and one page of its cards, by slug in byte order (storage-manifest/find.ts listCards). */
export async function listCardRows(raw: EngineRawRead, query: CardListQuery): Promise<{ total: number; cards: CardRow[] }> {
  const params: unknown[] = [query.sourceId, query.type];
  const where = `p.source_id = $1 AND p.type = $2 AND ${pageReadFilter('p', query.policy, params, true)}${cardFilterSql('p', query.filters, params)}`;
  const [{ n }] = await raw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE ${where}`, params) as [{ n: number }];
  params.push(query.limit, query.offset);
  const cards = await raw<CardRow>(`SELECT ${CARD_COLUMNS} FROM pages p WHERE ${where} ORDER BY p.slug COLLATE "C" LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { total: Number(n), cards };
}

/** Every live page of the shelf source, by slug in byte order (storage-manifest/find.ts readShelfCards). */
export async function readShelfPageRows(raw: EngineRawRead, sourceId: string): Promise<ShelfPageRow[]> {
  return raw<ShelfPageRow>(
    'SELECT p.slug, p.title, p.type, p.frontmatter FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL ORDER BY p.slug COLLATE "C"', [sourceId]);
}

/** The slug of the first live page, by (source, slug) in byte order, that records `path` as its file (sync-git.ts). */
export async function readFirstLiveSlugAtPath(raw: EngineRawRead, path: string): Promise<string | null> {
  const rows = await raw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL
            ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 1`,
    [path],
  );
  return rows.length > 0 && rows[0]!.slug ? rows[0]!.slug : null;
}

/** Each of `paths` more than one live page of the source records, with their slugs in byte order (sync-git.ts). */
export async function listPathTwinSlugs(raw: EngineRawRead, sourceId: string, paths: readonly string[]): Promise<Array<{ source_path: string; slugs: string[] }>> {
  return raw<{ source_path: string; slugs: string[] }>(`SELECT source_path, array_agg(slug ORDER BY slug COLLATE "C") AS slugs FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND source_path = ANY($2::text[]) GROUP BY source_path HAVING count(*) > 1`, [sourceId, [...paths]]);
}

/** Every live page at one of `slugs` (in the source when given) with its recorded file, by (source, slug) in byte order (sync-git.ts). */
export async function listLiveSlugOrigins(raw: EngineRawRead, slugs: readonly string[], sourceId?: string): Promise<Array<{ slug: string; source_path: string | null }>> {
  const params: unknown[] = [...slugs];
  const placeholders = slugs.map((_, j) => `$${j + 1}`).join(', ');
  let where = `slug IN (${placeholders}) AND deleted_at IS NULL`;
  if (sourceId !== undefined) {
    params.push(sourceId);
    where += ` AND source_id = $${params.length}`;
  }
  return raw<{ slug: string; source_path: string | null }>(
    `SELECT slug, source_path FROM pages WHERE ${where} ORDER BY source_id COLLATE "C", slug COLLATE "C"`,
    params,
  );
}

/** How many live pages a retype rule matches and its first ten slugs by byte, none when it matches nothing (schema-pack/retype.ts). */
export async function probeRetypeRows(raw: EngineRawRead, query: RetypeProbeQuery): Promise<{ count: number; sample: string[] }> {
  const { fromType, pathFilter, slugFilter, sourceId } = query;
  let where = `WHERE deleted_at IS NULL AND type = $1`;
  const params: unknown[] = [fromType];
  if (pathFilter) {
    where += ` AND source_path LIKE $${params.length + 1}`;
    params.push(pathFilter);
  }
  if (slugFilter) {
    where += ` AND slug LIKE $${params.length + 1}`;
    params.push(slugFilter);
  }
  if (sourceId) {
    where += ` AND source_id = $${params.length + 1}`;
    params.push(sourceId);
  }
  const cntRows = await raw<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM pages ${where}`,
    params,
  );
  const count = parseInt(cntRows[0]?.cnt ?? '0', 10) || 0;
  if (count === 0) return { count: 0, sample: [] };
  const sampleRows = await raw<{ slug: string }>(
    `SELECT slug FROM pages ${where} ORDER BY slug COLLATE "C" LIMIT 10`,
    params,
  );
  return { count, sample: sampleRows.map((r) => r.slug) };
}

/** The live pages of a type in a source, by slug in byte order, at most `limit` (schema-pack/page-to-alias.ts). */
export async function listAliasCandidatePages(raw: EngineRawRead, type: string, sourceId: string, limit: number): Promise<PageBodyRow[]> {
  const where = `WHERE deleted_at IS NULL AND type = $1 AND source_id = $2`;
  return raw<PageBodyRow>(
    `SELECT slug, compiled_truth, frontmatter FROM pages ${where} ORDER BY slug COLLATE "C" LIMIT ${limitText(limit)}`,
    [type, sourceId],
  );
}

/** The live pages of a type (in the source when given), by slug in byte order then id, at most `limit` (schema-pack/page-to-link.ts). */
export async function listLinkCandidatePages(raw: EngineRawRead, type: string, sourceId: string | undefined, limit: number): Promise<PageBodyRow[]> {
  const where = sourceId
    ? `WHERE deleted_at IS NULL AND type = $1 AND source_id = $2`
    : `WHERE deleted_at IS NULL AND type = $1`;
  const params: unknown[] = [type];
  if (sourceId) params.push(sourceId);
  return raw<PageBodyRow>(
    `SELECT slug, compiled_truth, frontmatter FROM pages ${where} ORDER BY slug COLLATE "C", id LIMIT ${limitText(limit)}`,
    params,
  );
}

/** A row limit spliced into a statement: a whole number only. */
function limitText(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`list reads: bad row limit ${limit}`);
  return limit;
}

/** The `WHERE` of the type-orphan reads (schema-pack/review.ts findTypeOrphans): live pages in the source scope. */
function orphanWhere(scope: SourceIdScope, params: unknown[]): string {
  let where = 'deleted_at IS NULL';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    where += ` AND source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    where += ` AND source_id = $${params.length}`;
  }
  return where;
}

/** Each stored type of the live pages in scope with its count as text (schema-pack/review.ts findTypeOrphans). */
export async function countLivePagesByType(raw: EngineRawRead, scope: SourceIdScope): Promise<Array<{ type: string | null; n: string }>> {
  const params: unknown[] = [];
  const where = orphanWhere(scope, params);
  return raw<{ type: string | null; n: string }>(
    `SELECT type, count(*)::text AS n FROM pages WHERE ${where} GROUP BY type`,
    params,
  );
}

/** The live pages in scope with no type or an undeclared one, by (source, slug) in byte order, at most `limit` (findTypeOrphans). */
export async function listTypeOrphanRows(raw: EngineRawRead, scope: SourceIdScope, undeclared: readonly string[], limit: number): Promise<Array<{ slug: string; source_id: string; type: string | null }>> {
  const params: unknown[] = [];
  const where = orphanWhere(scope, params);
  return raw<{ slug: string; source_id: string; type: string | null }>(
    `SELECT slug, COALESCE(source_id, 'default') AS source_id, type FROM pages
      WHERE ${where} AND (type IS NULL OR type = '' OR type = ANY($${params.length + 1}::text[]))
      ORDER BY source_id COLLATE "C", slug COLLATE "C"
      LIMIT ${limitText(limit)}`,
    [...params, [...undeclared]],
  );
}

/**
 * The stale-mention scan's two reads over one bounded page set (by-mention.ts scanStaleMentions): the first `limit` live
 * pages holding a mention link, by slug in byte order then id, with their joined text, and every mention link from them.
 */
export async function readStaleMentionScan(raw: EngineRawRead, limit: number): Promise<{ pages: MentionScanPageRow[]; links: MentionScanLinkRow[] }> {
  // Same bounded page set for both queries so the link rows and the bodies
  // can never describe different pages.
  const scannedCte =
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug COLLATE "C", p.id
        LIMIT $1
     )`;

  const pages = await raw<MentionScanPageRow>(
    `${scannedCte}
     SELECT p.id, p.slug, p.source_id, p.title, p.body_storage,
            COALESCE(p.title, '') || E'\n\n' || COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
       FROM pages p
       JOIN scanned s ON s.id = p.id
      ORDER BY p.slug COLLATE "C", p.id`,
    [limit],
  );

  const links = await raw<MentionScanLinkRow>(
    `${scannedCte}
     SELECT l.from_page_id AS from_id, f.slug AS from_slug,
            t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind, l.link_type
       FROM links l
       JOIN scanned s ON s.id = l.from_page_id
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions'
      ORDER BY f.slug COLLATE "C", t.slug COLLATE "C"`,
    [limit],
  );
  return { pages, links };
}

/** The database clock (`clock_timestamp()`) in whole milliseconds since the epoch, as text (attendance-repair.ts issuedAt). */
export async function readClockMillisText(raw: EngineRawRead): Promise<string> {
  const [{ issued_at }] = await raw<{ issued_at: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS issued_at') as [{ issued_at: string }];
  return issued_at;
}

/** The listed sources that are not archived and carry no archive time, with their incarnations, in no set order (attendance-repair.ts). */
export async function listLiveSourceIncarnations(raw: EngineRawRead, ids: readonly string[]): Promise<Array<{ id: string; incarnation: string }>> {
  return raw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation FROM sources WHERE id=ANY($1::text[]) AND archived IS NOT TRUE AND archived_at IS NULL', [[...ids]]);
}

/** The attendance-repair page pin columns (attendance-repair.ts PAGE_PIN_SQL). */
export const PAGE_PIN_SQL = 'id::text, slug, source_id, type, knowledge_revision::text AS revision';

/** The source's pages after `afterSlug` in byte order, soft-deleted ones marked, at most `limit` (attendance-repair.ts scan window). */
export async function readAttendanceWindow(raw: EngineRawRead, sourceId: string, afterSlug: string, limit: number): Promise<AttendanceWindowRow[]> {
  return raw<AttendanceWindowRow>(`SELECT ${PAGE_PIN_SQL}, deleted_at IS NOT NULL AS deleted
    FROM pages WHERE source_id=$1 AND slug COLLATE "C">$2 ORDER BY slug COLLATE "C" LIMIT $3`, [sourceId, afterSlug, limit]);
}

/** Up to two distinct live pages in another source that carry `aliasNorm` as a page alias (google/counterparty.ts emailAliasElsewhere). */
export async function listEmailAliasPages(raw: EngineRawRead, aliasNorm: string, sourceId: string): Promise<Array<{ slug: string; source_id: string }>> {
  return raw<{ slug: string; source_id: string }>(
    `SELECT DISTINCT pa.slug, pa.source_id
         FROM page_aliases pa
         JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id AND p.deleted_at IS NULL
        WHERE pa.alias_norm = $1 AND pa.source_id <> $2
        LIMIT 2`,
    [aliasNorm, sourceId],
  );
}

// The upload session reads of persistence/page-upload.ts (begin_page_upload and the upload ops).
export const UPLOAD_LIVE_SQL = `'{${LIVE_STAGING_STATES.join(',')}}'::text[]`;
/** The session `s` is named by an unfinished write (its staged body is a GC root until that write ends). */
export const UPLOAD_REQUEST_HELD_SQL = `EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state IN ('queued','deferred','running','recovering')
      AND r.intent->'body_ref'->>'staging_id' = s.id::text)`;
/**
 * The session `s` expires: an open session past either deadline, a sealed (committing) one only past its hard deadline,
 * which sealing extends by one idle period; never one an unfinished write names. A commit in progress is never expired.
 */
export const UPLOAD_LAPSED_SQL = `(s.state = ANY(${UPLOAD_LIVE_SQL}) AND (s.hard_expires_at <= now() OR s.state = 'open' AND s.idle_expires_at <= now()) AND NOT ${UPLOAD_REQUEST_HELD_SQL})`;
/** The upload session columns persistence/page-upload.ts reads, with the source's current incarnation and the page now at the slug. */
export const UPLOAD_SELECT = `SELECT s.id::text AS id, s.principal_kind, s.principal_id, s.client_request_id::text AS client_request_id, s.source_id,
    s.source_incarnation::text AS source_incarnation, s.slug, s.page_id, s.mode, s.base_revision::text AS base_revision, s.base_generation,
    s.declared_bytes, encode(s.declared_sha256, 'hex') AS declared_sha256, s.received_bytes, s.next_part, s.reserved_bytes, s.state,
    s.commit_request_id::text AS commit_request_id, s.idle_expires_at, s.hard_expires_at, ${UPLOAD_LAPSED_SQL} AS lapsed,
    src.incarnation::text AS current_incarnation, src.archived AS source_archived, p.id AS current_page_id
  FROM page_body_stagings s LEFT JOIN sources src ON src.id = s.source_id LEFT JOIN pages p ON p.source_id = s.source_id AND p.slug = s.slug`;

/** The upload session a principal began under a client request id, as raw columns, or null (persistence/page-upload.ts). */
export async function readUploadSessionByRequest(raw: EngineRawRead, principalKind: string, principalId: string, clientRequestId: string): Promise<Record<string, unknown> | null> {
  const [row] = await raw<Record<string, unknown>>(`${UPLOAD_SELECT}
    WHERE s.principal_kind = $1 AND s.principal_id = $2 AND s.client_request_id = $3::uuid AND s.kind = 'upload'`, [principalKind, principalId, clientRequestId]);
  return row ?? null;
}

/** A source's incarnation as text and its archive flag, or null (ops/page-upload.ts begin_page_upload). */
export async function readSourceIncarnationArchived(raw: EngineRawRead, sourceId: string): Promise<{ incarnation: string; archived: boolean } | null> {
  const [source] = await raw<{ incarnation: string; archived: boolean }>('SELECT incarnation::text AS incarnation, archived FROM sources WHERE id=$1', [sourceId]);
  return source ?? null;
}

/** The enabled labelled-only members, by id in byte order (access/labelled-only.ts labelledOnlyMemberIds). */
export async function listEnabledLabelledOnlyMemberIds(raw: EngineRawRead): Promise<string[]> {
  const rows = await raw<{ id: string }>(
    'SELECT id FROM access_members WHERE labelled_only AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE "C"');
  return rows.map(r => r.id);
}

/** One source's chat page count and distinct channel count (grants/shared-exposure.ts chatChannelCensus). */
export interface ChatCensusRow { source_id: string; chat_pages: number | string; channels: number | string }

/**
 * Per source among `sourceIds`, its live chat pages (types `chatTypes`; a `dmTypes` page is its own channel) that the
 * private-page rule admits when `hidePrivate`, and their distinct channels, by source id in byte order (chatChannelCensus).
 */
export async function readChatCensusRows(raw: EngineRawRead, sourceIds: readonly string[], chatTypes: readonly string[], dmTypes: readonly string[], hidePrivate: boolean): Promise<ChatCensusRow[]> {
  return raw<ChatCensusRow>(
    `SELECT p.source_id, count(*) AS chat_pages,
            count(DISTINCT CASE WHEN p.type = ANY($3::text[]) THEN 'dm:' || p.slug
              ELSE COALESCE(NULLIF(p.frontmatter->>'channel', ''), NULLIF(p.frontmatter->>'chat', ''), NULLIF(p.frontmatter->>'conversation', ''),
                lower(substring(p.title from '^#([A-Za-z0-9._-]+)')), '') END) AS channels
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.type = ANY($1::text[]) AND p.source_id = ANY($2::text[])
        ${hidePrivate ? `AND ${privatePagesFilterFragmentFast('p')}` : ''}
      GROUP BY p.source_id ORDER BY p.source_id COLLATE "C"`,
    [[...chatTypes], [...sourceIds], [...dmTypes]],
  );
}

/** One page `whoCanRead` reports on (commands/access.ts). */
export interface WhoCanReadRow { slug: string; source_id: string; type: string | null; frontmatter: unknown; folder_rule_ids: string[] | null; owner_only: boolean }

/**
 * Every page at `slug` (in `sourceId` when given), by source id in byte order, with whether it is in or derived from an
 * owner-only source by the owner-only test of `form` (commands/access.ts whoCanRead).
 */
export async function readWhoCanReadRows(raw: EngineRawRead, slug: string, sourceId: string | undefined, form: OwnerOnlyForm): Promise<WhoCanReadRow[]> {
  return raw<WhoCanReadRow>(
    `SELECT p.slug, p.source_id, p.type, p.frontmatter, p.folder_rule_ids, ${ownerOnlyPageSql('p', form)} AS owner_only
       FROM pages p WHERE p.slug = $1${sourceId ? ' AND p.source_id = $2' : ''} ORDER BY p.source_id COLLATE "C"`,
    sourceId ? [slug, sourceId] : [slug]);
}

/** Whether the member-access rule for `identity` (`accessAllowedSql`, under the current caller record) admits the page (whoCanRead). */
export async function readPageAccessAllowed(raw: EngineRawRead, sourceId: string, slug: string, identity: readonly string[]): Promise<boolean> {
  const admitted = await raw(
    `SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${accessAllowedSql('p', identity)}`, [sourceId, slug]);
  return admitted.length > 0;
}

/** Whether the folder rules of the page are all in `satisfied` (`folderRulesAllowedSql`, under the current caller record) (whoCanRead). */
export async function readPageFolderRulesAllowed(raw: EngineRawRead, sourceId: string, slug: string, satisfied: readonly string[]): Promise<boolean> {
  const admitted = await raw(
    `SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${folderRulesAllowedSql('p', satisfied)}`, [sourceId, slug]);
  return admitted.length > 0;
}

/** How many of a page's folder rule ids are not a raw-only rule (covers_derived false) of the source (whoCanRead). */
export async function countLineageClosingRules(raw: EngineRawRead, ruleIds: readonly string[], sourceId: string): Promise<number> {
  const rows = await raw<{ n: number }>(
    `SELECT count(*)::int AS n FROM unnest($1::text[]) AS x WHERE NOT EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id = $2 AND x = $2 || ':' || r.rule_id AND NOT r.covers_derived)`,
    [[...ruleIds], sourceId]);
  return Number(rows[0]?.n ?? 0);
}

/** The completed keys of one op checkpoint row (the connector DB cursor of connectors/db-cursor.ts), or null when none. */
export async function readOpCheckpointCompletedKeys(raw: EngineRawRead, op: string, fingerprint: string): Promise<unknown[] | null> {
  const [row] = await raw<{ completed_keys: unknown[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [op, fingerprint]);
  return row ? row.completed_keys : null;
}
