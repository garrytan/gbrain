/**
 * The `gbrain embed --stale` reads and writes that embedding-readiness.ts, embedding-invalidation.ts, embed-stale.ts and
 * content-drift-sweep.ts ran through `executeRaw`, moved here with the same text and parameters. PGLite and Postgres run
 * these exact statements; the active embedding column is spliced as a quoted identifier, as it was. The provenance
 * check of embed-stale.ts is readPageProvenanceComplete (engine-sql/embedding-provenance.ts).
 *
 * The Rust engine serves each member from its store (rust/docs/store/embed-stale-work.md). Its store keeps one vector
 * column, `embedding`; a member asked about any other column refuses `engine_capability_missing` there.
 */
import type { BrainEngine } from '../engine.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import { pageBudgetLimitedFilter } from '../page-size-policy.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { lockEmbeddingSources } from '../embedding-invalidation.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** A segmented page with a body: its projection (`buildSegmentedProjection`) owes chunk rows even when it has none yet. */
const SEGMENTED_BODY = trustedSql(`(p.body_storage = 'segmented' AND p.body_bytes > 0)`);
/** Held or capped large pages (page-embedding-budget.ts) leave the embedding queue while the hold applies. */
const budgetLimited = trustedSql(pageBudgetLimitedFilter('p'));
const notQuarantined = trustedSql(QUARANTINE_FILTER_FRAGMENT);

/** The archived-source work `embed --stale` reports as blocked (embedding-readiness.ts countArchivedEmbeddingWork). `column` null reads every chunk as missing its vector. */
export interface ArchivedEmbeddingWorkOpts {
  sourceId: string | null;
  signature: string | null;
  includeNullSignature: boolean;
  includeUnsealed: boolean;
  column: string | null;
}

export async function countArchivedEmbeddingWork(raw: EngineRawRead, opts: ArchivedEmbeddingWorkOpts): Promise<number> {
  const vector = opts.column === null ? trustedSql('NULL::vector') : trustedSql(`c.${quoteIdentifier(opts.column)}`);
  // chunk-visibility-ok: archived-source work counts every stored chunk row of the page, staged or retired included, as the readiness count did
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM pages p
    JOIN sources s ON s.id=p.source_id WHERE s.archived AND p.deleted_at IS NULL
      AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
      AND (${opts.sourceId}::text IS NULL OR p.source_id=${opts.sourceId})
      AND ((${opts.includeUnsealed}::boolean AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision)
        OR EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (${vector} IS NULL
          OR c.embedded_text_hash <> md5(c.chunk_text)
          OR (${opts.signature}::text IS NOT NULL AND (p.embedding_signature <> ${opts.signature} OR (${opts.includeNullSignature}::boolean AND p.embedding_signature IS NULL)))))
        OR ((p.compiled_truth <> '' OR p.timeline <> '' OR ${SEGMENTED_BODY}) AND ${notQuarantined}
          AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)))`);
  const [row] = await raw<{ n: number }>(text, params);
  return row?.n as number;
}

/**
 * The pages still waiting for a text projection (embedding-readiness.ts): `stale` narrows them to pages with embedding
 * work in the active `column` (a segmented body, or a chunk with no vector, a vector of other text or another signature).
 */
export interface PendingProjectionScope {
  sourceId: string | null;
  existingChunksOnly: boolean;
  activeSourcesOnly: boolean;
  stale: { column: string; signature: string | null; includeNullSignature: boolean } | null;
}

/** The scope as one WHERE clause over `pages p JOIN sources s`. */
function pendingProjectionWhere(scope: PendingProjectionScope): SqlFragment {
  let eligible = sqlFragment``;
  if (scope.stale) {
    const column = trustedSql(quoteIdentifier(scope.stale.column));
    const { signature, includeNullSignature } = scope.stale;
    // chunk-visibility-ok: a pending page owes work for any stored chunk row, as the readiness reads did
    eligible = sqlFragment`AND (${SEGMENTED_BODY} OR EXISTS(SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND (
      c.${column} IS NULL OR c.embedded_text_hash <> md5(c.chunk_text)
      OR (${signature}::text IS NOT NULL AND (p.embedding_signature <> ${signature} OR (${includeNullSignature}::boolean AND p.embedding_signature IS NULL))))))`;
  }
  const active = scope.activeSourcesOnly ? trustedSql('AND NOT s.archived') : trustedSql('');
  // chunk-visibility-ok: whether the page has any stored chunk row at all, as the readiness reads did
  return sqlFragment`p.deleted_at IS NULL
    AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
    AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
    AND (${scope.sourceId}::text IS NULL OR p.source_id=${scope.sourceId})
    ${active}
    AND (NOT ${scope.existingChunksOnly}::boolean OR ${SEGMENTED_BODY} OR EXISTS(SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)) ${eligible}`;
}

/** How many pages the scope names. */
export async function countEmbedPendingProjections(raw: EngineRawRead, scope: PendingProjectionScope): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${pendingProjectionWhere(scope)}`);
  const [remaining] = await raw<{ n: number }>(text, params);
  return remaining?.n as number;
}

export interface PendingProjectionPage { source_id: string; slug: string; page_kind: string }

/** The first `limit` pages of the scope in active sources, by page id. */
export async function listEmbedPendingProjections(raw: EngineRawRead, scope: PendingProjectionScope, limit: number): Promise<PendingProjectionPage[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.source_id,p.slug,p.page_kind FROM pages p
    JOIN sources s ON s.id=p.source_id WHERE ${pendingProjectionWhere(scope)} AND NOT s.archived ORDER BY p.id LIMIT ${limit}`);
  return raw<PendingProjectionPage>(text, params);
}

export interface ProjectionRepairPage { id: number; slug: string; source_id: string }

/** The next `limit` pages of the scope in active sources after page id `afterPageId` that a rebuild can build (markdown, code or segmented), by page id. */
export async function listEmbedProjectionRepairPages(raw: EngineRawRead, scope: PendingProjectionScope, afterPageId: number, limit: number): Promise<ProjectionRepairPage[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug,p.source_id,p.id FROM pages p
      JOIN sources s ON s.id=p.source_id WHERE ${pendingProjectionWhere(scope)} AND NOT s.archived AND p.id>${afterPageId}
        AND (p.page_kind IN ('markdown','code') OR p.body_storage='segmented')
      ORDER BY p.id LIMIT ${limit}`);
  return raw<ProjectionRepairPage>(text, params);
}

/** Whether the page with this id keeps its body in segments. */
export async function readPageIsSegmented(raw: EngineRawRead, pageId: number): Promise<boolean> {
  const [segmented] = await raw(`SELECT 1 FROM pages WHERE id=$1 AND body_storage='segmented'`, [pageId]);
  return segmented !== undefined;
}

/** embedding-invalidation.ts hasSignatureDrift: the signature rule and the active `column`. */
export interface SignatureDriftOpts {
  column: string;
  signature: string;
  sourceId: string | null;
  includeNullSignature: boolean;
  nullSignatureOnly: boolean;
}

export async function hasEmbeddingSignatureDrift(raw: EngineRawRead, opts: SignatureDriftOpts): Promise<boolean> {
  const colId = trustedSql(quoteIdentifier(opts.column));
  const sigClause = opts.nullSignatureOnly ? sqlFragment`p.embedding_signature IS NULL`
    : opts.includeNullSignature ? sqlFragment`(p.embedding_signature IS NULL OR p.embedding_signature <> ${opts.signature})`
    : sqlFragment`p.embedding_signature IS NOT NULL AND p.embedding_signature <> ${opts.signature}`;
  const liveBody = trustedSql(chunkGenerationFilter('p', 'cc'));
  const { text, params } = renderFragment(sqlFragment`SELECT EXISTS (
       SELECT 1 FROM pages p
        WHERE ${sigClause}
          AND p.deleted_at IS NULL
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          AND NOT ${budgetLimited}
          AND (${opts.sourceId}::text IS NULL OR p.source_id = ${opts.sourceId})
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND NOT s.archived)
          AND EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id AND cc.${colId} IS NOT NULL AND ${liveBody})
     ) AS drift`);
  const [row] = await raw<{ drift: boolean }>(text, params);
  return row?.drift === true;
}

/** embed-stale.ts embedStaleForSource: the chunk indexes of the page's live body with no vector in `column`, ascending. */
export async function listUnembeddedChunkIndexes(raw: EngineRawRead, slug: string, sourceId: string, column: string): Promise<number[]> {
  const colId = trustedSql(quoteIdentifier(column));
  const liveBody = trustedSql(chunkGenerationFilter('p', 'cc'));
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index
             FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
            WHERE p.slug = ${slug} AND p.source_id = ${sourceId} AND cc.${colId} IS NULL AND ${liveBody}
            ORDER BY cc.chunk_index`);
  return (await raw<{ chunk_index: number | string }>(text, params)).map(r => Number(r.chunk_index));
}

/** The content-drift sweep's cursor row: created with `initial` when absent, then locked for the caller's transaction. */
export async function lockContentDriftState(raw: EngineRawRead, key: string, initial: string): Promise<string | null> {
  await raw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, initial]);
  const [row] = await raw<{ value: string }>(`SELECT value FROM config WHERE key = $1 FOR UPDATE`, [key]);
  return row?.value ?? null;
}

export interface ContentDriftChunkWindow { column: string; afterChunkId: number; limit: number; sourceId?: string }
export interface ContentDriftChunkResult { last_id: number | string | null; checked: number | string; drifted: number | string }

/**
 * One content-drift batch (engine-sql/chunks.ts invalidateContentDriftBatch) on the caller's transaction: share-lock the
 * live sources, examine the next `limit` chunk rows after `afterChunkId` in id order, and drop the vector of each whose
 * text changed since it was embedded. The cursor and limit are inlined, not bound, so a prepared statement never
 * switches to a generic plan that scans the whole table (migration-preludes.ts).
 */
export async function invalidateContentDriftChunks(raw: EngineRawRead, window: ContentDriftChunkWindow): Promise<ContentDriftChunkResult> {
  const after = Math.trunc(window.afterChunkId);
  const limit = Math.trunc(window.limit);
  if (!Number.isFinite(after) || !Number.isFinite(limit) || after < 0 || limit < 1) {
    throw new Error(`invalid content-drift batch window: after ${window.afterChunkId}, limit ${window.limit}`);
  }
  const colId = trustedSql(quoteIdentifier(window.column));
  const span = trustedSql(`id > ${after} ORDER BY id LIMIT ${limit}`);
  const srcClause = window.sourceId !== undefined ? sqlFragment` AND p.source_id = ${window.sourceId}` : sqlFragment``;
  const sources = await lockEmbeddingSources({ executeRaw: raw } as Pick<BrainEngine, 'executeRaw'>, window.sourceId);
  // chunk-visibility-ok: the drift sweep visits every chunk row by id; the UPDATE's predicates decide eligibility
  const { text, params } = renderFragment(sqlFragment`WITH b AS (SELECT id FROM content_chunks WHERE ${span}),
             w AS (UPDATE content_chunks cc
            SET ${colId} = NULL, embedded_at = NULL, embedded_text_hash = NULL, embedding_pending_since = now()
           FROM b, pages p
          WHERE cc.id = b.id
            AND cc.page_id = p.id
            AND p.source_id=ANY(${sources}::text[])
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
            AND p.deleted_at IS NULL
            AND cc.${colId} IS NOT NULL
            AND cc.embedded_text_hash IS NOT NULL
            AND cc.embedded_text_hash <> md5(cc.chunk_text)
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND NOT ${budgetLimited}${srcClause}
          RETURNING 1)
        SELECT (SELECT max(id) FROM b) AS last_id, (SELECT count(*) FROM b)::int AS checked, (SELECT count(*) FROM w)::int AS drifted`);
  const [row] = await raw<ContentDriftChunkResult>(text, params);
  return row ?? { last_id: null, checked: 0, drifted: 0 };
}


/** What a backfill would embed, in characters (embed-consent.ts estimateEmbedBackfillUsd). */
export interface EmbedBackfillChars { chunk_chars: number; chunkless_chars: number }

/**
 * embed-consent.ts estimateEmbedBackfillUsd: the characters of live pages' chunks (only chunks with no `embedding`
 * vector unless `all`) and, unless `all`, of live chunkless pages' inline bodies; `sourceId` narrows both to one source.
 * With `all` the chunkless sum is not read and answers 0.
 */
export async function sumEmbedBackfillChars(raw: EngineRawRead, sourceId: string | null, all: boolean): Promise<EmbedBackfillChars> {
  const bySource = sourceId === null ? trustedSql('') : sqlFragment` AND p.source_id = ${sourceId}`;
  const unembedded = trustedSql(all ? '' : ' AND c.embedding IS NULL');
  const chunks = renderFragment(sqlFragment`-- chunk-visibility-ok: a cost estimate moved from embed-consent.ts; it sums every chunk row of a live page, as before.
     SELECT COALESCE(SUM(length(c.chunk_text)), 0)::bigint AS chars FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.deleted_at IS NULL${unembedded}${bySource}`);
  const [chunkRow] = await raw<{ chars: number | string }>(chunks.text, chunks.params);
  if (all) return { chunk_chars: Number(chunkRow?.chars ?? 0), chunkless_chars: 0 };
  const chunkless = renderFragment(sqlFragment`-- chunk-visibility-ok: moved from embed-consent.ts; a page with any chunk row is not chunkless, as before.
     SELECT COALESCE(SUM(length(p.compiled_truth) + length(p.timeline)), 0)::bigint AS chars FROM pages p
        WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id)${bySource}`);
  const [chunklessRow] = await raw<{ chars: number | string }>(chunkless.text, chunkless.params);
  return { chunk_chars: Number(chunkRow?.chars ?? 0), chunkless_chars: Number(chunklessRow?.chars ?? 0) };
}
