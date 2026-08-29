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
/** Sorted column set the ON CONFLICT (source_id, slug) inference needs. */
const EXPECTED_COLUMN_SET = ['slug', 'source_id'];

/** Parse the column list out of a pg_indexes `indexdef` string. */
function parseIndexColumns(indexdef: string): string[] {
  const open = indexdef.indexOf('(');
  const close = indexdef.indexOf(')', open);
  if (open < 0 || close < 0) return [];
  return indexdef
    .slice(open + 1, close)
    .split(',')
    .map(c => c.trim().split(/\s+/)[0]) // drop any "col DESC"/opclass suffix
    .filter(Boolean);
}

/** True when the indexdef is a non-partial unique index on exactly {source_id, slug}. */
function isArbiterShape(indexdef: string): boolean {
  if (!/^CREATE UNIQUE INDEX/i.test(indexdef)) return false;
  if (/\)\s+WHERE\s+/i.test(indexdef)) return false; // partial indexes can't arbitrate
  const cols = parseIndexColumns(indexdef).sort();
  return (
    cols.length === EXPECTED_COLUMN_SET.length &&
    EXPECTED_COLUMN_SET.every((c, i) => cols[i] === c)
  );
}

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
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('pages')::text AS reg`,
  );
  const tablePresent = !!tbl[0]?.reg;
  if (!tablePresent) {
    return { tablePresent: false, arbiterPresent: false, needsRepair: false, duplicateGroups: 0 };
  }
  // Catalog-anchored candidate set (#550 residual): pg_indexes was a bare
  // text scan on tablename, which false-passed on exactly the drift shapes
  // this module exists to catch — an INVALID index (a failed CREATE INDEX
  // CONCURRENTLY remnant renders a normal-looking indexdef but cannot
  // arbitrate), a DEFERRABLE unique (indimmediate = false, unusable for ON
  // CONFLICT), and a same-named table in ANOTHER schema (tablename has no
  // schema qualifier, while the table probe above resolved via search_path).
  // Anchoring on the SAME to_regclass('pages') plus the catalog validity
  // flags closes all three; indpred IS NULL keeps the existing
  // partial-index exclusion at the catalog level too.
  const rows = await engine.executeRaw<{ indexdef: string }>(
    `SELECT pg_get_indexdef(x.indexrelid) AS indexdef
       FROM pg_index x
      WHERE x.indrelid = to_regclass('pages')
        AND x.indisunique
        AND x.indisvalid
        AND x.indisready
        AND x.indimmediate
        AND x.indpred IS NULL`,
  );
  const arbiterPresent = rows.some(r => isArbiterShape(r.indexdef));
  let duplicateGroups = 0;
  if (!arbiterPresent) {
    const dup = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM (
         SELECT 1 FROM pages GROUP BY source_id, slug HAVING COUNT(*) > 1
       ) d`,
    );
    duplicateGroups = parseInt(dup[0]?.n ?? '0', 10);
  }
  return { tablePresent, arbiterPresent, needsRepair: !arbiterPresent, duplicateGroups };
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
