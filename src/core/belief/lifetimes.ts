/**
 * Page lifetimes (docs/designs/BELIEF_LEDGER.md section 3): the ledger's page
 * identity. Minted at a page's first need (its creation, baseline, or first
 * appearance as a link endpoint or entity), kept across a rename, ended by a
 * hard delete or a recreate at the same slug. `page_id` is a hint only: a
 * lifetime whose hint no longer matches the page at its slug belonged to a
 * page an untracked writer replaced, so it is ended and a new one minted.
 */
import type { BrainEngine } from '../engine.ts';

export interface PageRefNeed { sourceId: string; incarnation: string; slug: string; pageId: number }
interface LifetimeRow { page_lifetime: string; source_incarnation: string; slug: string; page_id: number | null }

const pairKey = (incarnation: string, slug: string) => `${incarnation}\u0000${slug}`;

export async function readOpenLifetimes(tx: Pick<BrainEngine, 'readOpenLifetimes'>, sourceId: string, needs: readonly { incarnation: string; slug: string }[]): Promise<Map<string, LifetimeRow>> {
  if (!needs.length) return new Map();
  const rows = await tx.readOpenLifetimes(sourceId, needs);
  return new Map(rows.map(row => [pairKey(row.source_incarnation, row.slug), { ...row, page_id: row.page_id == null ? null : Number(row.page_id) }]));
}

/** The open lifetimes of needs that may name pages of several sources (a link's endpoints), read one source at a time. */
export async function readOpenLifetimesOf(tx: Pick<BrainEngine, 'readOpenLifetimes'>, needs: readonly PageRefNeed[]): Promise<Map<string, LifetimeRow>> {
  const open = new Map<string, LifetimeRow>();
  for (const sourceId of new Set(needs.map(n => n.sourceId))) {
    for (const [key, row] of await readOpenLifetimes(tx, sourceId, needs.filter(n => n.sourceId === sourceId))) open.set(key, row);
  }
  return open;
}

export async function endLifetime(tx: Pick<BrainEngine, 'endLifetime'>, lifetime: string): Promise<void> {
  await tx.endLifetime(lifetime);
}

export function mintLifetime(tx: Pick<BrainEngine, 'mintLifetime'>, need: PageRefNeed): Promise<string> {
  return tx.mintLifetime(need);
}

export async function renameLifetime(tx: Pick<BrainEngine, 'renameLifetime'>, lifetime: string, slug: string, pageId: number): Promise<void> {
  await tx.renameLifetime(lifetime, slug, pageId);
}

/**
 * The open lifetime of each needed page, minting where none is open and
 * replacing one whose page hint names a different page. Pages the caller does
 * not hold the key of can be resolved here: minting is idempotent under the
 * open-lifetime unique index.
 */
export async function resolveLifetimes(tx: Pick<BrainEngine, 'readOpenLifetimes' | 'readMovedLifetimes' | 'endLifetime' | 'mintLifetime'>, needs: readonly PageRefNeed[]): Promise<Map<number, string>> {
  const unique = [...new Map(needs.map(n => [n.pageId, n])).values()];
  const open = await readOpenLifetimesOf(tx, unique);
  const out = new Map<number, string>();
  const misses = unique.filter(need => { const row = open.get(pairKey(need.incarnation, need.slug)); return !row || (row.page_id != null && row.page_id !== need.pageId); });
  // A page whose key the caller does not hold can be renamed between its read and this one (READ COMMITTED): an open lifetime of that page
  // at the slug the page has now is still its own, so it is used rather than minting a second one at the slug the caller read.
  const byPage = misses.length ? new Map((await tx.readMovedLifetimes(misses.map(n => n.pageId)))
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
