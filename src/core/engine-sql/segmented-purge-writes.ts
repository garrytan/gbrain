/**
 * The writes a fact purge makes to a segmented page, and its read of saved inline version bodies, that ran through
 * `executeRaw` at their call sites: the generation flip's staging lock and its delete of chunk rows a dead preparation
 * staged (persistence/segmented-apply.ts applySegmentedBody), the delete of the derivation rows a rewritten segment may
 * hold (page-body/segment-derive.ts deleteRewrittenDerivations), and the purge's keyset read of inline versions
 * (facts/purge.ts rewriteVersionBodies). The statements are the call sites' text, byte for byte, so PGLite and Postgres
 * run what they ran; a store that is not SQL serves the same members (rust/crates/gbrain-store/src/segmented_purge.rs).
 * test/segmented-purge-writes-sql-pin.test.ts pins the text.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The state of a body staging, read under its row lock (`FOR UPDATE`), or null when no staging has that id. */
export async function lockBodyStagingState(tx: Raw, stagingId: string): Promise<string | null> {
  const [staging] = await tx.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid FOR UPDATE', [stagingId]);
  return staging?.state ?? null;
}

/** Deletes the page's chunk rows at `generation` whose chunk_index is not in `keepChunkIndexes` (a dead preparation's rows). */
export async function deleteUnstagedSegmentChunks(tx: Raw, pageId: number, generation: number, keepChunkIndexes: readonly number[]): Promise<void> {
  await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND body_generation=$2 AND NOT (chunk_index = ANY($3::int[]))',
    [pageId, generation, [...keepChunkIndexes]]);
}

/** What `deleteRewrittenSegmentDerivations` deletes: rows of the touched occurrences, links rows in reach, pipeline rows no live occurrence backs. */
export interface RewrittenDerivationsDelete {
  pageId: number;
  /** Every row of these occurrences (the rewritten runs). */
  touchedOccurrenceIds: readonly number[];
  /** The `links` rows of these occurrences (the runs within link reach of a rewritten one). */
  linkReachOccurrenceIds: readonly number[];
  /** The pipelines whose rows go when no live occurrence backs them. */
  pipelines: readonly string[];
  /** The page's live occurrences. */
  liveOccurrenceIds: readonly number[];
}

/** Deletes the derivation rows a rewritten segment may hold; answers how many it deleted. */
export async function deleteRewrittenSegmentDerivations(tx: Raw, spec: RewrittenDerivationsDelete): Promise<number> {
  return (await tx.executeRaw(`DELETE FROM page_segment_derivations WHERE page_id=$1
    AND (occurrence_id = ANY($2::bigint[]) OR (pipeline = 'links' AND occurrence_id = ANY($3::bigint[]))
      OR (pipeline = ANY($4::text[]) AND NOT (occurrence_id = ANY($5::bigint[])))) RETURNING 1`,
  [spec.pageId, [...spec.touchedOccurrenceIds], [...spec.linkReachOccurrenceIds], [...spec.pipelines], [...spec.liveOccurrenceIds]])).length;
}

/** The fact purge's read of saved inline version bodies: the versions of `pageIds`, or that carry the claim. */
export interface PurgeVersionBodyQuery {
  sourceId: string;
  /** The pages the purge rewrote: every inline version of them is read. */
  pageIds: readonly number[];
  /** Keyset: versions with an id over this one. */
  after: number;
  /** The claim, lowercased (purge-verify.ts claimNeedles). */
  needle: string;
  /** The claim as it reads in a lowercased frontmatter JSON text. */
  escaped: string;
}

export interface PurgeVersionBodyRow {
  id: number;
  slug: string;
  compiled_truth: string;
  timeline: string | null;
  /** The version's title or frontmatter carries the claim. */
  metadata: boolean;
}

/**
 * The purge's read, as facts/purge.ts rewriteVersionBodies built it for redactPageVersions (its `where` used
 * carriesClaimSql('v', 4)): parameters [sourceId, pageIds, after, needle, escaped], 5000 rows a batch.
 */
export const PURGE_VERSION_BODY_SQL = `SELECT v.id,p.slug,v.compiled_truth,v.timeline,
        (strpos(lower(COALESCE(v.title,'')),$4)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$5)>0) AS metadata
      FROM page_versions v JOIN pages p ON p.id=v.page_id
      WHERE p.source_id=$1 AND v.body_storage='inline' AND v.id>$3 AND (v.page_id=ANY($2::int[]) OR (strpos(lower(v.compiled_truth),$4)>0 OR strpos(lower(COALESCE(v.timeline,'')),$4)>0
  OR strpos(lower(COALESCE(v.title,'')),$4)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$5)>0))
      ORDER BY v.id LIMIT 5000`;

/** Reads one batch of the inline versions of the source that the purge redacts, in id order after `after`. */
export async function listPurgeVersionBodies(tx: Raw, query: PurgeVersionBodyQuery): Promise<PurgeVersionBodyRow[]> {
  return tx.executeRaw<PurgeVersionBodyRow>(PURGE_VERSION_BODY_SQL, [query.sourceId, [...query.pageIds], query.after, query.needle, query.escaped]);
}
