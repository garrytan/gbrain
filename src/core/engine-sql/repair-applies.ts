/**
 * The rechecks and writes of `gbrain repair` applies that ran through `executeRaw` (src/core/repair/*.ts and the source
 * row the url-clone check reads), each with the statement text and parameters its caller used; only its home moved.
 * Ids come back as numbers on every engine (Postgres returns `bigint` as text).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { privateSnapshotFilterFragment } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

const ids = (rows: Array<{ id: number | string }>): number[] => rows.map(row => Number(row.id));

// ---------------------------------------------------------------------------------------------------------------------
// consolidate-ties (src/core/repair/consolidate-ties.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The closed tie a consolidate-ties preview listed: its fact, entity, take and the day its validity closed on. */
export interface ConsolidationTieRestore { source_id: string; id: number; entity_slug: string; take_id: number; valid_from: string | Date }

/** Reopens the tie's fact (`valid_until` back to null) when it is still exactly as previewed; true when it did. */
export async function restoreConsolidationTie(raw: EngineRawRead, tie: ConsolidationTieRestore): Promise<boolean> {
  return (await raw<{ id: number }>(
      `UPDATE facts SET valid_until = NULL
        WHERE source_id = $1 AND id = $2 AND entity_slug = $3 AND consolidated_into = $4 AND expired_at IS NULL
          AND valid_until = valid_from AND valid_from = $5::timestamptz
        RETURNING id`, [tie.source_id, tie.id, tie.entity_slug, tie.take_id, tie.valid_from])).length === 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// duplicate-facts (src/core/repair/duplicate-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** One fact of a duplicate group as it reads now. */
export interface LiveDuplicateRow { id: number; entity_slug: string | null; row_num: number | null; source_markdown_slug: string | null }

/** The named facts still active, unsuperseded and stating the group's claim (`visibility`, `fingerprint`). */
export async function listLiveDuplicateRows(raw: EngineRawRead, sourceId: string, factIds: readonly number[], visibility: string,
  fingerprint: string): Promise<LiveDuplicateRow[]> {
  const rows = await raw<{ id: number | string; entity_slug: string | null; row_num: number | string | null; source_markdown_slug: string | null }>(
    `SELECT id, entity_slug, row_num, source_markdown_slug FROM facts
      WHERE source_id=$1 AND id=ANY($2::bigint[]) AND visibility=$3 AND gbrain_fact_fingerprint(fact)=$4
        AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND superseded_by IS NULL`,
    [sourceId, [...factIds], visibility, fingerprint]);
  return rows.map(r => ({ id: Number(r.id), entity_slug: r.entity_slug, row_num: r.row_num === null ? null : Number(r.row_num),
    source_markdown_slug: r.source_markdown_slug }));
}

/** Expires the named database-only copies as superseded by `keptId` while the kept fact is still active; the ids it changed. */
export async function supersedeDuplicateFacts(raw: EngineRawRead, sourceId: string, factIds: readonly number[], keptId: number,
  visibility: string, fingerprint: string): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(
      `UPDATE facts SET expired_at = now(), superseded_by = $3
        WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL AND superseded_by IS NULL
          AND visibility = $4 AND gbrain_fact_fingerprint(fact) = $5
          AND EXISTS (SELECT 1 FROM facts k WHERE k.source_id = $1 AND k.id = $3 AND k.expired_at IS NULL)
        RETURNING id`, [sourceId, [...factIds], keptId, visibility, fingerprint]));
}

/** Links the struck fenced copies (already expired by their page write) to `keptId`; the ids it changed. */
export async function linkStruckDuplicateFacts(raw: EngineRawRead, sourceId: string, factIds: readonly number[], keptId: number): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(
    `UPDATE facts SET superseded_by = $3 WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NOT NULL AND superseded_by IS NULL
      RETURNING id`, [sourceId, [...factIds], keptId]));
}

// ---------------------------------------------------------------------------------------------------------------------
// extractor-facts (src/core/repair/extractor-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The (source, slug) pairs of committed restore jobs of this preview (`hash`) or of the named requests. */
export async function listCommittedRestorePages(raw: EngineRawRead, sourceIds: readonly string[], slugs: readonly string[], hash: string,
  requestIds: readonly string[]): Promise<Array<{ source_id: string; slug: string }>> {
  return raw<{ source_id: string; slug: string }>(`SELECT DISTINCT source_id, slug FROM persistence_requests
    WHERE state='committed' AND operation='submit_job' AND source_id=ANY($1::text[]) AND slug=ANY($2::text[])
      AND (intent->>'preview_hash'=$3 OR request_id=ANY($4::uuid[]))`,
  [[...sourceIds], [...slugs], hash, [...requestIds]]);
}

/** The named facts that are active and hold a fence row number. */
export async function listActivePositionedFactIds(raw: EngineRawRead, factIds: readonly number[]): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(
    'SELECT id FROM facts WHERE id=ANY($1::bigint[]) AND expired_at IS NULL AND row_num IS NOT NULL', [[...factIds]]));
}

/** The live page at the slug, its body (null for a segmented page) and the largest fact row number it holds. */
export interface FactRestorePage { id: number; compiled_truth: string | null; max_row: number | null }

export async function readFactRestorePage(raw: EngineRawRead, sourceId: string, slug: string): Promise<FactRestorePage | null> {
  const [row] = await raw<{ id: number | string; compiled_truth: string | null; max_row: number | string | null }>(
    `SELECT p.id, p.compiled_truth, (SELECT MAX(row_num) FROM facts WHERE source_id=$1 AND source_markdown_slug=$2) AS max_row
       FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, slug]);
  return row ? { id: Number(row.id), compiled_truth: row.compiled_truth, max_row: row.max_row === null ? null : Number(row.max_row) } : null;
}

/**
 * Restores one expired, unpositioned, unsuperseded fact at row `rowNum` when its expiry (UTC text with microseconds) is
 * still `expiredAt`; true when it did.
 */
export async function restoreExtractorFact(raw: EngineRawRead, sourceId: string, id: number, rowNum: number, expiredAt: string): Promise<boolean> {
  return (await raw(`UPDATE facts SET expired_at=NULL, row_num=$3
      WHERE source_id=$1 AND id=$2 AND row_num IS NULL AND superseded_by IS NULL AND to_char(expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=$4 RETURNING id`,
    [sourceId, id, rowNum, expiredAt])).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// fact-claim-dates (src/core/repair/fact-claim-dates.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** One database-only fact to move: its id, the `valid_from` the preview read and the claim's day. */
export interface ClaimDateMove { id: number; valid_from: string; date: string }

/** Moves each named active database-only fact still at its previewed `valid_from` to UTC midnight of its day; the ids it moved. */
export async function moveFactClaimDates(raw: EngineRawRead, sourceId: string, rows: readonly ClaimDateMove[]): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(`UPDATE facts f
      SET valid_from = (r.date || 'T00:00:00Z')::timestamptz
     FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, valid_from text, date text)
    WHERE f.source_id = $1 AND f.id = r.id AND f.valid_from = r.valid_from::timestamptz AND f.expired_at IS NULL AND f.row_num IS NULL
    RETURNING f.id`, [sourceId, JSON.stringify(rows.map(({ id, valid_from, date }) => ({ id, valid_from, date })))]));
}

// ---------------------------------------------------------------------------------------------------------------------
// purged-page-facts (src/core/repair/purged-page-facts.ts expireBatch)
// ---------------------------------------------------------------------------------------------------------------------

/** Locks the named facts of the source for the rest of the transaction. */
export async function lockApprovedFacts(raw: EngineRawRead, sourceId: string, factIds: readonly number[]): Promise<void> {
  await raw('SELECT id FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) FOR UPDATE', [sourceId, [...factIds]]);
}

/** Expires the named unexpired facts of the source and clears their fence row number; the ids it expired. */
export async function expireApprovedFacts(raw: EngineRawRead, sourceId: string, factIds: readonly number[]): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(
    'UPDATE facts SET expired_at = now(), row_num = NULL WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL RETURNING id',
    [sourceId, [...factIds]]));
}

// ---------------------------------------------------------------------------------------------------------------------
// visibility (src/core/repair/visibility.ts tightenDatabaseFacts)
// ---------------------------------------------------------------------------------------------------------------------

/** Makes the named database-only world facts of the source private (the compare runs in the UPDATE); the ids it changed. */
export async function tightenDatabaseFactVisibility(raw: EngineRawRead, sourceId: string, factIds: readonly number[]): Promise<number[]> {
  return ids(await raw<{ id: number | string }>(
  `UPDATE facts SET visibility='private' WHERE source_id=$1 AND id=ANY($2::bigint[]) AND visibility='world' AND row_num IS NULL AND expired_at IS NULL RETURNING id`,
  [sourceId, [...factIds]]));
}

// ---------------------------------------------------------------------------------------------------------------------
// moved-pages (src/core/persistence/moved-pages.ts readMovedPage, the access comparison)
// ---------------------------------------------------------------------------------------------------------------------

/** Who may read a page: its derived readers, its folder rule ids, its `readable_by` and whether its snapshot is world. */
export interface PageAccessKey { id: number; readers: unknown; folder: unknown; readable_by: unknown; world: boolean }

/** The access key of each named page (the moved-pages fold compares two of them). */
export async function listPageAccessKeys(raw: EngineRawRead, pageIds: readonly number[]): Promise<PageAccessKey[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.page_readers AS readers, p.folder_rule_ids AS folder,
    p.frontmatter->'readable_by' AS readable_by, ${trustedSql(privateSnapshotFilterFragment('p'))} AS world FROM pages p WHERE p.id=ANY(${[...pageIds]}::int[])`);
  return raw<PageAccessKey>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// url-clone-fences (src/core/repair/url-clone-fences.ts keepRowsDatabaseOnly)
// ---------------------------------------------------------------------------------------------------------------------

/** Makes the fact at fence row `rowNum` of the page database-only (row and fence page cleared); the ids it changed. */
export async function detachFenceRowFacts(raw: EngineRawRead, sourceId: string, slug: string, rowNum: number): Promise<number[]> {
  return ids(await raw<{ id: number }>(
        'UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num = $3 RETURNING id',
        [sourceId, slug, rowNum]));
}

/** Whether the entity already holds a database-only fact with this exact claim text. */
export async function hasDatabaseOnlyClaim(raw: EngineRawRead, sourceId: string, entitySlug: string, fact: string): Promise<boolean> {
  return (await raw<{ id: number }>(
        'SELECT id FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL AND fact = $3 LIMIT 1', [sourceId, entitySlug, fact])).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The url-clone check (src/core/url-clone.ts urlCloneReadOnly)
// ---------------------------------------------------------------------------------------------------------------------

/** A source's checkout path and config, as `urlCloneReadOnly` reads them; null for an unknown source. */
export async function readSourceCloneRow(raw: EngineRawRead, sourceId: string): Promise<{ local_path: string | null; config: unknown } | null> {
  const [row] = await raw<{ local_path: string | null; config: unknown }>('SELECT local_path, config FROM sources WHERE id = $1', [sourceId]);
  return row ?? null;
}
