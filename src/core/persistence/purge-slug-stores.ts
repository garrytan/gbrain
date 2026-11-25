import type { BrainEngine } from '../engine.ts';
import { dropPurgedCandidates, holdOwnedByDeletedPageSql, noteKeptHoldsCte } from '../write-gate-binding.ts';

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
 * restore_page can bring the page back. GST-2988: the page's secret store occurrences go too, and with them every
 * sealed original no other page or commit references (secret-store/store.ts purgeSecretsForSlugs), so a purge leaves
 * no original of a secret the page held. An occurrence still under a slug the page had before a rename goes by its
 * page: `pageIds` names pages whose rows are not deleted yet, `secretOccurrences` the occurrences pageSecretOccurrences
 * read for pages a caller has since deleted. `ifPresent` skips a store the database does not have (a restored archive
 * older than it). Returns rows removed per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedSlugStores(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
  opts: { ifPresent?: boolean; secretOccurrences?: readonly string[]; pageIds?: readonly number[] } = {},
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
  const [store] = opts.ifPresent ? await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('secret_store_occurrence') IS NOT NULL AS present") : [{ present: true }];
  if (store?.present) {
    const onPages = [...opts.secretOccurrences ?? [], ...(await pageSecretOccurrences(engine, opts.pageIds ?? [])).map(o => o.id)];
    const secrets = await (await import('../secret-store/store.ts')).purgeSecretsForSlugs(engine, sourceId, slugs, onPages);
    removed.secret_store_occurrence = secrets.occurrences;
    removed.secret_store = secrets.entries;
  }
  return removed;
}

/**
 * The page-level occurrences of these pages, read before their rows are deleted: deleting a page sets its occurrences'
 * page_id to NULL, so one still under a slug the page had before a rename is found only this way. Pass the ids of pages the
 * delete removed to scrubPurgedSlugStores as `secretOccurrences`.
 */
export async function pageSecretOccurrences(engine: Pick<BrainEngine, 'executeRaw'>, pageIds: readonly number[]): Promise<Array<{ id: string; page_id: number }>> {
  if (!pageIds.length) return [];
  return engine.executeRaw<{ id: string; page_id: number }>('SELECT id::text AS id, page_id FROM secret_store_occurrence WHERE page_id = ANY($1::int[]) AND commit_sha IS NULL', [[...pageIds]]);
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
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  pages: ReadonlyArray<{ slug: string; id?: number | null; deletedAt?: string | null }>,
): Promise<{ write_gate_holds: number; write_gate_receipts: number }> {
  if (!pages.length) return { write_gate_holds: 0, write_gate_receipts: 0 };
  // One statement: the holds kept for another page are noted in the delete decision's own snapshot (write-gate-binding.ts),
  // once the notes table exists (a brain whose v337 migration has not run yet still purges).
  const upto = '(d.upto IS NULL OR GREATEST(h.created_at, h.last_seen_at) <= d.upto)';
  const [notes] = await engine.executeRaw<{ ok: boolean }>("SELECT pg_catalog.to_regclass('write_gate_hold_rechecks') IS NOT NULL AS ok");
  const noted = notes?.ok ? `, ${noteKeptHoldsCte('$1', 'd.id', 'd.slug', q => `EXISTS (SELECT 1 FROM d WHERE d.id = ${q}.id)`, 'FROM d', upto)}` : '';
  const holds: string[] = (await engine.executeRaw<{ id: string }>(`WITH d AS (SELECT * FROM unnest($2::text[], $3::bigint[], $4::timestamptz[]) AS d(slug, id, upto))${noted}
    DELETE FROM write_gate_holds h USING d
    WHERE h.source_id = $1 AND ${holdOwnedByDeletedPageSql('h', 'd.id', 'd.slug')} AND ${upto} RETURNING h.id::text AS id`,
  [sourceId, pages.map(p => p.slug), pages.map(p => p.id ?? null), pages.map(p => p.deletedAt ?? null)])).map(h => h.id);
  holds.push(...await dropPurgedCandidates(engine, sourceId, pages));
  const receipts = holds.length ? (await engine.executeRaw("DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_holds' AND target_id = ANY($1::text[]) RETURNING 1", [holds])).length : 0;
  return { write_gate_holds: holds.length, write_gate_receipts: receipts };
}
