/**
 * Quarantine holds follow their page (`write_gate_holds.page_id`, schema in write-gate-schema.ts): the page-insert half.
 * A hold written before any page took its slug is unbound and matches by slug. When a page is first created at that slug
 * the same transaction binds the holds that were already waiting for it, so a later rename cannot lift them. Only holds
 * created no later than the page, and not marked as candidates (the upgrade could not tie them to one page), are bound.
 * A hold whose slug the rename record already leads away from to another page that still exists is left unbound: its
 * page was renamed and this page only reused the name, so the hold keeps matching this page by slug and the renamed one
 * through the record (it may hide more than it covers, the safe side). The reach is the same walk as `holdReachCte` in
 * write-gate-binding.ts, written out here because engine-sql splices only constant text.
 * The statement reads no lock and is safe to run again.
 */
import { sqlFragment } from './fragment.ts';
import type { SqlExecutor } from './executor.ts';

export async function bindHoldsToNewPage(exec: SqlExecutor, pageId: number): Promise<void> {
  await exec.run(sqlFragment`UPDATE write_gate_holds h SET page_id = p.id FROM pages p
    WHERE p.id = ${pageId} AND h.source_id = p.source_id AND h.slug = p.slug AND h.page_id IS NULL AND h.page_candidates IS NULL
      AND h.created_at <= p.created_at 
      AND NOT EXISTS (
        WITH RECURSIVE reach(s) AS (SELECT h.slug UNION SELECT n.t FROM reach x JOIN LATERAL (
          SELECT a.canonical_slug AS t FROM slug_aliases a WHERE a.source_id = h.source_id AND a.alias_slug = x.s
          UNION SELECT r.new_slug FROM slug_rename_history r WHERE r.source_id = h.source_id AND r.old_slug = x.s) n ON true)
        SELECT 1 FROM reach JOIN pages q ON q.source_id = h.source_id AND q.slug = reach.s WHERE reach.s <> h.slug AND q.id <> p.id)`);
}

/** True when a page row came back from the upsert as a new row: an insert sets created_at and updated_at to the same now(). */
export function pageRowIsNew(row: Record<string, unknown> | undefined): boolean {
  if (!row?.created_at || !row.updated_at) return false;
  return new Date(row.created_at as string).getTime() === new Date(row.updated_at as string).getTime();
}
