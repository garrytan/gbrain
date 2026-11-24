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
