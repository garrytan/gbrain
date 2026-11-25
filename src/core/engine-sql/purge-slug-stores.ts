/**
 * #9146: the statements a page hard delete runs on the stores keyed to the page by source and slug with no foreign key
 * to pages (persistence/purge-slug-stores.ts orchestrates them, with the secret store purge). Each ran through
 * `executeRaw`; SQL once for both engines, so the Rust store can serve the same members once it scrubs those stores.
 *
 * Every function takes the engine (or transaction) it runs on. Counts come back as numbers.
 */
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { dropPurgedCandidates, holdOwnedByDeletedPageSql, noteKeptHoldsCte } from '../write-gate-binding.ts';
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The delete of each store keyed to a page by source and slug outside any foreign key (its slug column named in the
 * statement), keyed as the purge receipt names the store. Static text: `$1` the source, `$2` the slugs.
 */
const SLUG_STORE_DELETES = {
  take_proposals: 'DELETE FROM take_proposals WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1',
  open_loops: 'DELETE FROM open_loops WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1',
  core_edit_notices: 'DELETE FROM core_edit_notices WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1',
  page_aliases: 'DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1',
  slug_aliases: 'DELETE FROM slug_aliases WHERE source_id = $1 AND canonical_slug = ANY($2::text[]) RETURNING 1',
  slug_rename_history: 'DELETE FROM slug_rename_history WHERE source_id = $1 AND new_slug = ANY($2::text[]) RETURNING 1',
} as const;

/** The stores deletePurgedSlugStoreRows scrubs, in the order it scrubs them. */
export const SLUG_STORES = Object.keys(SLUG_STORE_DELETES) as ReadonlyArray<keyof typeof SLUG_STORE_DELETES>;

/** What deletePurgedSlugStoreRows removed: rows per store, and whether the database has the secret store. */
export interface PurgedSlugStoreRows {
  removed: Record<string, number>;
  /** False only under `ifPresent` when `secret_store_occurrence` does not exist. */
  secretStore: boolean;
}

/**
 * Deletes the rows of `slugs` in `sourceId` from each of SLUG_STORES. `ifPresent` skips a store the database does not
 * have (a restored archive older than it) and reports whether the secret store exists; without it every store is
 * assumed present.
 */
export async function deletePurgedSlugStoreRows(
  tx: Raw, sourceId: string, slugs: readonly string[], opts: { ifPresent?: boolean } = {},
): Promise<PurgedSlugStoreRows> {
  const removed: Record<string, number> = {};
  const present = async (table: string) =>
    !opts.ifPresent || !!(await tx.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]))[0]?.present;
  if (!slugs.length) return { removed, secretStore: await present('secret_store_occurrence') };
  for (const table of SLUG_STORES) {
    if (!await present(table)) continue;
    removed[table] = (await tx.executeRaw(SLUG_STORE_DELETES[table], [sourceId, [...slugs]])).length;
  }
  return { removed, secretStore: await present('secret_store_occurrence') };
}

/** The page-level secret store occurrences (no commit) of these pages, read before their rows are deleted. */
export async function listPageSecretOccurrences(tx: Raw, pageIds: readonly number[]): Promise<Array<{ id: string; page_id: number }>> {
  if (!pageIds.length) return [];
  return tx.executeRaw<{ id: string; page_id: number }>(
    'SELECT id::text AS id, page_id FROM secret_store_occurrence WHERE page_id = ANY($1::int[]) AND commit_sha IS NULL', [[...pageIds]]);
}

/**
 * Deletes the write-gate holds of these pages and the holds' receipts. A page's holds are the ones bound to its id (`id`,
 * the purged row's id: they follow it whatever it was called) and, only the unbound ones, those at its slug; a hold bound to
 * another page is never touched, and a candidate-marked hold stays while a candidate survives (`dropPurgedCandidates`). A page
 * with `deletedAt` (text, so microseconds survive) loses only holds last seen up to it; one without loses every such hold.
 */
export async function deletePurgedSlugHolds(
  tx: Raw, sourceId: string, pages: ReadonlyArray<{ slug: string; id?: number | null; deletedAt?: string | null }>,
): Promise<{ write_gate_holds: number; write_gate_receipts: number }> {
  if (!pages.length) return { write_gate_holds: 0, write_gate_receipts: 0 };
  // One statement: the holds kept for another page are noted in the delete decision's own snapshot (write-gate-binding.ts),
  // once the notes table exists (a brain whose v337 migration has not run yet still purges).
  const upto = '(d.upto IS NULL OR GREATEST(h.created_at, h.last_seen_at) <= d.upto)';
  const [notes] = await tx.executeRaw<{ ok: boolean }>("SELECT pg_catalog.to_regclass('write_gate_hold_rechecks') IS NOT NULL AS ok");
  const noted = notes?.ok ? `, ${noteKeptHoldsCte('(SELECT id FROM s)', 'd.id', 'd.slug', q => `EXISTS (SELECT 1 FROM d WHERE d.id = ${q}.id)`, 'FROM d', upto)}` : '';
  const { text, params } = renderFragment(sqlFragment`WITH s(id) AS (SELECT ${sourceId}::text), d AS (SELECT * FROM unnest(${pages.map(p => p.slug)}::text[], ${pages.map(p => p.id ?? null)}::bigint[], ${pages.map(p => p.deletedAt ?? null)}::timestamptz[]) AS d(slug, id, upto))${trustedSql(noted)}
    DELETE FROM write_gate_holds h USING d
    WHERE h.source_id = (SELECT id FROM s) AND ${trustedSql(holdOwnedByDeletedPageSql('h', 'd.id', 'd.slug'))} AND ${trustedSql(upto)} RETURNING h.id::text AS id`);
  const holds: string[] = (await tx.executeRaw<{ id: string }>(text, params)).map(h => h.id);
  holds.push(...await dropPurgedCandidates(tx, sourceId, pages));
  const receipts = holds.length
    ? (await tx.executeRaw("DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_holds' AND target_id = ANY($1::text[]) RETURNING 1", [holds])).length
    : 0;
  return { write_gate_holds: holds.length, write_gate_receipts: receipts };
}

/** The slug-store members over a raw executor (a transaction handle inside an engine's own SQL), for the purge orchestrators. */
export type SlugStoreScrubber = Pick<BrainEngine, 'executeRaw' | 'deletePurgedSlugStoreRows' | 'listPageSecretOccurrences' | 'deletePurgedSlugHolds'>;
export function slugStoreScrubber(tx: Raw): SlugStoreScrubber {
  return {
    executeRaw: tx.executeRaw.bind(tx) as Raw['executeRaw'],
    deletePurgedSlugStoreRows: (sourceId, slugs, opts) => deletePurgedSlugStoreRows(tx, sourceId, slugs, opts),
    listPageSecretOccurrences: pageIds => listPageSecretOccurrences(tx, pageIds),
    deletePurgedSlugHolds: (sourceId, pages) => deletePurgedSlugHolds(tx, sourceId, pages),
  };
}
