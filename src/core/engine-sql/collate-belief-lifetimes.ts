/**
 * The belief ledger's page lifetime statements (src/core/belief/lifetimes.ts) that ran through `engine.executeRaw`, now
 * typed members so a Rust brain answers them from its store (rust/docs/store/collate-belief-lifetimes.md). Every statement
 * is the one its caller ran, except that `readOpenLifetimes` also filters on the source (`$3`): the incarnation names one
 * source, so the filter changes no answer on a SQL engine, and the Rust store keys its lifetimes by source.
 */
import { randomUUID } from 'node:crypto';

/** The engine's `executeRaw` (bound). */
export type BeliefLifetimesRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** One open lifetime: `page_id` is the hint the column keeps (a number, or digits from a driver that returns bigint text). */
export interface OpenLifetimeRow { page_lifetime: string; source_incarnation: string; slug: string; page_id: number | string | null }

/** A lifetime that still names a page now at its slug. */
export interface MovedLifetimeRow { page_id: number | string; source_incarnation: string; page_lifetime: string }

/** What a page needs of the ledger: its lifetime at (incarnation, slug). */
export interface LifetimeNeed { sourceId: string; incarnation: string; slug: string; pageId: number }

/** The open lifetime at each (incarnation, slug) of the source, as rows. */
export async function readOpenLifetimes(raw: BeliefLifetimesRaw, sourceId: string, pairs: readonly { incarnation: string; slug: string }[]): Promise<OpenLifetimeRow[]> {
  return raw<OpenLifetimeRow>(`SELECT l.page_lifetime::text AS page_lifetime, l.source_incarnation::text AS source_incarnation, l.slug, l.page_id
    FROM belief_page_lifetimes l JOIN unnest($1::uuid[], $2::text[]) AS n(i, s) ON l.source_incarnation = n.i AND l.slug = n.s
    WHERE l.ended_at IS NULL AND l.source_id = $3`, [pairs.map(n => n.incarnation), pairs.map(n => n.slug), sourceId]);
}

/** Closes a lifetime that is open. */
export async function endLifetime(raw: BeliefLifetimesRaw, lifetime: string): Promise<void> {
  await raw('UPDATE belief_page_lifetimes SET ended_at = clock_timestamp() WHERE page_lifetime = $1::uuid AND ended_at IS NULL', [lifetime]);
}

/** An open lifetime for the page at its (incarnation, slug), or the one already open there; returns its uuid. */
export async function mintLifetime(raw: BeliefLifetimesRaw, need: LifetimeNeed): Promise<string> {
  const lifetime = randomUUID();
  const [row] = await raw<{ page_lifetime: string }>(`INSERT INTO belief_page_lifetimes (page_lifetime, source_id, source_incarnation, slug, page_id)
    VALUES ($1::uuid, $2, $3::uuid, $4, $5) ON CONFLICT (source_incarnation, slug) WHERE ended_at IS NULL DO NOTHING RETURNING page_lifetime::text AS page_lifetime`,
  [lifetime, need.sourceId, need.incarnation, need.slug, need.pageId]);
  if (row) return row.page_lifetime;
  const [existing] = await raw<{ page_lifetime: string }>(`SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes
    WHERE source_incarnation = $1::uuid AND slug = $2 AND ended_at IS NULL`, [need.incarnation, need.slug]);
  return existing!.page_lifetime;
}

/** Moves a lifetime to a slug and page hint (the lifetime survives the page's rename). */
export async function renameLifetime(raw: BeliefLifetimesRaw, lifetime: string, slug: string, pageId: number): Promise<void> {
  await raw('UPDATE belief_page_lifetimes SET slug = $2, page_id = $3 WHERE page_lifetime = $1::uuid', [lifetime, slug, pageId]);
}

/** The open lifetimes whose page hint names a page that sits at the lifetime's slug now. */
export async function readMovedLifetimes(raw: BeliefLifetimesRaw, pageIds: readonly number[]): Promise<MovedLifetimeRow[]> {
  return raw<MovedLifetimeRow>(`SELECT l.page_id, l.source_incarnation::text AS source_incarnation,
      l.page_lifetime::text AS page_lifetime FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id AND p.slug = l.slug
      WHERE l.page_id = ANY($1::int[]) AND l.ended_at IS NULL`, [[...pageIds]]);
}
