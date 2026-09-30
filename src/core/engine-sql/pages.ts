/**
 * Pages: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/pages.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md, "pages").
 *
 * The engines keep page-state orchestration: `putPage`'s transaction,
 * page-key lock and revision check, `updateSlug` / `setPageAliases`'
 * transactions, and `getPage` / `readPageSnapshot` (SQL in
 * `page-state/snapshot.ts`). Reads that ran inside `withScopedReadTransaction`
 * on master take `ScopedRead` (or a `ScopedReadRunner` when an early return
 * must stay outside the transaction); every other read takes
 * `LegacyUnscopedRead` (EO4 inventory).
 */
import type { BrainEngine } from '../engine.ts';
import type { DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow } from '../types.ts';
import type { Page, PageInput, PageFilters, PageVersion, StalePageRow } from '../types.ts';
import { PAGE_SORT_SQL } from '../types.ts';
import type { PageWriteOptions } from '../page-state/types.ts';
import { moveSlugBindings, recordRenameAlias } from '../page-state/rename-alias.ts';
import { sanitizeText } from '../batch-rows.ts';
import { SAFE_FENCE_CHUNKER_VERSION, bodyWriteChunkVersion } from '../search/safe-chunks.ts';
import { privatePagesFilterFragment, privateSnapshotFilterFragment } from '../search/private-visibility.ts';
import { validateSlug, contentHash, isBlankBody, rowToPage, rowToStalePage, isUndefinedTableError, warnOncePerProcess } from '../utils.ts';
import { DELETE_BATCH_SIZE } from '../engine-constants.ts';
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead, ScopedRead } from './brands.ts';
import type { ScopedReadRunner } from './cjk-search.ts';
import { compileRowNormalizer } from './normalize.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/**
 * PGLite can return zero rows from `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` in no-op/trigger edge cases; its engine passes a re-read here.
 * Postgres passes none (it always returns the row).
 */
export type RereadPage = (slug: string, sourceId: string) => Promise<Page | null>;

export async function findDuplicatePage(
  exec: ScopedRead,
  sourceId: string,
  opts: { hash: string; frontmatterId?: string | null; excludeSlug?: string },
): Promise<{ slug: string; id: number } | null> {
    const fmId = opts.frontmatterId ?? null;
    const excludeSlug = opts.excludeSlug ?? null;
      const { rows } = await exec.run<{ id: number | string; slug: string }>(sqlFragment`
        SELECT id, slug FROM pages
        WHERE source_id = ${sourceId}
          AND deleted_at IS NULL
          AND (content_hash = ${opts.hash} OR (frontmatter->>'id' = ${fmId} AND ${fmId}::text IS NOT NULL))
          AND (${excludeSlug}::text IS NULL OR slug <> ${excludeSlug})
        ORDER BY (frontmatter->>'id' IS NOT DISTINCT FROM ${fmId}::text) DESC, id
        LIMIT 1
      `);
      if (rows.length === 0) return null;
      const r = rows[0];
      return { slug: r.slug, id: Number(r.id) };
  }

export async function putPage(
  exec: SqlExecutor,
  slug: string,
  page: PageInput,
  opts?: PageWriteOptions,
  rereadOnEmptyReturning?: RereadPage,
): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};
    const sourceId = opts?.sourceId ?? 'default';

    // Data-loss guard: a page edit is a read-modify-write; if the read returned
    // empty, the modify lands on nothing and this upsert would blank the body
    // over real content (ON CONFLICT sets compiled_truth = EXCLUDED.* flat).
    // Only fires when the incoming body is itself blank, so the common
    // non-empty write pays no extra query. Deletes use deletePage; a deliberate
    // clear passes allowEmptyOverwrite. See isBlankBody.
    if (isBlankBody(page.compiled_truth) && !opts?.allowEmptyOverwrite) {
      const { rows: prior } = await exec.run<{ compiled_truth: string | null }>(sqlFragment`
        SELECT compiled_truth FROM pages
        WHERE source_id = ${sourceId} AND slug = ${slug} AND deleted_at IS NULL
        LIMIT 1`);
      if (prior[0] && !isBlankBody(prior[0].compiled_truth)) {
        throw new Error(
          `putPage: refusing to overwrite non-empty page '${slug}' ` +
            `(${prior[0].compiled_truth!.length} chars) with an empty body — ` +
            `likely a read-modify-write that read empty. Pass ` +
            `{ allowEmptyOverwrite: true } to force, or deletePage to remove it.`,
        );
      }
    }

    // v0.18.0 Step 5+: source_id is in the INSERT column list so multi-source
    // callers land on the (source_id, slug) row they intend; omitting it let
    // the schema DEFAULT 'default' fabricate a duplicate at (default, slug).
    // ON CONFLICT target is (source_id, slug); global UNIQUE(slug) dropped in v17.
    const pageKind = page.page_kind || 'markdown';
    // v0.29.1 — effective_date / effective_date_source / import_filename are
    // additive opt-in inputs from the importer (computeEffectiveDate). When
    // omitted, the ON CONFLICT path preserves any existing value via
    // COALESCE(EXCLUDED.x, pages.x) so a putPage that doesn't know about
    // these columns (auto-link, code reindex, etc.) doesn't blank them out.
    const effectiveDate = page.effective_date ?? null;
    const effectiveDateSource = page.effective_date_source ?? null;
    const importFilename = page.import_filename ?? null;
    // v0.32.7 CJK wave: chunker_version + source_path columns.
    // Only an import transaction may seal a fully sanitized chunk replacement.
    const chunkerVersion = Math.min(page.chunker_version ?? 0, SAFE_FENCE_CHUNKER_VERSION - 1);
    const sourcePath = page.source_path ?? null;
    // v0.39.3.0 provenance write-through (WARN-8 + CV12). Server stamps
    // `ingested_at = now()` ONLY when any provenance is being written —
    // null `source_kind` / `source_uri` / `ingested_via` means no provenance
    // write fired this call, and COALESCE-preserve UPDATE keeps the prior
    // first-write timestamp intact (audit trail survives routine edits).
    const sourceKind = page.source_kind ?? null;
    const sourceUri = page.source_uri ?? null;
    const ingestedVia = page.ingested_via ?? null;
    const ingestedAt = (sourceKind || sourceUri || ingestedVia) ? new Date() : null;
    const { rows } = await exec.run(sqlFragment`
      INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at, effective_date, effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at)
      VALUES (${sourceId}, ${slug}, ${page.type}, ${pageKind}, ${sanitizeText(page.title)}, ${sanitizeText(page.compiled_truth)}, ${sanitizeText(page.timeline || '')}, ${jsonbParam(frontmatter)}, ${hash}, now(), ${effectiveDate}, ${effectiveDateSource}, ${importFilename}, ${chunkerVersion}::smallint, ${sourcePath}, ${sourceKind}, ${sourceUri}, ${ingestedVia}, ${ingestedAt})
      ON CONFLICT (source_id, slug) DO UPDATE SET
        type = EXCLUDED.type,
        page_kind = EXCLUDED.page_kind,
        title = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        timeline = EXCLUDED.timeline,
        frontmatter = EXCLUDED.frontmatter,
        content_hash = EXCLUDED.content_hash,
        updated_at = now(),
        deleted_at = NULL,
        effective_date        = COALESCE(EXCLUDED.effective_date,        pages.effective_date),
        effective_date_source = COALESCE(EXCLUDED.effective_date_source, pages.effective_date_source),
        import_filename       = COALESCE(EXCLUDED.import_filename,       pages.import_filename),
        chunker_version       = ${trustedSql(bodyWriteChunkVersion('EXCLUDED.compiled_truth', 'EXCLUDED.timeline'))},
        source_path           = COALESCE(EXCLUDED.source_path,           pages.source_path),
        source_kind           = COALESCE(EXCLUDED.source_kind,           pages.source_kind),
        source_uri            = COALESCE(EXCLUDED.source_uri,            pages.source_uri),
        ingested_via          = COALESCE(EXCLUDED.ingested_via,          pages.ingested_via),
        ingested_at           = COALESCE(EXCLUDED.ingested_at,           pages.ingested_at)
      RETURNING knowledge_revision, text_projection_revision, id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, effective_date, effective_date_source, import_filename, source_kind, source_uri, ingested_via, ingested_at
    `);
    if (rows.length === 0 && rereadOnEmptyReturning) {
      // The row WAS written; re-read instead of crashing in rowToPage(undefined).
      const reread = await rereadOnEmptyReturning(slug, sourceId);
      if (reread) return reread;
      throw new Error(`putPage: RETURNING produced no row for ${sourceId}/${slug}`);
    }
    return rowToPage(rows[0]);
  }

export async function deletePage(exec: SqlExecutor, slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    await exec.run(sqlFragment`DELETE FROM pages WHERE slug = ${slug} AND source_id = ${sourceId}`);
  }

/**
 * v0.41.19.0 — batch delete primitive. See BrainEngine.deletePages JSDoc.
 * Single SQL round-trip per call; caller is responsible for chunking input
 * to <= DELETE_BATCH_SIZE. RETURNING slug projects the actually-deleted set
 * so the caller can filter pagesAffected.
 */
export async function deletePages(exec: SqlExecutor, slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `deletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const { rows } = await exec.run<{ slug: string }>(sqlFragment`
      DELETE FROM pages
       WHERE slug = ANY(${slugs}::text[]) AND source_id = ${opts.sourceId}
      RETURNING slug
    `);
    return rows.map(r => r.slug);
  }

/**
 * v0.41.19.0 — batch path → slug resolution. See BrainEngine.resolveSlugsByPaths
 * JSDoc. Single SQL round-trip; folds rows into a Map.
 */
export async function resolveSlugsByPaths(
  exec: LegacyUnscopedRead,
  paths: string[],
  opts: { sourceId: string },
): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    if (paths.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `resolveSlugsByPaths: input size ${paths.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const { rows } = await exec.run<{ slug: string; source_path: string }>(sqlFragment`
      SELECT slug, source_path
        FROM pages
       WHERE source_path = ANY(${paths}::text[]) AND source_id = ${opts.sourceId}
    `);
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.source_path, r.slug);
    return m;
  }

export async function softDeletePage(exec: SqlExecutor, slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null> {
    const sourceId = opts?.sourceId;
    // Idempotent-as-null contract: only flip rows that are currently active.
    // RETURNING projects the slug so we can tell hit-vs-miss without a probe.
    const sourceCondition = sourceId ? sqlFragment`AND source_id = ${sourceId}` : sqlFragment``;
    const { rows } = await exec.run<{ slug: string }>(sqlFragment`
      UPDATE pages SET deleted_at = now()
      WHERE slug = ${slug} AND deleted_at IS NULL ${sourceCondition}
      RETURNING slug
    `);
    if (rows.length === 0) return null;
    return { slug: rows[0].slug };
  }

/**
 * #4587 — batch soft-delete primitive. See BrainEngine.softDeletePages
 * JSDoc. Mirrors deletePages' shape (empty-array early-return, batch-size
 * throw, RETURNING slug) with softDeletePage's `deleted_at IS NULL`
 * idempotency predicate. Nothing cascades — the 72h purge phase owns the
 * eventual hard delete.
 */
export async function softDeletePages(exec: SqlExecutor, slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `softDeletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const { rows } = await exec.run<{ slug: string }>(sqlFragment`
      UPDATE pages SET deleted_at = now()
       WHERE slug = ANY(${slugs}::text[]) AND source_id = ${opts.sourceId} AND deleted_at IS NULL
      RETURNING slug
    `);
    return rows.map(r => r.slug);
  }

export async function restorePage(exec: SqlExecutor, slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    const sourceId = opts?.sourceId;
    const sourceCondition = sourceId ? sqlFragment`AND source_id = ${sourceId}` : sqlFragment``;
    const { rows } = await exec.run(sqlFragment`
      UPDATE pages SET deleted_at = NULL
      WHERE slug = ${slug} AND deleted_at IS NOT NULL ${sourceCondition}
      RETURNING slug
    `);
    return rows.length > 0;
  }

export async function purgeDeletedPages(
  exec: SqlExecutor,
  olderThanHours: number,
  opts?: { dryRun?: boolean },
): Promise<{ slugs: string[]; count: number; pages?: { slug: string; deleted_at: Date }[] }> {
    // Clamp to non-negative integer; runaway purge protection. The DELETE
    // cascades through content_chunks, page_links, chunk_relations via FKs.
    const hours = Math.max(0, Math.floor(olderThanHours));
    if (opts?.dryRun) {
      // SAME WHERE predicate as the DELETE below (same cutoff arithmetic,
      // same DB now() clock source) — only the verb differs, so preview and
      // purge agree modulo rows crossing the cutoff between statements.
      const { rows } = await exec.run<{ slug: string; deleted_at: Date | string }>(sqlFragment`
        SELECT slug, deleted_at FROM pages
        WHERE deleted_at IS NOT NULL
          AND deleted_at < now() - (${hours} || ' hours')::interval
        ORDER BY deleted_at ASC, slug ASC
      `);
      const pages = rows.map((r) => ({
        slug: r.slug,
        deleted_at: r.deleted_at instanceof Date ? r.deleted_at : new Date(r.deleted_at),
      }));
      return { slugs: pages.map((p) => p.slug), count: pages.length, pages };
    }
    const { rows } = await exec.run<{ slug: string }>(sqlFragment`
      DELETE FROM pages
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - (${hours} || ' hours')::interval
      RETURNING slug
    `);
    const slugs = rows.map((r) => r.slug);
    return { slugs, count: slugs.length };
  }

export async function refreshPageBody(
  exec: SqlExecutor,
  slug: string,
  sourceId: string,
  compiledTruth: string,
  timeline: string,
  contentHash: string,
): Promise<void> {
    // Narrow UPDATE — leaves frontmatter, type, chunks, links, embeddings,
    // tags, takes untouched. Skips soft-deleted rows so a redirect retry
    // can't accidentally reanimate the body of a deleted canonical.
    // The spliced chunker-version expression reads the first two binds
    // ($1 compiled_truth, $2 timeline), so they stay first.
    await exec.run(sqlFragment`
      UPDATE pages
      SET compiled_truth = ${compiledTruth},
          timeline = ${timeline},
          content_hash = ${contentHash},
          chunker_version = ${trustedSql(bodyWriteChunkVersion('$1', '$2'))},
          updated_at = now()
      WHERE source_id = ${sourceId}
        AND slug = ${slug}
        AND deleted_at IS NULL
    `);
  }

export async function updatePageContextualRetrievalState(
  exec: SqlExecutor,
  slug: string,
  sourceId: string,
  mode: string,
  corpusGeneration: string | null,
): Promise<void> {
    // Narrow UPDATE — bumps updated_at as a side effect so the autopilot
    // sweep doesn't think the page hasn't changed since last touch. Skips
    // soft-deleted rows. corpus_generation nullable (caller passes NULL
    // for the 'none' tier path).
    await exec.run(sqlFragment`
      UPDATE pages
      SET contextual_retrieval_mode = ${mode},
          corpus_generation = ${corpusGeneration},
          updated_at = now()
      WHERE source_id = ${sourceId}
        AND slug = ${slug}
        AND deleted_at IS NULL
    `);
  }

export async function listPages(exec: ScopedRead, filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    const updatedAfter = filters?.updated_after;

    const typeCondition = filters?.type ? sqlFragment`AND p.type = ${filters.type}` : sqlFragment``;
    const tagJoin = filters?.tag ? sqlFragment`JOIN tags t ON t.page_id = p.id` : sqlFragment``;
    const tagCondition = filters?.tag ? sqlFragment`AND t.tag = ${filters.tag}` : sqlFragment``;
    // v0.45.7 keyset (updated_at, slug) supersedes updated_after when set.
    const keyset = filters?.updatedAfterKeyset;
    const updatedCondition = keyset
      // Exact only when the cursor carries the column's microseconds: callers
      // resume from `Page.updated_at_iso` (projected below), never from a JS
      // Date, which would re-select every row in the last row's millisecond.
      ? sqlFragment`AND (p.updated_at > ${keyset.updatedAt}::timestamptz OR (p.updated_at = ${keyset.updatedAt}::timestamptz AND p.slug > ${keyset.slug}))`
      : updatedAfter
        ? sqlFragment`AND p.updated_at > ${updatedAfter}::timestamptz`
        : sqlFragment``;
    // slugPrefix uses the (source_id, slug) UNIQUE btree index for range scans.
    // Escape LIKE metacharacters so the user prefix is treated as a literal.
    const slugPrefix = filters?.slugPrefix;
    const slugCondition = slugPrefix
      ? sqlFragment`AND p.slug LIKE ${slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'} ESCAPE '\\'`
      : sqlFragment``;
    // v0.31.12 + v0.34.1 (#876, D9): scope to a single source OR an array
    // of sources. When BOTH are set, the array wins (federated semantics
    // subsume the scalar case). When neither is set, no filter applies.
    const sourceCondition = filters?.sourceIds && filters.sourceIds.length > 0
      ? sqlFragment`AND p.source_id = ANY(${filters.sourceIds}::text[])`
      : filters?.sourceId
        ? sqlFragment`AND p.source_id = ${filters.sourceId}`
        : sqlFragment``;
    // v0.26.5: hide soft-deleted by default; opt in via filters.includeDeleted.
    const deletedCondition = filters?.includeDeleted === true
      ? sqlFragment``
      : sqlFragment`AND p.deleted_at IS NULL`;
    // #4352: untrusted-caller private-page filter (see PageFilters.excludePrivate).
    const privateCondition = filters?.excludePrivate === true
      ? trustedSql(`AND ${privatePagesFilterFragment('p')}`)
      : sqlFragment``;
    const effectiveAfterCondition = filters?.effective_after
      ? sqlFragment`AND p.effective_date >= ${filters.effective_after}::timestamptz`
      : sqlFragment``;
    const effectiveBeforeCondition = filters?.effective_before
      ? sqlFragment`AND p.effective_date <= ${filters.effective_before}::timestamptz`
      : sqlFragment``;

    // v0.29: ORDER BY threading via PAGE_SORT_SQL whitelist (no SQL injection).
    const sortKey = filters?.sort && PAGE_SORT_SQL[filters.sort] ? filters.sort : 'updated_desc';
    const orderBy = trustedSql(PAGE_SORT_SQL[sortKey]);

      const { rows } = await exec.run(sqlFragment`
        SELECT p.*, to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso FROM pages p
        ${tagJoin}
        WHERE 1=1 ${typeCondition} ${tagCondition} ${updatedCondition} ${slugCondition} ${sourceCondition} ${deletedCondition} ${privateCondition} ${effectiveAfterCondition} ${effectiveBeforeCondition}
        ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map(rowToPage);
  }

export async function getAllSlugs(exec: ScopedRead, opts?: { sourceId?: string }): Promise<Set<string>> {
      // v0.31.8 (D12): two-branch. With opts.sourceId return only that
      // source's slugs (reconcileLinks); without, the brain-wide union.
      if (opts?.sourceId) {
        const { rows } = await exec.run<{ slug: string }>(sqlFragment`SELECT slug FROM pages WHERE source_id = ${opts.sourceId}`);
        return new Set(rows.map((r) => r.slug));
      }
      const { rows } = await exec.run<{ slug: string }>(sqlFragment`SELECT slug FROM pages`);
      return new Set(rows.map((r) => r.slug));
  }

export async function listAllPageRefs(exec: LegacyUnscopedRead): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>> {
    // v0.32.8: cross-source page enumeration. ORDER BY (source_id, slug) for
    // deterministic iteration (F11) — same-slug-different-source pages stay
    // grouped predictably. WHERE deleted_at IS NULL matches default getPage
    // visibility semantics (v0.26.5). #4304: updated_at projected so --since
    // walks can filter refs before any full-page fetch.
    const { rows } = await exec.run<{ slug: string; source_id: string; updated_at: string | Date }>(sqlFragment`
      SELECT slug, source_id, updated_at FROM pages
      WHERE deleted_at IS NULL
      ORDER BY source_id, slug
    `);
    return rows.map((r) => ({
      slug: r.slug,
      source_id: r.source_id,
      updated_at: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    }));
  }

/** PGLite returned `last_retrieved_at` as text on some paths; Postgres as `Date`. */
const toDomainBankRow = ((normalize) => (raw: Record<string, unknown>): DomainBankRow => {
  const r = normalize(raw);
  return {
    slug: r.slug as string,
    source_id: r.source_id as string,
    prefix: r.prefix as string | null,
    page_id: Number(r.page_id),
    title: r.title as string | null,
    compiled_truth: (r.compiled_truth as string | null) ?? '',
    connection_count: Number(r.connection_count),
    last_retrieved_at: r.last_retrieved_at as Date | null,
    representative_chunk_id: r.representative_chunk_id == null ? null : Number(r.representative_chunk_id),
  };
})(compileRowNormalizer<Record<string, unknown>>({ last_retrieved_at: 'date' }));

// v0.37.0 — domain-bank sampling (D14 + D5 + D10).
//
// `listPrefixSampledPages`: one page per prefix, tiebroken by inbound-link
// count (connection_count via LEFT JOIN to page_links). Stale-bias optional
// for LSD mode (D5). Source-scoped (D5). Excludes close-set slugs.
//
// Ranking inside each prefix partition:
//   1. stale_score DESC (when staleBias) — never-retrieved beats >90d-stale beats fresh
//   2. connection_count DESC — structural-centrality tiebreaker (D10)
//   3. slug ASC — deterministic for tests
export async function listPrefixSampledPages(scoped: ScopedReadRunner, opts: DomainBankSampleOpts): Promise<DomainBankRow[]> {
    if (opts.prefixes.length === 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const staleBias = opts.staleBias === true;
    const staleThreshold = opts.staleThresholdDays ?? 90;
    // Source scoping (D5, codex r2 #2 — federated array wins over scalar).
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    return scoped(async (exec) => {
      const { rows } = await exec.run(sqlFragment`
      WITH prefix_pages AS (
        SELECT
          p.id AS page_id,
          p.slug,
          p.source_id,
          p.title,
          p.compiled_truth,
          p.last_retrieved_at,
          substring(p.slug from '^[^/]+/[^/]+') AS prefix,
          COUNT(pl.id) AS connection_count
        FROM pages p
        LEFT JOIN page_links pl ON pl.to_page_id = p.id
        WHERE p.deleted_at IS NULL
          AND substring(p.slug from '^[^/]+/[^/]+') = ANY(${opts.prefixes}::text[])
          AND (cardinality(${exclude}::text[]) = 0 OR NOT (p.slug = ANY(${exclude}::text[])))
          AND (
            (${sourceIds}::text[] IS NOT NULL AND p.source_id = ANY(${sourceIds}::text[]))
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NOT NULL AND p.source_id = ${sourceId})
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NULL)
          )
        GROUP BY p.id, p.slug, p.source_id, p.title, p.compiled_truth, p.last_retrieved_at
      ),
      ranked AS (
        SELECT
          pp.*,
          (CASE WHEN ${staleBias}::boolean THEN
            CASE
              WHEN pp.last_retrieved_at IS NULL THEN 2
              WHEN pp.last_retrieved_at < NOW() - (${staleThreshold}::int * INTERVAL '1 day') THEN 1
              ELSE 0
            END
          ELSE 0
          END) AS stale_score,
          ROW_NUMBER() OVER (
            PARTITION BY pp.prefix
            ORDER BY
              (CASE WHEN ${staleBias}::boolean THEN
                CASE
                  WHEN pp.last_retrieved_at IS NULL THEN 2
                  WHEN pp.last_retrieved_at < NOW() - (${staleThreshold}::int * INTERVAL '1 day') THEN 1
                  ELSE 0
                END
              ELSE 0
              END) DESC,
              pp.connection_count DESC,
              pp.slug ASC
          ) AS rn
        FROM prefix_pages pp
      ),
      with_chunk AS (
        SELECT
          r.*,
          (
            SELECT cc.id FROM content_chunks cc
            WHERE cc.page_id = r.page_id AND cc.embedding IS NOT NULL
            ORDER BY cc.chunk_index ASC
            LIMIT 1
          ) AS representative_chunk_id
        FROM ranked r
        WHERE r.rn = 1
      )
      SELECT page_id, slug, source_id, title, compiled_truth, last_retrieved_at,
             prefix, connection_count, representative_chunk_id
      FROM with_chunk
      ORDER BY prefix
    `);
      return rows.map(toDomainBankRow);
    });
  }

// v0.37.0 — corpus-sampling fallback when prefix-stratified can't fill M.
// Deterministic with opts.seed (setseed before SELECT on the same executor;
// PostgresEngine's runner pins one connection with alwaysTransaction when
// seeded); random otherwise.
export async function listCorpusSample(scoped: ScopedReadRunner, opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    if (opts.n <= 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    return scoped(async (exec) => {
      if (typeof opts.seed === 'number') {
        // Clamp to [-1, 1] required by setseed.
        const clamped = Math.max(-1, Math.min(1, opts.seed));
        await exec.run(sqlFragment`SELECT setseed(${clamped}::float8)`);
      }
      const { rows } = await exec.run(sqlFragment`
      WITH sampled AS (
        SELECT
          p.id AS page_id,
          p.slug,
          p.source_id,
          p.title,
          p.compiled_truth,
          p.last_retrieved_at,
          substring(p.slug from '^[^/]+/[^/]+') AS prefix,
          (SELECT COUNT(*) FROM page_links pl WHERE pl.to_page_id = p.id) AS connection_count
        FROM pages p
        WHERE p.deleted_at IS NULL
          AND (cardinality(${exclude}::text[]) = 0 OR NOT (p.slug = ANY(${exclude}::text[])))
          AND (
            (${sourceIds}::text[] IS NOT NULL AND p.source_id = ANY(${sourceIds}::text[]))
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NOT NULL AND p.source_id = ${sourceId})
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NULL)
          )
        ORDER BY RANDOM()
        LIMIT ${opts.n}
      )
      SELECT
        s.*,
        (
          SELECT cc.id FROM content_chunks cc
          WHERE cc.page_id = s.page_id AND cc.embedding IS NOT NULL
          ORDER BY cc.chunk_index ASC
          LIMIT 1
        ) AS representative_chunk_id
      FROM sampled s
    `);
      return rows.map(toDomainBankRow);
    });
  }

export async function resolveSlugs(
  exec: LegacyUnscopedRead,
  partial: string,
  opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
): Promise<string[]> {
    // v0.41.13 #1436: source scope. When neither opt is set the resolver
    // stays unscoped for back-compat with internal callers. The
    // `deleted_at IS NULL` filter excludes soft-deleted rows (v0.26.5) from
    // fuzzy candidates — they're not legitimate match targets for a remote
    // `get_page`.
    const sources = opts?.sourceIds?.length ? opts.sourceIds : null;
    const scalar = opts?.sourceId ?? null;
    const privacy = opts?.excludePrivate ? trustedSql(` AND ${privatePagesFilterFragment('pages')}`) : sqlFragment``;
    const scopeFragment = sources
      ? sqlFragment` AND source_id = ANY(${sources}::text[])`
      : scalar
        ? sqlFragment` AND source_id = ${scalar}`
        : sqlFragment``;

    // Try exact match first
    const exact = await exec.run<{ slug: string }>(sqlFragment`SELECT slug FROM pages WHERE slug = ${partial} AND deleted_at IS NULL${scopeFragment}${privacy}`);
    if (exact.rows.length > 0) return [exact.rows[0].slug];

    // Fuzzy match via pg_trgm
    const fuzzy = await exec.run<{ slug: string }>(sqlFragment`
      SELECT slug, similarity(title, ${partial}) AS sim
      FROM pages
      WHERE deleted_at IS NULL AND (title % ${partial} OR slug ILIKE ${'%' + partial + '%'})${scopeFragment}${privacy}
      ORDER BY sim DESC
      LIMIT 5
    `);
    return fuzzy.rows.map((r) => r.slug);
  }

// ── v0.42.7 (#1696): link/timeline extraction freshness watermark ──

/** Shared stale-for-extraction predicate. */
function stalePagesWhere(opts?: { sourceId?: string; versionTs?: string }) {
  const version = opts?.versionTs
    ? sqlFragment`(links_extracted_at IS NULL OR links_extracted_at < ${opts.versionTs}::timestamptz OR updated_at > links_extracted_at)`
    : sqlFragment`(links_extracted_at IS NULL OR updated_at > links_extracted_at)`;
  const source = opts?.sourceId ? sqlFragment` AND source_id = ${opts.sourceId}` : sqlFragment``;
  return sqlFragment`deleted_at IS NULL AND ${version}${source}`;
}

export async function countStalePagesForExtraction(exec: ScopedRead, opts?: { sourceId?: string; versionTs?: string }): Promise<number> {
    const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS count FROM pages WHERE ${stalePagesWhere(opts)}`);
    const { rows } = await exec.unsafe<{ count?: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  }

export async function listStalePagesForExtraction(exec: ScopedRead, opts: {
  batchSize: number;
  afterPageId?: number;
  sourceId?: string;
  versionTs?: string;
}): Promise<StalePageRow[]> {
    const afterClause = opts.afterPageId != null ? sqlFragment` AND id > ${opts.afterPageId}` : sqlFragment``;
    // #1768: project a deterministic full-µs UTC string alongside updated_at.
    // to_char (not ::text — DateStyle-fragile) so extractStaleFromDB can stamp
    // links_extracted_at = the exact updated_at and the staleness predicate clears.
    const { text, params } = renderFragment(sqlFragment`SELECT id, slug, source_id, type, title, compiled_truth, timeline, frontmatter, updated_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
           FROM pages
           WHERE ${stalePagesWhere(opts)}${afterClause}
           ORDER BY id
           LIMIT ${opts.batchSize}`);
    const { rows } = await exec.unsafe(text, params);
    return rows.map(rowToStalePage);
  }

export async function markPagesExtractedBatch(
  exec: SqlExecutor,
  refs: Array<{ slug: string; source_id: string; extractedAt?: string }>,
  defaultExtractedAt: string,
): Promise<number> {
    if (refs.length === 0) return 0;
    const slugs = refs.map(r => r.slug);
    const srcs = refs.map(r => r.source_id);
    // Per-ref timestamp (D4 race fix): extract --stale passes each row's read
    // updated_at; sites that omit it fall back to defaultExtractedAt.
    const tss = refs.map(r => r.extractedAt ?? defaultExtractedAt);
    // #3957: the stamped-row count is observable so callers (stampExtracted)
    // can surface a wrong-source shortfall instead of claiming success while
    // every ref missed.
    const result = await exec.run(sqlFragment`
      UPDATE pages p SET links_extracted_at = v.ts::timestamptz
      FROM unnest(${slugs}::text[], ${srcs}::text[], ${tss}::text[]) AS v(slug, source_id, ts)
      WHERE p.slug = v.slug AND p.source_id = v.source_id
    `);
    return result.affectedRows;
  }

export async function findByTitleFuzzy(
  exec: LegacyUnscopedRead,
  name: string,
  dirPrefix?: string,
  minSimilarity: number = 0.55,
  sourceId?: string,
): Promise<{ slug: string; similarity: number } | null> {
    // Use `%` so the existing idx_pages_trgm GIN index can prune candidates
    // when the requested threshold is at least pg_trgm's default 0.3. Below
    // that, retain the exact comparison path so low-threshold callers do not
    // lose valid matches. Keep the explicit comparison in both paths as the
    // result contract.
    //
    // Tie-breaker: sort by slug after similarity so re-runs return the
    // same winner when multiple pages score equally (prevents churn
    // in put_page auto-link reconciliation).
    //
    // `sourceId` + `deleted_at IS NULL` mirror the filters `tryFuzzyMatch`
    // in `src/core/entities/resolve.ts` got via #1436 (v0.41.13.0). Without
    // them, fuzzy resolution could suggest cross-source slugs that the
    // caller then silently drops at the FK filter in
    // `operations.ts:reconcileLinks` (the `allSlugs` filter) — making it
    // look like the match failed when in fact it picked the wrong page.
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const trgmPrefilter = minSimilarity >= 0.3
      ? sqlFragment`title % ${name} AND`
      : sqlFragment``;
    const { rows } = sourceId
      ? await exec.run<{ slug: string; sim: number }>(sqlFragment`
          SELECT slug, similarity(title, ${name}) AS sim
          FROM pages
          WHERE ${trgmPrefilter} similarity(title, ${name}) >= ${minSimilarity}
            AND slug LIKE ${prefixPattern}
            AND source_id = ${sourceId}
            AND deleted_at IS NULL
          ORDER BY sim DESC, slug ASC
          LIMIT 1
        `)
      : await exec.run<{ slug: string; sim: number }>(sqlFragment`
          SELECT slug, similarity(title, ${name}) AS sim
          FROM pages
          WHERE ${trgmPrefilter} similarity(title, ${name}) >= ${minSimilarity}
            AND slug LIKE ${prefixPattern}
          ORDER BY sim DESC, slug ASC
          LIMIT 1
        `);
    if (rows.length === 0) return null;
    return { slug: rows[0].slug, similarity: rows[0].sim };
  }

export async function getPageTimestamps(exec: LegacyUnscopedRead, slugs: string[]): Promise<Map<string, Date>> {
    if (slugs.length === 0) return new Map();
    const { rows } = await exec.run<{ slug: string; ts: string | Date }>(sqlFragment`
      SELECT slug, COALESCE(updated_at, created_at) as ts
      FROM pages WHERE slug = ANY(${slugs}::text[])
    `);
    return new Map(rows.map(r => [r.slug, new Date(r.ts as string)]));
  }

export async function getVersions(
  exec: LegacyUnscopedRead,
  slug: string,
  opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
): Promise<PageVersion[]> {
    const privacy = opts?.excludePrivate
      ? trustedSql(`AND ${privatePagesFilterFragment('p')} AND ${privateSnapshotFilterFragment('pv')}`) : sqlFragment``;
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const { rows } = await exec.run<PageVersion>(sqlFragment`
        SELECT pv.* FROM page_versions pv
        JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = ${slug} AND p.source_id = ANY(${opts.sourceIds}::text[])
          ${privacy}
        ORDER BY pv.snapshot_at DESC
      `);
      return rows;
    }
    if (opts?.sourceId) {
      const { rows } = await exec.run<PageVersion>(sqlFragment`
        SELECT pv.* FROM page_versions pv
        JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = ${slug} AND p.source_id = ${opts.sourceId}
          ${privacy}
        ORDER BY pv.snapshot_at DESC
      `);
      return rows;
    }
    const { rows } = await exec.run<PageVersion>(sqlFragment`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ${slug}
        ${privacy}
      ORDER BY pv.snapshot_at DESC
    `);
    return rows;
  }

export async function revertToVersion(
  exec: SqlExecutor,
  slug: string,
  versionId: number,
  opts?: { sourceId?: string },
): Promise<void> {
    // v0.31.8 (D12): two-branch. With opts.sourceId, scope BOTH the page lookup
    // AND the version reference. Without it, multi-source brains can revert
    // the wrong same-slug page.
    if (opts?.sourceId) {
      await exec.run(sqlFragment`
        UPDATE pages SET
          compiled_truth = pv.compiled_truth,
          frontmatter = pv.frontmatter,
          chunker_version = ${trustedSql(bodyWriteChunkVersion('pv.compiled_truth', 'pages.timeline'))},
          updated_at = now()
        FROM page_versions pv
        WHERE pages.slug = ${slug} AND pages.source_id = ${opts.sourceId}
              AND pv.id = ${versionId} AND pv.page_id = pages.id
      `);
      return;
    }
    await exec.run(sqlFragment`
      UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
          chunker_version = ${trustedSql(bodyWriteChunkVersion('pv.compiled_truth', 'pages.timeline'))},
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = ${slug} AND pv.id = ${versionId} AND pv.page_id = pages.id
    `);
  }

/**
 * The rename statement plus its slug alias and bindings, run on the
 * transaction the engine opened (`exec` is that transaction's executor,
 * `tx` its engine clone). Source-qualified so a rename in source A doesn't
 * sweep up same-slug rows in sources B/C/D.
 */
export async function updateSlug(exec: SqlExecutor, tx: BrainEngine, oldSlug: string, newSlug: string, sourceId: string): Promise<number> {
      const moved = await exec.executeRaw(
        `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2 AND source_id = $3 RETURNING id`,
        [newSlug, oldSlug, sourceId],
      );
      if (moved.length > 0) {
        await recordRenameAlias(tx, sourceId, oldSlug, newSlug);
        await moveSlugBindings(tx, sourceId, oldSlug, newSlug);
      }
      // #3056: rows moved — a zero-row UPDATE does not throw, so the count is
      // the only way callers can see the no-op.
      return moved.length;
  }

/** Replace a page's alias set under its page-key lock, inside the engine's transaction. */
export async function setPageAliases(
  exec: SqlExecutor,
  tx: Pick<BrainEngine, 'lockPageKeys'>,
  slug: string,
  sourceId: string,
  aliasNorms: string[],
): Promise<void> {
    const uniq = Array.from(new Set(aliasNorms.filter(a => a.length > 0)));
      await tx.lockPageKeys([{ sourceId, slug }]);
      await exec.executeRaw('DELETE FROM page_aliases WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      if (!uniq.length) return;
      await exec.executeRaw(`INSERT INTO page_aliases (source_id,alias_norm,slug)
        SELECT $1,a,$2 FROM unnest($3::text[]) AS a ON CONFLICT DO NOTHING`, [sourceId, slug, uniq]);
  }

export async function resolveSlugWithAliasDetailed(
  exec: LegacyUnscopedRead,
  slug: string,
  sourceOrSources: string | readonly string[],
  opts?: { excludePrivate?: boolean },
): Promise<{ canonical_slug: string; source_id: string } | null> {
    const sources = Array.isArray(sourceOrSources) ? sourceOrSources : [sourceOrSources];
    if (sources.length === 0) return null;
    const privacy = opts?.excludePrivate ? trustedSql(`AND EXISTS (SELECT 1 FROM pages p WHERE p.slug = slug_aliases.canonical_slug AND p.source_id = slug_aliases.source_id AND p.deleted_at IS NULL AND ${privatePagesFilterFragment('p')})`) : sqlFragment``;
    try {
      const { rows } = await exec.run<{ canonical_slug: string; source_id: string }>(sqlFragment`
        SELECT canonical_slug, source_id
        FROM slug_aliases
        WHERE alias_slug = ${slug}
          AND source_id = ANY(${sources}::text[]) ${privacy}
        ORDER BY array_position(${sources}::text[], source_id), id
      `);
      if (rows.length === 0) return null;
      if (rows.length > 1) {
        warnOncePerProcess(
          `resolveSlugWithAlias:multi_match:${slug}`,
          `[resolveSlugWithAlias] multi_match: alias '${slug}' exists in ${rows.length} sources; returning first by sourceOrSources order.`,
        );
      }
      return { canonical_slug: rows[0].canonical_slug, source_id: rows[0].source_id };
    } catch (e) {
      // Pre-v105 brain: slug_aliases table doesn't exist yet. Defense-in-depth
      // per the engine interface contract.
      if (isUndefinedTableError(e)) return null;
      throw e;
    }
  }
