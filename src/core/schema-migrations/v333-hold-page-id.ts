import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Quarantine holds (`write_gate_holds`) remember their page's permanent id, so a rename can no longer lift them.
// Canonical DDL: src/core/write-gate-schema.ts (the forward-reference bootstrap in engine-sql/bootstrap.ts adds the two
// columns before the schema blob replays on a brain that predates them). This migration backfills the column by
// classifying every hold, never guessing, then moves the dedupe key to two disjoint partial indexes:
//   - exact: one page holds the hold's slug, it was created no later than the hold, its name never moved, and the
//     payload (a take hold names `page_id`) agrees: bound to that page;
//   - lineage: no page holds the slug and the rename record (slug_rename_history, which only exists from v285, and slug_aliases, which
//     also holds the older renames; chains followed) leads to exactly one surviving page: bound to it;
//   - payload-id: no page holds the slug, no history, and the payload names a page of the same source: bound to it;
//   - reused-name / two candidates: a page created after the hold now holds the slug, the name moved, or more than one
//     page qualifies: the hold stays unbound, `page_candidates` lists every candidate page, and the readers hold it
//     for each of them and for the page at its slug (`gbrain doctor` lists it for the owner);
//   - purged / never-a-page: no candidate: unbound, matched by slug as before.
// Holds the backfill binds to one page can collide on the new key (the same content held under two slugs the page had).
// Identical twins (same payload, tier, reasons and status) merge into the earliest one, adding their sightings and
// dropping the merged hold's receipt; a twin that differs in any way is never dropped: it stays a separate row, marked
// with the page as its only candidate, so it is held for that page and listed. The bound index is dropped first and
// rebuilt last, so a retried run (or a brain whose schema replay already built it) starts clean.
export const v333: Migration = {
  version: 333,
  name: 'hold_page_id',
  // Re-running must be safe: ADD COLUMN IF NOT EXISTS, a classification that only reads unclassified holds, and indexes rebuilt by name.
  idempotent: true,
  sql: `
ALTER TABLE write_gate_holds ADD COLUMN IF NOT EXISTS page_id BIGINT;
ALTER TABLE write_gate_holds ADD COLUMN IF NOT EXISTS page_candidates BIGINT[];
DROP INDEX IF EXISTS write_gate_holds_bound_dedupe_idx;
DROP INDEX IF EXISTS write_gate_holds_dedupe_idx;
WITH RECURSIVE rn AS (
  SELECT source_id, alias_slug AS old_slug, canonical_slug AS new_slug FROM slug_aliases
  UNION SELECT source_id, old_slug, new_slug FROM slug_rename_history
), h AS (
  SELECT id, source_id, slug, created_at,
    CASE WHEN (payload->>'page_id') ~ '^[0-9]{1,9}$' THEN (payload->>'page_id')::integer END AS payload_page
    FROM write_gate_holds WHERE page_id IS NULL AND page_candidates IS NULL
), agg AS (
  SELECT h.id,
    (SELECT p.id FROM pages p WHERE p.source_id = h.source_id AND p.slug = h.slug) AS cur_id,
    COALESCE((SELECT p.created_at <= h.created_at FROM pages p WHERE p.source_id = h.source_id AND p.slug = h.slug), false) AS cur_older,
    EXISTS (SELECT 1 FROM rn WHERE rn.source_id = h.source_id AND rn.old_slug = h.slug) AS moved,
    ARRAY(WITH RECURSIVE reach(s) AS (
        SELECT r.new_slug FROM rn r WHERE r.source_id = h.source_id AND r.old_slug = h.slug
        UNION SELECT r.new_slug FROM reach x JOIN rn r ON r.source_id = h.source_id AND r.old_slug = x.s)
      SELECT DISTINCT p.id FROM reach JOIN pages p ON p.source_id = h.source_id AND p.slug = reach.s AND p.deleted_at IS NULL) AS lineage,
    (SELECT p.id FROM pages p WHERE p.id = h.payload_page AND p.source_id = h.source_id) AS payload_id
    FROM h
), decided AS (
  SELECT id,
    CASE
      WHEN cur_id IS NOT NULL AND cur_older AND NOT moved AND (payload_id IS NULL OR payload_id = cur_id) THEN cur_id
      WHEN cur_id IS NULL AND cardinality(lineage) = 1 AND (payload_id IS NULL OR payload_id = lineage[1]) THEN lineage[1]
      WHEN cur_id IS NULL AND cardinality(lineage) = 0 AND payload_id IS NOT NULL THEN payload_id
    END AS bound,
    ARRAY(SELECT DISTINCT c FROM unnest(array_remove(ARRAY[cur_id, payload_id], NULL) || lineage) AS c ORDER BY c) AS cands
    FROM agg
)
UPDATE write_gate_holds w SET page_id = d.bound, page_candidates = CASE WHEN d.bound IS NULL THEN d.cands END
  FROM decided d WHERE w.id = d.id AND (d.bound IS NOT NULL OR cardinality(d.cands) > 0);
WITH keeper AS (
  SELECT DISTINCT ON (source_id, page_id, fingerprint, detector_version) id, source_id, page_id, fingerprint, detector_version, payload, status, tier, reason_families, reasons, detector_error
    FROM write_gate_holds WHERE page_id IS NOT NULL ORDER BY source_id, page_id, fingerprint, detector_version, id
), twin AS (
  SELECT k.id AS keep_id, w.id AS twin_id, w.seen_count, w.last_seen_at
    FROM keeper k JOIN write_gate_holds w ON w.source_id = k.source_id AND w.page_id = k.page_id AND w.fingerprint = k.fingerprint
      AND w.detector_version = k.detector_version AND w.id <> k.id
   WHERE w.payload = k.payload AND w.status = k.status AND w.tier = k.tier AND w.reason_families = k.reason_families
     AND w.reasons = k.reasons AND w.detector_error = k.detector_error
), summed AS (
  UPDATE write_gate_holds k SET seen_count = k.seen_count + t.seen, last_seen_at = GREATEST(k.last_seen_at, t.last_seen)
    FROM (SELECT keep_id, SUM(seen_count)::integer AS seen, MAX(last_seen_at) AS last_seen FROM twin GROUP BY keep_id) t WHERE k.id = t.keep_id
), receipts AS (
  DELETE FROM write_gate_receipts r USING twin WHERE r.target_table = 'write_gate_holds' AND r.target_id = twin.twin_id::text
)
DELETE FROM write_gate_holds w USING twin WHERE w.id = twin.twin_id;
UPDATE write_gate_holds w SET page_candidates = ARRAY[w.page_id], page_id = NULL
  WHERE w.page_id IS NOT NULL AND EXISTS (SELECT 1 FROM write_gate_holds k WHERE k.source_id = w.source_id AND k.page_id = w.page_id
    AND k.fingerprint = w.fingerprint AND k.detector_version = w.detector_version AND k.id < w.id);
CREATE UNIQUE INDEX IF NOT EXISTS write_gate_holds_bound_dedupe_idx ON write_gate_holds (source_id, page_id, fingerprint, detector_version) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS write_gate_holds_unbound_dedupe_idx ON write_gate_holds (source_id, slug, fingerprint, detector_version) WHERE page_id IS NULL AND page_candidates IS NULL;
CREATE INDEX IF NOT EXISTS write_gate_holds_page_idx ON write_gate_holds (source_id, page_id) WHERE status = 'held' AND page_id IS NOT NULL;
`,
};
