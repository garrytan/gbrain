import type { SlugStoreScrubber } from '../engine-sql/purge-slug-stores.ts';

export type { SlugStoreScrubber };

/**
 * #9146: the six stores keyed to a page by source and slug with no foreign key to pages: proposed takes, open loops,
 * core-edit notices (which keep a copy of the page text), the page's free-text aliases, the redirects that resolve to
 * it and the rename rows that end at it (a redirect from this slug to another page stays). A purge's cascade never
 * reaches them, so every hard delete of a page calls this inside its transaction; a soft delete keeps them, because
 * restore_page can bring the page back. GST-2988: the page's secret store occurrences go too, and with them every
 * sealed original no other page or commit references (secret-store/store.ts purgeSecretsForSlugs), so a purge leaves
 * no original of a secret the page held. An occurrence still under a slug the page had before a rename goes by its
 * page: `pageIds` names pages whose rows are not deleted yet, `secretOccurrences` the occurrences pageSecretOccurrences
 * read for pages a caller has since deleted. `ifPresent` skips a store the database does not have (a restored archive
 * older than it). Returns rows removed per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedSlugStores(
  engine: SlugStoreScrubber,
  sourceId: string,
  slugs: readonly string[],
  opts: { ifPresent?: boolean; secretOccurrences?: readonly string[]; pageIds?: readonly number[] } = {},
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const { removed, secretStore } = await engine.deletePurgedSlugStoreRows(sourceId, slugs, { ifPresent: opts.ifPresent });
  if (secretStore) {
    const onPages = [...opts.secretOccurrences ?? [], ...(await pageSecretOccurrences(engine, opts.pageIds ?? [])).map(o => o.id)];
    const secrets = await (await import('../secret-store/store.ts')).purgeSecretsForSlugs(engine, sourceId, slugs, onPages);
    removed.secret_store_occurrence = secrets.occurrences;
    removed.secret_store = secrets.entries;
  } else if (!opts.ifPresent) {
    // A brain that keeps no secret store (the Rust engine) holds nothing to purge: the receipt still names both stores, at 0.
    removed.secret_store_occurrence = 0;
    removed.secret_store = 0;
  }
  return removed;
}

/**
 * The page-level occurrences of these pages, read before their rows are deleted: deleting a page sets its occurrences'
 * page_id to NULL, so one still under a slug the page had before a rename is found only this way. Pass the ids of pages the
 * delete removed to scrubPurgedSlugStores as `secretOccurrences`.
 */
export async function pageSecretOccurrences(engine: Pick<SlugStoreScrubber, 'listPageSecretOccurrences'>, pageIds: readonly number[]): Promise<Array<{ id: string; page_id: number }>> {
  return engine.listPageSecretOccurrences(pageIds);
}

/**
 * #9146: the write-gate holds of hard-deleted pages and their receipts. A page's holds are the ones bound to its id
 * (`id`, the purged row's id: they follow it whatever it was called) and, only the unbound ones, those at its slug. A
 * hold bound to another page is never touched, so a page that reused the name takes none of a renamed page's holds
 * with it. A hold the upgrade marked with candidate pages stays while any candidate survives (`dropPurgedCandidates`). An immediate hard delete drops every such hold, as the direct purge does. A tombstone expiry passes each
 * page's `deletedAt` (text, so microseconds survive) and drops only holds last seen up to it: a hold that arrived, or
 * was re-opened by the same content arriving again, after the soft delete is a later write, kept for review.
 */
export async function scrubPurgedSlugHolds(
  engine: Pick<SlugStoreScrubber, 'deletePurgedSlugHolds'>,
  sourceId: string,
  pages: ReadonlyArray<{ slug: string; id?: number | null; deletedAt?: string | null }>,
): Promise<{ write_gate_holds: number; write_gate_receipts: number }> {
  return engine.deletePurgedSlugHolds(sourceId, pages);
}
