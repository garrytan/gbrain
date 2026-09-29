/**
 * #5504 read side: the cross-source reference rule for facts and open-loop
 * rows. A connector source (e.g. a Google source) can store a fact or loop
 * row whose entity / counterparty slug names a page living in another
 * source (see `resolveConnectorEntitySlug`). Readers decide, at read time
 * and with no schema column, which page such a row refers to:
 *
 *   1. the page with that slug in the row's OWN source, when it is live;
 *   2. otherwise, when the row's source is non-archived and configured
 *      `federated: true` and the slug is a `people/` or `companies/` slug
 *      (`isCrossSourceEntitySlug`, the write side's bound), the page with
 *      that slug in the single other non-archived `federated: true` source
 *      that has it (the `isSourceFederated` inclusion rule);
 *   3. otherwise nothing (no page, or two or more federated pages: ambiguous).
 *
 * Only `federated: true` sources take part, in both directions: a source
 * with federation unset neither contributes rows nor receives them. The
 * write side (`crossSourceTargets` in `resolve.ts`) reads the same federated
 * set (`loadAllSources`), so an unset or archived writer never stores a
 * cross-source slug this side would ignore. Ambiguity is judged differently
 * (write: name candidates; read: federated sources holding the exact slug),
 * so a stored row can still be dropped as ambiguous, and is then logged.
 * Both directions live here so the entity card (which rows attach to a page)
 * and `open_loops` grouping (which page a row refers to) cannot drift apart.
 * Callers apply the rule for trusted local reads only; remote callers keep
 * their own source.
 */

import type { BrainEngine } from '../engine.ts';
import { loadAllSources } from '../sources-load.ts';
import { isCrossSourceEntitySlug } from './resolve.ts';

/** A page address: slugs are unique per `(source_id, slug)`. */
export interface PageRef {
  sourceId: string;
  slug: string;
}

/**
 * Most ambiguous slugs `resolveReferencedPages` names in its one log line;
 * the rest are counted, so a brain with many stranded slugs logs one bounded
 * line per `open_loops` call.
 */
export const AMBIGUOUS_SLUG_LOG_CAP = 10;

/**
 * Ids of the non-archived sources configured `federated: true`, through the
 * same loader the write side's `crossSourceTargets` uses, so the two sides
 * apply one rule.
 */
async function loadFederatedSources(engine: BrainEngine): Promise<Set<string>> {
  return new Set((await loadAllSources(engine, { federatedOnly: true })).map((row) => row.id));
}

/** `slug -> source ids` holding a live page with that slug, within `sourceIds`. */
async function livePageSources(
  engine: BrainEngine,
  sourceIds: string[],
  slugs: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (sourceIds.length === 0 || slugs.length === 0) return out;
  // source_id = ANY(...) keeps the lookup on pages_source_slug_key.
  const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT source_id, slug FROM pages
      WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND slug = ANY($2::text[])`,
    [sourceIds, slugs],
  );
  for (const row of rows) {
    let set = out.get(row.slug);
    if (!set) out.set(row.slug, (set = new Set()));
    set.add(row.source_id);
  }
  return out;
}

/**
 * Logs the active facts and open loops `storers` hold for `slug` that attach
 * to no card because two or more federated sources hold a live page for it.
 * The write side can still produce such rows (it resolves one name to one
 * page, the read side sees every federated page with the slug), so this is
 * the one place their loss is visible. Silent when no row is stranded.
 */
async function logAmbiguousRows(engine: BrainEngine, slug: string, holders: string[], storers: string[]): Promise<void> {
  if (storers.length === 0) return;
  const [row] = await engine.executeRaw<{ facts: string | number; loops: string | number }>(
    `SELECT (SELECT COUNT(*) FROM facts
              WHERE source_id = ANY($1::text[]) AND entity_slug = $2 AND expired_at IS NULL) AS facts,
            (SELECT COUNT(*) FROM open_loops
              WHERE source_id = ANY($1::text[]) AND counterparty_slug = $2 AND status = 'open') AS loops`,
    [storers, slug],
  );
  const facts = Number(row?.facts ?? 0);
  const loops = Number(row?.loops ?? 0);
  if (facts + loops === 0) return;
  console.error(
    `[gbrain] cross-source references ambiguous for slug=${slug}: live pages in federated sources ${holders.join(', ')}; `
      + `${facts} active fact(s) and ${loops} open loop(s) stored in other sources attach to no card`,
  );
}

/**
 * Other sources whose rows with entity / counterparty slug `page.slug` refer
 * to `page`, which the caller has already resolved as live. Empty unless
 * `page.slug` is a `people/` or `companies/` slug, `page.sourceId` is a
 * non-archived `federated: true` source, and no other such source holds a
 * live page for the slug (a storing source with its own page keeps its rows,
 * and makes the slug ambiguous for every other storer). Fail-soft: a read
 * error logs and yields `[]`, so the card degrades to its own source.
 */
export async function sourcesReferringTo(engine: BrainEngine, page: PageRef): Promise<string[]> {
  if (!isCrossSourceEntitySlug(page.slug)) return [];
  try {
    const federated = await loadFederatedSources(engine);
    if (!federated.has(page.sourceId)) return [];
    const others = [...federated].filter((id) => id !== page.sourceId);
    if (others.length === 0) return [];
    const holders = (await livePageSources(engine, others, [page.slug])).get(page.slug) ?? new Set<string>();
    if (holders.size > 0) {
      await logAmbiguousRows(engine, page.slug, [page.sourceId, ...holders], others.filter((id) => !holders.has(id)));
      return [];
    }
    return others;
  } catch (err) {
    console.error(
      `[gbrain] cross-source references skipped for source=${page.sourceId} slug=${page.slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * The page each stored `(source, slug)` row refers to under the rule above,
 * in input order: the ref itself when its own page is live, the single
 * federated page elsewhere, or `null`. Rows left unattached because two or
 * more federated pages hold their slug are logged. Fail-soft: a read error
 * logs and yields all `null`, so callers keep their per-slug behavior.
 */
export async function resolveReferencedPages(
  engine: BrainEngine,
  refs: PageRef[],
): Promise<Array<PageRef | null>> {
  if (refs.length === 0) return [];
  try {
    const federated = await loadFederatedSources(engine);
    const sourceIds = [...new Set([...refs.map((r) => r.sourceId), ...federated])];
    const slugs = [...new Set(refs.map((r) => r.slug))];
    const holders = await livePageSources(engine, sourceIds, slugs);
    const ambiguous = new Set<string>();
    let ambiguousRows = 0;
    const out = refs.map((ref) => {
      const live = holders.get(ref.slug);
      if (live?.has(ref.sourceId)) return ref;
      if (!live || !federated.has(ref.sourceId) || !isCrossSourceEntitySlug(ref.slug)) return null;
      const matches = [...federated].filter((id) => live.has(id));
      if (matches.length > 1) {
        ambiguous.add(ref.slug);
        ambiguousRows++;
      }
      return matches.length === 1 ? { sourceId: matches[0], slug: ref.slug } : null;
    });
    if (ambiguousRows > 0) {
      const named = [...ambiguous].slice(0, AMBIGUOUS_SLUG_LOG_CAP).join(', ');
      const more = ambiguous.size > AMBIGUOUS_SLUG_LOG_CAP ? ` and ${ambiguous.size - AMBIGUOUS_SLUG_LOG_CAP} more` : '';
      console.error(
        `[gbrain] cross-source references ambiguous for ${ambiguousRows} row(s) (slugs ${named}${more}): `
          + `live pages in two or more federated sources; they keep per-slug grouping`,
      );
    }
    return out;
  } catch (err) {
    console.error(
      `[gbrain] cross-source reference resolution skipped for ${refs.length} row(s): ${err instanceof Error ? err.message : String(err)}`,
    );
    return refs.map(() => null);
  }
}
