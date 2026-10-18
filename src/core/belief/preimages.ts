/**
 * The preimage invariant page-at-time rests on (docs/designs/BELIEF_LEDGER.md
 * section 14, item 8): every publication that moves a page's knowledge revision
 * leaves a `page_versions` row holding the revision it started from
 * (`revision_before`), written in the same transaction. Revisions a
 * transaction only passes through are never a ledger state, so they need none.
 * A large or segmented page is exempt: its versions are pruned on their own
 * policy, and page-at-time discloses those bodies as pruned.
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';

export interface PreimageNeed { pageId: number; slug: string; revision: string }

/** The needs with no version of their starting revision on their page. */
export async function missingPreimages(engine: Pick<BrainEngine, 'executeRaw'>, needs: readonly PreimageNeed[]): Promise<PreimageNeed[]> {
  if (!needs.length) return [];
  const rows = await engine.executeRaw<{ i: number }>(`SELECT n.i FROM unnest($1::bigint[], $2::uuid[]) WITH ORDINALITY AS n(page_id, revision, i)
    WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = n.page_id AND v.knowledge_revision = n.revision)`,
  [needs.map(n => n.pageId), needs.map(n => n.revision)]);
  return rows.map(r => needs[Number(r.i) - 1]!);
}

/** Test runs enforce the invariant inside every belief batch; `GBRAIN_BELIEF_PREIMAGE_CHECK=0` turns it off for a probe that breaks it on purpose. */
export const preimageInvariantEnforced = (): boolean => process.env.NODE_ENV === 'test' && process.env.GBRAIN_BELIEF_PREIMAGE_CHECK !== '0';

export interface PreimageGap { event_id: number; slug: string; event_type: string; revision: string; recorded_at: string }

/**
 * Doctor's scan: page events whose `revision_before` no version of the live page holds, on a page whose
 * versions are never pruned. Bounded to the last `windowDays` unless `deep`.
 */
export async function preimageGaps(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, opts: { limit?: number; deep?: boolean; windowDays?: number } = {}): Promise<PreimageGap[]> {
  const rows = await engine.executeRaw<PreimageGap>(`SELECT e.id AS event_id, e.slug, e.event_type, e.value->>'revision_before' AS revision, e.recorded_at
    FROM belief_events e
    JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    JOIN belief_page_lifetimes l ON l.page_lifetime = e.page_lifetime
    JOIN pages p ON p.id = l.page_id AND p.source_id = e.source_id
    WHERE e.source_id = $1 AND e.subject_kind = 'page' AND NOT e.purged AND e.origin IN ('live', 'unmanaged')
      AND ($2::boolean OR e.recorded_at > now() - make_interval(days => $3::int))
      AND e.value->>'revision_before' IS NOT NULL AND e.value->>'revision_before' IS DISTINCT FROM e.value->>'revision_after'
      AND p.body_storage IS DISTINCT FROM 'segmented'
      AND COALESCE(p.body_bytes, octet_length(COALESCE(p.compiled_truth, '')) + octet_length(COALESCE(p.timeline, ''))) <= $4
      AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = p.id AND (v.body_storage = 'segmented'
        OR COALESCE(v.body_bytes, octet_length(COALESCE(v.compiled_truth, '')) + octet_length(COALESCE(v.timeline, ''))) > $4))
      AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = p.id AND v.knowledge_revision = (e.value->>'revision_before')::uuid)
    ORDER BY e.id DESC LIMIT ${Math.max(1, Math.floor(opts.limit ?? 100))}`, [sourceId, opts.deep === true, opts.windowDays ?? 30, PAGE_INLINE_MAX_BYTES]);
  return rows.map(r => ({ ...r, event_id: Number(r.event_id), recorded_at: new Date(r.recorded_at).toISOString() }));
}
