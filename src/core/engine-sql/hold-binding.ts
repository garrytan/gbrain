/**
 * Quarantine holds follow their page (`write_gate_holds.page_id`, schema in write-gate-schema.ts): the page-insert half.
 * A hold written before any page took its slug is unbound and matches by slug. When a page is first created at that slug
 * the same statement binds the holds that were already waiting for it, so a later rename cannot lift them. Only holds
 * created no later than the page, and not marked as candidates (the upgrade could not tie them to one page), are bound.
 * A hold whose slug the rename record already leads away from to another page that still exists is left unbound: its
 * page was renamed and this page only reused the name, so the hold keeps matching this page by slug and the renamed one
 * through the record (it may hide more than it covers, the safe side). The reach is the same walk as `holdReachCte` in
 * write-gate-binding.ts, written out here because engine-sql splices only constant text.
 * The bind is a data-modifying CTE of the page insert (`WITH ins AS (INSERT ... RETURNING ...), bound AS (UPDATE ...)`), not
 * a statement of its own, so a page insert costs the statements it cost before holds followed their page. The UPDATE reads
 * the new row from the insert's RETURNING (the statement's one snapshot does not show it in `pages`), which also makes the
 * reach check exclude it. A row an upsert only revived is not new (created_at differs from updated_at) and rebinds nothing.
 * The statement reads no lock beyond the hold rows it binds and is safe to run again.
 */
import { sqlFragment } from './fragment.ts';

/** The columns a page insert that binds holds returns (RETURNING), so the bind can read the new row from `ins`. */
export const HOLD_BIND_RETURNING = sqlFragment`id, source_id, slug, created_at, updated_at`;

/** The second CTE of a page insert named `ins`: binds the holds waiting for the page `ins` just created. Followed by a SELECT from `ins`. */
export const HOLD_BIND_CTE = sqlFragment`bound AS (
      UPDATE write_gate_holds h SET page_id = ins.id FROM ins
      WHERE ins.created_at = ins.updated_at AND h.source_id = ins.source_id AND h.slug = ins.slug AND h.page_id IS NULL AND h.page_candidates IS NULL
        AND h.created_at <= ins.created_at
        AND NOT EXISTS (
          WITH RECURSIVE reach(s) AS (SELECT h.slug UNION SELECT n.t FROM reach x JOIN LATERAL (
            SELECT a.canonical_slug AS t FROM slug_aliases a WHERE a.source_id = h.source_id AND a.alias_slug = x.s
            UNION SELECT r.new_slug FROM slug_rename_history r WHERE r.source_id = h.source_id AND r.old_slug = x.s) n ON true)
          SELECT 1 FROM reach JOIN pages q ON q.source_id = h.source_id AND q.slug = reach.s WHERE reach.s <> h.slug AND q.id <> ins.id)
      RETURNING h.id)`;
