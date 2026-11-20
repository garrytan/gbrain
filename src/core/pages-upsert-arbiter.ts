/**
 * #550 — pages(source_id, slug) unique-arbiter schema-drift self-heal.
 *
 * Every `putPage` upsert (both engines) infers ON CONFLICT (source_id, slug),
 * which requires a non-partial UNIQUE index covering exactly those columns.
 * When the `pages_source_slug_key` constraint vanishes (partial restore,
 * manual DDL, a failed/renumbered migration), EVERY page write brain-wide
 * fails with "no unique or exclusion constraint matching the ON CONFLICT
 * specification" — and neither re-running `initSchema` nor the version
 * counter can see the drift (migrations v21/v23 guarded the ADD by
 * constraint NAME only, and the version counter is already stamped past
 * them).
 *
 * Mirrors timeline-dedup-repair.ts (#2038): the check keys off the actual
 * index SHAPE (any non-partial unique index whose column set is exactly
 * {source_id, slug}, regardless of name) and the repair runs on every
 * migrate pass. The repair only ever ADDs the constraint — it never deletes
 * rows. If duplicate (source_id, slug) rows already snuck in through the
 * unprotected window, it refuses and reports them for manual resolution.
 */

import type { BrainEngine } from './engine.ts';

const CONSTRAINT_NAME = 'pages_source_slug_key';

export interface PagesUpsertArbiterStatus {
  /** The pages table exists (nothing to check if not). */
  tablePresent: boolean;
  /** Some non-partial unique index on exactly (source_id, slug) exists — any name. */
  arbiterPresent: boolean;
  /** Missing arbiter: every putPage upsert is failing. */
  needsRepair: boolean;
  /** Duplicate (source_id, slug) groups that block adding the constraint. */
  duplicateGroups: number;
}

export async function checkPagesUpsertArbiter(engine: BrainEngine): Promise<PagesUpsertArbiterStatus> {
  // The catalog-anchored shape probe and the duplicate count (engine-sql/doctor-health.ts readPagesUpsertArbiter).
  const { tablePresent, arbiterPresent, duplicateGroups } = await engine.readPagesUpsertArbiter();
  return { tablePresent, arbiterPresent, needsRepair: tablePresent && !arbiterPresent, duplicateGroups };
}

export interface PagesUpsertArbiterRepairResult {
  repaired: boolean;
  duplicateGroups: number;
  reason: 'already_correct' | 'no_table' | 'duplicates' | 'restored';
}

/**
 * Restore the UNIQUE(source_id, slug) arbiter if it's missing. ADD-only:
 * never deletes rows. When duplicate (source_id, slug) groups exist the
 * constraint cannot be added — refuse and report so the operator resolves
 * the duplicates deliberately (each duplicate is a real page row).
 */
export async function repairPagesUpsertArbiter(engine: BrainEngine): Promise<PagesUpsertArbiterRepairResult> {
  const status = await checkPagesUpsertArbiter(engine);
  if (!status.tablePresent) {
    return { repaired: false, duplicateGroups: 0, reason: 'no_table' };
  }
  if (!status.needsRepair) {
    return { repaired: false, duplicateGroups: 0, reason: 'already_correct' };
  }
  if (status.duplicateGroups > 0) {
    return { repaired: false, duplicateGroups: status.duplicateGroups, reason: 'duplicates' };
  }
  // A misshapen constraint/index may be squatting on the canonical name (the
  // by-shape probe above already established it is NOT a valid arbiter).
  // Free the name before re-adding. Constraint-drop also drops its index.
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`);
  await engine.executeRaw(`DROP INDEX IF EXISTS ${CONSTRAINT_NAME}`);
  await engine.executeRaw(
    `ALTER TABLE pages ADD CONSTRAINT ${CONSTRAINT_NAME} UNIQUE (source_id, slug)`,
  );
  return { repaired: true, duplicateGroups: 0, reason: 'restored' };
}
