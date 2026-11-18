/**
 * Storage for wanted pages (see src/core/wanted-links.ts). Kept free of the
 * link-extraction import graph because derived-links.ts, which every engine
 * imports, calls it inside the derived-link replacement transaction.
 */
import type { BrainEngine } from './engine.ts';
import type { WantedPageRow } from './engine-sql/cli-reads-ops.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import { validateSlug } from './utils.ts';

export type WantedProducer = 'body' | 'frontmatter';

export interface WantedLinkInput {
  producer: WantedProducer;
  ref_kind: 'slug' | 'name';
  target_source_id: string;
  target_ref: string;
  link_type: string;
  context: string;
}

export interface WantedLinksReplacement {
  rows: WantedLinkInput[];
  /** Producers whose rows this replacement owns; others stay untouched. */
  producers: readonly WantedProducer[];
  /**
   * wantedReadAt() taken before the extraction's first resolution read. Every
   * `name` row is stamped with it, so a page written after that read wakes the
   * origin and one the read already saw does not. Required when rows has a name.
   */
  readAt?: string;
}

/** The database clock as a UTC ISO string with microseconds, independent of the session's DateStyle. */
export async function wantedReadAt(engine: Pick<BrainEngine, 'readDatabaseClock'>): Promise<string> {
  return engine.readDatabaseClock();
}

/**
 * #6228/#6225: the rows whose target can become a page. A slug target must
 * pass validateSlug (a regex literal on a code page read as a wikilink does
 * not) and every target must be in a registered source (a `[[memory:123]]`
 * citation names none). Any other row names no possible page; locking it
 * would throw and abort the caller's whole extraction transaction. Foreign
 * sources are read `FOR SHARE`, so one cannot disappear between this check
 * and the page-guard lock; the origin's own source needs no read.
 */
export async function possibleWantedRows<T extends Pick<WantedLinkInput, 'ref_kind' | 'target_source_id' | 'target_ref'>>(
  tx: Pick<BrainEngine, 'lockRegisteredSourceIds'>, originSourceId: string, rows: readonly T[],
): Promise<T[]> {
  const shaped = rows.filter(row => row.ref_kind !== 'slug' || pageSlugShaped(row.target_ref));
  const foreign = [...new Set(shaped.map(row => row.target_source_id).filter(id => id !== originSourceId))];
  if (!foreign.length) return shaped;
  const registered = new Set(await tx.lockRegisteredSourceIds(foreign));
  return shaped.filter(row => row.target_source_id === originSourceId || registered.has(row.target_source_id));
}

function pageSlugShaped(target: string): boolean {
  try { validateSlug(target); return true; } catch { return false; } // a refused slug is the answer, not an error
}

/**
 * Replace one origin's wanted rows inside the caller's transaction (the same
 * one that replaces its derived links), keeping only possibleWantedRows. Slug targets are locked first, so a
 * concurrent writer creating the target either committed before this check
 * (and the row is stamped `-infinity`, leaving the origin stale) or commits
 * after it with an `updated_at` past `checked_at`. A bare-name reference may
 * legitimately stay unresolved while a page has its exact slug or basename
 * (basename resolution is opt-in, and a directory hint can skip a top-level
 * slug), so it is stamped with the caller's read time instead: a page written
 * after that read wakes the origin once, and the next extraction settles it.
 */
export async function replaceWantedLinks(
  tx: Pick<BrainEngine, 'lockRegisteredSourceIds' | 'lockPageKeys' | 'replaceWantedLinkRows'>,
  origin: { pageId: number; sourceId: string },
  replacement: WantedLinksReplacement,
): Promise<number> {
  if (!replacement.producers.length) return 0;
  if (!replacement.readAt && replacement.rows.some(row => row.ref_kind === 'name')) {
    throw new Error('replaceWantedLinks: name rows need the readAt taken before the extraction read');
  }
  const rows = (await possibleWantedRows(tx, origin.sourceId,
    replacement.rows.filter(row => replacement.producers.includes(row.producer))))
    .map(row => ({ ...row, context: sanitizeForJsonb(row.context) }));
  const slugTargets = rows.filter(row => row.ref_kind === 'slug')
    .map(row => ({ sourceId: row.target_source_id, slug: row.target_ref }));
  if (slugTargets.length) await tx.lockPageKeys(slugTargets);
  return tx.replaceWantedLinkRows(origin, { rows, producers: replacement.producers, readAt: replacement.readAt });
}

export type { WantedPageRow } from './engine-sql/cli-reads-ops.ts';

/**
 * Missing link targets, most-referenced first. Scope applies to the origin
 * pages (the caller's readable sources) and, when `excludePrivate`, private
 * origins are removed BEFORE aggregation so a private page never reveals a
 * target name or contributes to a count. Soft-deleted origins never count.
 * The engine member returns the rows in this shape (engine-sql/cli-reads-ops.ts).
 */
export function listWantedPages(engine: Pick<BrainEngine, 'listWantedPages'>, opts: {
  sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean;
  limit: number; offset: number;
}): Promise<{ total: number; rows: WantedPageRow[] }> {
  return engine.listWantedPages(opts);
}
