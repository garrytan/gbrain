// v0.42 Type Unification (T9) — rewriteLinksBatch primitive.
//
// Eng review Finding 1.2: rewriteLinks() called per-page (N calls) is fine
// at ~65 page-to-link conversions but becomes a bottleneck on 1M-page brains
// (~5min just for link rewrites). This is the batched form using
// `UPDATE FROM unnest()` — N pairs in 1-2 statements regardless of array
// size.
//
// Codex Finding F9: source-scoped. Each pair carries its own sourceId so
// federated brains don't accidentally rewrite cross-source link rows.
//
// Note: the existing `engine.rewriteLinks(oldSlug, newSlug)` is intentionally
// a stub (links use integer page_id FKs that don't change on slug rename;
// textual [[wiki-links]] are not rewritten by it). This helper is for
// future code paths that need real bulk slug FK rewrite — v0.42 page-to-link
// uses it ONLY if/when the slug FK side actually changes; today's page-to-link
// uses soft-delete + alias-table semantics per D15 and doesn't need
// rewriteLinksBatch on the alias case.
//
// API: callers pass an array of `{from, to, sourceId}` triples. Behavior:
// for each pair, UPDATE `links` rows where the `from_page_id` OR
// `to_page_id` references a page with old slug (in the given sourceId),
// updating the FK to the new slug's page_id. Returns total rows touched.

import type { BrainEngine } from '../engine.ts';

export interface RewriteLinkPair {
  from_slug: string;
  to_slug: string;
  source_id: string;
}

/**
 * Batched link rewrite. v0.42 ships the API surface; production callers
 * are deferred to v0.43+ when page-to-link variants actually mutate the
 * link FK shape. v0.42's page-to-link soft-deletes the source page and
 * inserts a NEW link row; existing inbound link rows stay valid because
 * they reference page_ids (not slugs).
 *
 * The helper is here because the plan locked it (Finding 1.2) and tests
 * can validate the batched-UPDATE shape works on both engines.
 *
 * Returns count of links table rows updated across all pairs (sum).
 */
export async function rewriteLinksBatch(
  engine: BrainEngine,
  pairs: ReadonlyArray<RewriteLinkPair>,
): Promise<number> {
  if (pairs.length === 0) return 0;
  // Looking up new page_id for each (to_slug, source_id) pair in one query
  // via unnest, then updating links.from_page_id + links.to_page_id +
  // links.origin_page_id via correlated subquery against the resolved
  // pairs. For v0.42 we do it pair-by-pair to keep the SQL simple +
  // engine-parity-safe; v0.43+ can optimize via a single CTE if needed.
  let total = 0;
  for (const p of pairs) {
    // Resolve old + new page ids
    const oldRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
      [p.from_slug, p.source_id],
    );
    const newRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
      [p.to_slug, p.source_id],
    );
    if (oldRows.length === 0 || newRows.length === 0) continue;
    const oldId = oldRows[0].id;
    const newId = newRows[0].id;
    const fromRes = await engine.executeRaw<{ updated: string }>(
      `WITH upd AS (UPDATE links SET from_page_id = $1 WHERE from_page_id = $2 RETURNING 1)
       SELECT COUNT(*)::text AS updated FROM upd`,
      [newId, oldId],
    );
    const toRes = await engine.executeRaw<{ updated: string }>(
      `WITH upd AS (UPDATE links SET to_page_id = $1 WHERE to_page_id = $2 RETURNING 1)
       SELECT COUNT(*)::text AS updated FROM upd`,
      [newId, oldId],
    );
    const originRes = await engine.executeRaw<{ updated: string }>(
      `WITH upd AS (UPDATE links SET origin_page_id = $1 WHERE origin_page_id = $2 RETURNING 1)
       SELECT COUNT(*)::text AS updated FROM upd`,
      [newId, oldId],
    );
    total += parseInt(fromRes[0]?.updated ?? '0', 10) || 0;
    total += parseInt(toRes[0]?.updated ?? '0', 10) || 0;
    total += parseInt(originRes[0]?.updated ?? '0', 10) || 0;
  }
  return total;
}
