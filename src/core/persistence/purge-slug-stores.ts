import type { BrainEngine } from '../engine.ts';

/** Each store keyed to a page by source and slug outside any foreign key, with its slug column, keyed as the purge receipt names it. */
const SLUG_STORES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['take_proposals', 'page_slug'], ['open_loops', 'page_slug'], ['core_edit_notices', 'slug'],
  ['page_aliases', 'slug'], ['slug_aliases', 'canonical_slug'], ['slug_rename_history', 'new_slug'],
];

/**
 * #9146: the six stores keyed to a page by source and slug with no foreign key to pages: proposed takes, open loops,
 * core-edit notices (which keep a copy of the page text), the page's free-text aliases, the redirects that resolve to
 * it and the rename rows that end at it (a redirect from this slug to another page stays). A purge's cascade never
 * reaches them, so every hard delete of a page calls this inside its transaction; a soft delete keeps them, because
 * restore_page can bring the page back. `ifPresent` skips a store the database does not have (a restored archive
 * older than it). Returns rows removed per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedSlugStores(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
  opts: { ifPresent?: boolean } = {},
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const removed: Record<string, number> = {};
  for (const [table, column] of SLUG_STORES) {
    if (opts.ifPresent) {
      const [present] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
      if (!present?.present) continue;
    }
    removed[table] = (await engine.executeRaw(`DELETE FROM ${table} WHERE source_id = $1 AND ${column} = ANY($2::text[]) RETURNING 1`, [sourceId, [...slugs]])).length;
  }
  return removed;
}

/**
 * #9146: the write-gate holds of hard-deleted pages and their receipts. An immediate hard delete drops every hold of
 * the slug, as the direct purge does. A tombstone expiry passes each page's `deletedAt` (text, so microseconds
 * survive) and drops only holds last seen up to it: a hold that arrived, or was re-opened by the same content
 * arriving again, after the soft delete is a later write, kept for review.
 */
export async function scrubPurgedSlugHolds(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  pages: ReadonlyArray<{ slug: string; deletedAt?: string | null }>,
): Promise<{ write_gate_holds: number; write_gate_receipts: number }> {
  if (!pages.length) return { write_gate_holds: 0, write_gate_receipts: 0 };
  const holds = (await engine.executeRaw<{ id: string }>(`DELETE FROM write_gate_holds h USING unnest($2::text[], $3::timestamptz[]) AS d(slug, upto)
    WHERE h.source_id = $1 AND h.slug = d.slug AND (d.upto IS NULL OR GREATEST(h.created_at, h.last_seen_at) <= d.upto) RETURNING h.id::text AS id`,
  [sourceId, pages.map(p => p.slug), pages.map(p => p.deletedAt ?? null)])).map(h => h.id);
  const receipts = holds.length ? (await engine.executeRaw("DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_holds' AND target_id = ANY($1::text[]) RETURNING 1", [holds])).length : 0;
  return { write_gate_holds: holds.length, write_gate_receipts: receipts };
}
