/**
 * Page lifetimes (docs/designs/BELIEF_LEDGER.md section 3): the ledger's page
 * identity. Minted at a page's first need (its creation, baseline, or first
 * appearance as a link endpoint or entity), kept across a rename, ended by a
 * hard delete or a recreate at the same slug. `page_id` is a hint only: a
 * lifetime whose hint no longer matches the page at its slug belonged to a
 * page an untracked writer replaced, so it is ended and a new one minted.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export interface PageRefNeed { sourceId: string; incarnation: string; slug: string; pageId: number }
interface LifetimeRow { page_lifetime: string; source_incarnation: string; slug: string; page_id: number | null }

const pairKey = (incarnation: string, slug: string) => `${incarnation}\u0000${slug}`;

export async function readOpenLifetimes(tx: BrainEngine, needs: readonly { incarnation: string; slug: string }[]): Promise<Map<string, LifetimeRow>> {
  if (!needs.length) return new Map();
  const rows = await tx.executeRaw<LifetimeRow>(`SELECT l.page_lifetime::text AS page_lifetime, l.source_incarnation::text AS source_incarnation, l.slug, l.page_id
    FROM belief_page_lifetimes l JOIN unnest($1::uuid[], $2::text[]) AS n(i, s) ON l.source_incarnation = n.i AND l.slug = n.s
    WHERE l.ended_at IS NULL`, [needs.map(n => n.incarnation), needs.map(n => n.slug)]);
  return new Map(rows.map(row => [pairKey(row.source_incarnation, row.slug), { ...row, page_id: row.page_id == null ? null : Number(row.page_id) }]));
}

export async function endLifetime(tx: BrainEngine, lifetime: string): Promise<void> {
  await tx.executeRaw('UPDATE belief_page_lifetimes SET ended_at = clock_timestamp() WHERE page_lifetime = $1::uuid AND ended_at IS NULL', [lifetime]);
}

export async function mintLifetime(tx: BrainEngine, need: PageRefNeed): Promise<string> {
  const lifetime = randomUUID();
  const [row] = await tx.executeRaw<{ page_lifetime: string }>(`INSERT INTO belief_page_lifetimes (page_lifetime, source_id, source_incarnation, slug, page_id)
    VALUES ($1::uuid, $2, $3::uuid, $4, $5) ON CONFLICT (source_incarnation, slug) WHERE ended_at IS NULL DO NOTHING RETURNING page_lifetime::text AS page_lifetime`,
  [lifetime, need.sourceId, need.incarnation, need.slug, need.pageId]);
  if (row) return row.page_lifetime;
  const [existing] = await tx.executeRaw<{ page_lifetime: string }>(`SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes
    WHERE source_incarnation = $1::uuid AND slug = $2 AND ended_at IS NULL`, [need.incarnation, need.slug]);
  return existing!.page_lifetime;
}

export async function renameLifetime(tx: BrainEngine, lifetime: string, slug: string, pageId: number): Promise<void> {
  await tx.executeRaw('UPDATE belief_page_lifetimes SET slug = $2, page_id = $3 WHERE page_lifetime = $1::uuid', [lifetime, slug, pageId]);
}

/**
 * The open lifetime of each needed page, minting where none is open and
 * replacing one whose page hint names a different page. Pages the caller does
 * not hold the key of can be resolved here: minting is idempotent under the
 * open-lifetime unique index.
 */
export async function resolveLifetimes(tx: BrainEngine, needs: readonly PageRefNeed[]): Promise<Map<number, string>> {
  const unique = [...new Map(needs.map(n => [n.pageId, n])).values()];
  const open = await readOpenLifetimes(tx, unique);
  const out = new Map<number, string>();
  const misses = unique.filter(need => { const row = open.get(pairKey(need.incarnation, need.slug)); return !row || (row.page_id != null && row.page_id !== need.pageId); });
  // A page whose key the caller does not hold can be renamed between its read and this one (READ COMMITTED): an open lifetime of that page
  // at the slug the page has now is still its own, so it is used rather than minting a second one at the slug the caller read.
  const byPage = misses.length ? new Map((await tx.executeRaw<{ page_id: number; source_incarnation: string; page_lifetime: string }>(`SELECT l.page_id, l.source_incarnation::text AS source_incarnation,
      l.page_lifetime::text AS page_lifetime FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id AND p.slug = l.slug
      WHERE l.page_id = ANY($1::int[]) AND l.ended_at IS NULL`, [misses.map(n => n.pageId)]))
    .map(r => [`${r.source_incarnation}\u0000${Number(r.page_id)}`, r.page_lifetime])) : new Map<string, string>();
  for (const need of unique) {
    const row = open.get(pairKey(need.incarnation, need.slug));
    if (row && (row.page_id == null || row.page_id === need.pageId)) { out.set(need.pageId, row.page_lifetime); continue; }
    const moved = byPage.get(`${need.incarnation}\u0000${need.pageId}`);
    if (moved) { out.set(need.pageId, moved); continue; }
    if (row) await endLifetime(tx, row.page_lifetime);
    out.set(need.pageId, await mintLifetime(tx, need));
  }
  return out;
}
