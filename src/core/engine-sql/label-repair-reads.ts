/**
 * The preview reads of `gbrain repair conversation-labels` (src/core/repair/conversation-labels.ts): the classified
 * candidate list, the segmented-page census and the active completion-marker check. Both SQL engines delegate here; the
 * Rust store serves the same members (rust/crates/gbrain-store/src/facts/label_repair.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** The sources and patterns of the label-fact reads. */
export interface LabelFactArgs {
  /** The segment extractor's source (`f.source = $`). */
  segmentSource: string;
  /** The metadata label line regular expression (`~*`). */
  labelLine: string;
  /** The two audit sources whose active stamped row marks a page as already decided. */
  terminalSource: string;
  nonExtractableSource: string;
}

/** One active segment-extractor fact on a live page with a label line, with the evidence the preview classifies it by. */
export interface LabelFactCandidateRow {
  id: number; source_id: string; slug: string; fact: string; context: string | null; entity_slug: string | null; visibility: string;
  superseded: boolean; withdrawn: boolean; referenced: boolean; open_loop: boolean; outcome_stamped: boolean;
}

/** One segmented live page with active, undecided segment-extractor facts, and how many. */
export interface SegmentedLabelPage { source_id: string; slug: string; n: number }

/** Every active segment-extractor fact of these sources (or of page `slug`) on a live page with a label line, in (source, page, id) order. */
export async function listLabelFactCandidates(raw: EngineRawRead, sourceIds: string[], slug: string | null, args: LabelFactArgs): Promise<LabelFactCandidateRow[]> {
  const rows = await raw<LabelFactCandidateRow>(`
    SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.fact, f.context, f.entity_slug, f.visibility,
           f.superseded_by IS NOT NULL AS superseded,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))
             AND (w.subject='*' OR w.subject=f.entity_slug)) AS withdrawn,
           EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id) AS referenced,
           EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) AS open_loop,
           EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug
             AND o.source IN ($3, $4) AND o.expired_at IS NULL AND o.context ~ 'extractor_version=[0-9]+$') AS outcome_stamped
      FROM facts f JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
     WHERE f.source_id=ANY($1::text[]) AND f.source=$5 AND f.expired_at IS NULL
       AND ($2::text IS NULL OR f.source_markdown_slug=$2::text)
       AND (p.compiled_truth ~* $6 OR COALESCE(p.timeline,'') ~* $6)
     ORDER BY f.source_id, f.source_markdown_slug, f.id`,
  [sourceIds, slug, args.terminalSource, args.nonExtractableSource, args.segmentSource, args.labelLine]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/** The segmented live pages of these sources with active segment-extractor facts no stamped audit row decided, in page id order. */
export async function listSegmentedLabelPages(raw: EngineRawRead, sourceIds: string[], args: Omit<LabelFactArgs, 'labelLine'>): Promise<SegmentedLabelPage[]> {
  return raw<SegmentedLabelPage>(`SELECT p.source_id, p.slug, count(*)::int AS n
        FROM facts f JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
       WHERE f.source_id=ANY($1::text[]) AND f.source=$2 AND f.expired_at IS NULL AND p.body_storage='segmented'
         AND NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug
             AND o.source IN ($3, $4) AND o.expired_at IS NULL AND o.context ~ 'extractor_version=[0-9]+$')
       GROUP BY p.id, p.source_id, p.slug ORDER BY p.id`, [sourceIds, args.segmentSource, args.terminalSource, args.nonExtractableSource]);
}

/** Whether page (`sourceId`, `slug`) holds an active fact of one of `sources` (the completion-marker audit sources). */
export async function hasActiveAuditMarker(raw: EngineRawRead, sourceId: string, slug: string, sources: readonly string[]): Promise<boolean> {
  const rows = await raw('SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source = ANY($3::text[]) AND expired_at IS NULL LIMIT 1',
    [sourceId, slug, [...sources]]);
  return rows.length > 0;
}
