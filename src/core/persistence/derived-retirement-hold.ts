/**
 * GBRA-161 PR 0: every derived retirement stays restorable for `DERIVED_RETIREMENT_HOLD_DAYS` before the purge may
 * remove it. A derived writer that retires a page it generated (an atom an extraction no longer produces, a chronicle
 * event a re-judged depth page no longer yields, an atom `gbrain repair stale-atoms` retired) versions it, soft-deletes
 * it and stamps `retired_by` with one of `DERIVED_RETIRED_BY` in the same transaction. The 72 h purge used to remove
 * those rows, and their `page_versions` with them (ON DELETE CASCADE), before anyone could notice a wrong retirement.
 *
 * The window runs from `deleted_at` (the database clock), never from the `retired_at` text. Remote page writes cannot
 * add or change the stamp keys (`RESERVED_RETIREMENT_KEYS`; the page preparer refuses with `reserved_frontmatter_key`). An
 * explicit `gbrain delete --purge` is not held. No engine-sql imports, so `engine-sql/pages.ts` may import it.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { maintenanceTransaction } from './attribution.ts';
import { GENERATION_BOUNDS, RESTORE_DAYS_SQL } from '../generations/config.ts';

/** The `retired_by` stamps derived writers put on the pages they retire. */
export const DERIVED_RETIRED_BY = ['extract-atoms', 'managed-reextract', 'stale-atoms', 'life-chronicle', 'generation-restore', 'synthesis-resynthesis', 'synthesis-cleanup'] as const;
export type DerivedRetiredBy = typeof DERIVED_RETIRED_BY[number];

/** The unmanaged extract_atoms retirement of atoms a completed re-extraction did not reproduce. */
export const ATOM_RETIRED_BY_EXTRACT: DerivedRetiredBy = 'extract-atoms';

/** Days after `deleted_at` that the purge keeps a derived retirement by default; `generations.restore_days` (3 to 365) overrides it. */
export const DERIVED_RETIREMENT_HOLD_DAYS = GENERATION_BOUNDS.restoreDays.fallback;

/** Frontmatter keys only a trusted derived writer sets; a remote page write never carries them. */
export const RESERVED_RETIREMENT_KEYS = ['retired_by', 'retired_at', 'retired_generation'] as const;

const stamps = DERIVED_RETIRED_BY.map(stamp => `'${stamp}'`).join(',');

/**
 * SQL predicate for a purge scan over `pages` aliased `alias`: the page is not a derived retirement inside its hold. The
 * window is the configured `generations.restore_days` read in the statement (GBRA-161 PR 1a), so a longer window is
 * never purged early.
 */
export function derivedRetirementPurgeHold(alias: string): string {
  return `NOT (COALESCE(${alias}.frontmatter->>'retired_by','') IN (${stamps})
    AND ${alias}.deleted_at > now() - interval '1 day' * ${RESTORE_DAYS_SQL})`;
}

/** Stamps pages the caller soft-deleted in this transaction as retired by `retiredBy`. */
async function stampDerivedRetirement(tx: BrainEngine, sourceId: string, slugs: readonly string[], retiredBy: DerivedRetiredBy): Promise<void> {
  if (!slugs.length) return;
  await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=ANY($4::text[]) AND deleted_at IS NOT NULL`, [retiredBy, new Date().toISOString(), sourceId, [...slugs]]);
}

/** Versions, soft-deletes and stamps `slugs` as retired by `retiredBy` inside the caller's attributed transaction. */
export async function retireDerivedPagesInTransaction(tx: BrainEngine, sourceId: string, slugs: readonly string[], retiredBy: DerivedRetiredBy): Promise<void> {
  if (!slugs.length) return;
  for (const slug of slugs) await tx.createVersion(slug, { sourceId });
  await tx.softDeletePages([...slugs], { sourceId });
  await stampDerivedRetirement(tx, sourceId, slugs, retiredBy);
}

/** Versions, soft-deletes and stamps `slugs` as retired by `retiredBy`, one attributed transaction per 500 pages. */
export async function retireDerivedPages(engine: BrainEngine, sourceId: string, slugs: readonly string[], retiredBy: DerivedRetiredBy): Promise<void> {
  for (let i = 0; i < slugs.length; i += 500) {
    const batch = slugs.slice(i, i + 500);
    await maintenanceTransaction(engine, tx => retireDerivedPagesInTransaction(tx, sourceId, batch, retiredBy));
  }
}

/** Refuses a remote write that adds or changes a stamp key; carrying the stored value unchanged, or dropping it, passes. */
export function assertRetirementStampUnchanged(slug: string, incoming: Record<string, unknown> | undefined, stored: Record<string, unknown> | undefined): void {
  const changed = RESERVED_RETIREMENT_KEYS.filter(key => incoming && Object.hasOwn(incoming, key)
    && JSON.stringify(incoming[key]) !== JSON.stringify(stored?.[key]));
  if (!changed.length) return;
  throw new OperationError('reserved_frontmatter_key',
    `A remote write cannot set ${changed.join(', ')} on ${slug}: only a trusted derived writer stamps a retirement, so nothing was written.`,
    `Remove ${changed.join(', ')} from the frontmatter (or keep the stored value) and write the page again.`);
}
