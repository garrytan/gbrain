/**
 * The belief ledger's orphan lifetime read (src/core/belief/coverage-report.ts `orphanLifetimes`) that ran through
 * `engine.executeRaw`, now a typed member so a Rust brain answers it from its store
 * (rust/docs/store/collate-belief-reads.md). The statement is the one the check ran, except that its limit is a bound
 * parameter (`$3`) instead of a number spliced into the text (the engine-sql dynamic-SQL guard).
 */

/** The engine's `executeRaw` (bound). */
export type BeliefReadsRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

export type OrphanReason = 'no_page' | 'no_lifetime';
export interface OrphanLifetimeSamples { count: number; samples: Array<{ slug: string; page_lifetime: string; reason: OrphanReason }> }

/** Open lifetimes with no page at their slug (an untracked hard delete), and (`deep`, a whole-ledger read) events naming a lifetime that does not exist. */
export async function listOrphanLifetimes(raw: BeliefReadsRaw, sourceId: string, limit: number, deep: boolean): Promise<OrphanLifetimeSamples> {
  const rows = await raw<{ slug: string; page_lifetime: string; reason: OrphanReason; total: number }>(`SELECT slug, page_lifetime, reason, count(*) OVER ()::int AS total FROM (
      SELECT l.slug, l.page_lifetime::text AS page_lifetime, 'no_page' AS reason FROM belief_page_lifetimes l JOIN sources s ON s.id = l.source_id AND s.incarnation = l.source_incarnation
      WHERE l.source_id = $1 AND l.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = l.source_id AND p.slug = l.slug)
      UNION ALL SELECT DISTINCT e.slug, e.page_lifetime::text, 'no_lifetime' FROM belief_events e
      WHERE $2::boolean AND e.source_id = $1 AND e.page_lifetime IS NOT NULL AND NOT EXISTS (SELECT 1 FROM belief_page_lifetimes l WHERE l.page_lifetime = e.page_lifetime)
    ) o ORDER BY slug COLLATE "C", page_lifetime COLLATE "C" LIMIT $3`, [sourceId, deep, Math.max(1, Math.floor(limit))]);
  return { count: Number(rows[0]?.total ?? 0), samples: rows.map(r => ({ slug: r.slug, page_lifetime: r.page_lifetime, reason: r.reason })) };
}
