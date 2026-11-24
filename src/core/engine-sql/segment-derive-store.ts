/**
 * Two statements of the segmented page path, each with the text and parameters its caller ran through `executeRaw`;
 * only their home moved: whether a segmented page's text projection is sealed (persistence/searchable.ts
 * segmentedPageSearchable, after a segmented import or write) and the derive pass's conditional store of run outputs
 * (page-body/segment-derive.ts storeRuns, the mention pass's segmented scan). The Rust engine answers them from its
 * page body store (rust/crates/gbrain-store/src/page_body.rs, rust/docs/store/mention-state.md).
 */
import type { MentionRaw } from './mention-pass.ts';

/** One derivation row the derive pass stores: its pipeline, occurrence, version, hashes (hex) and output. */
export interface SegmentDerivationStoreRow {
  pipeline: string; occurrence_id: number; pipeline_version: number; segment_sha256: string; context_hash: string; output: unknown;
}

/**
 * Upsert `rows` as `done` derivations of the page while it is live, segmented and at body `generation` (row-locked FOR
 * SHARE); returns how many were written (none when the page moved).
 */
export async function storeSegmentDerivationsIfLive(raw: MentionRaw, pageId: number, generation: number, rows: readonly SegmentDerivationStoreRow[]): Promise<number> {
  const written = await raw.executeRaw(`WITH live AS (SELECT id FROM pages WHERE id=$1 AND body_storage='segmented' AND body_generation=$2 FOR SHARE)
      INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      SELECT live.id, d.pipeline, d.occurrence_id, d.pipeline_version, decode(d.segment_sha256, 'hex'), decode(d.context_hash, 'hex'), 'done', d.output, NULL
      FROM live, jsonb_to_recordset($3::text::jsonb) AS d(pipeline text, occurrence_id bigint, pipeline_version int, segment_sha256 text, context_hash text, output jsonb)
      ON CONFLICT (page_id, pipeline, occurrence_id) DO UPDATE SET pipeline_version = EXCLUDED.pipeline_version, segment_sha256 = EXCLUDED.segment_sha256,
        context_hash = EXCLUDED.context_hash, state = EXCLUDED.state, output = EXCLUDED.output, receipt = EXCLUDED.receipt, updated_at = now()
      RETURNING 1`, [pageId, generation, JSON.stringify(rows)]);
  return written.length;
}
