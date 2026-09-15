/**
 * #4613 — links_link_source_check constraint-shape self-heal.
 *
 * Migration v114 (#1941) opened `links.link_source` from a closed allowlist to
 * a kebab-case format gate. The migrator trusts the version ledger
 * (`m.version > current`), so a brain stamped >= 114 whose live CHECK still
 * carries the pre-v114 allowlist (restore from a drifted snapshot, manual DDL,
 * an interrupted historical migration) never replays v114 — and every kebab
 * provenance write (`atom-provenance`, `concept-provenance`) is rejected while
 * `doctor` reports the schema current.
 *
 * Third instance of the #2038 / #550 pattern: key the check off the actual
 * constraint SHAPE in pg_constraint (not the ledger), run the repair on every
 * migrate pass once the ledger has reached v114, refuse loudly instead of
 * half-applying. The repair only ever restores the migration-declared
 * definition — it never touches rows. Violating rows are probed BEFORE any
 * DDL: when present, nothing is altered (the old constraint, if any, stays in
 * place) and the count is reported for manual resolution — so a brain with a
 * bad row never pays for a failing ALTER on every engine open.
 */

import type { BrainEngine } from './engine.ts';

const CONSTRAINT_NAME = 'links_link_source_check';

/** The migration that introduced the kebab gate; `runMigrations` skips the self-heal below this ledger. */
export const LINK_SOURCE_GATE_MIGRATION_VERSION = 114;

/**
 * Kebab provenance-tag format gate (migration v114 / #1941). ONE copy here;
 * the drift-guard test pins it to the literal in migrate.ts v114, schema.sql
 * and pglite-schema.ts.
 */
export const LINK_SOURCE_KEBAB_RE = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';

const GATE_PREDICATE = `(link_source ~ '${LINK_SOURCE_KEBAB_RE}' AND char_length(link_source) <= 64)`;

const DROP_DDL = `ALTER TABLE links DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};`;
const ADD_DDL = `ALTER TABLE links ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (link_source IS NULL OR ${GATE_PREDICATE})`;
const VALIDATE_DDL = `ALTER TABLE links VALIDATE CONSTRAINT ${CONSTRAINT_NAME}`;

export type LinkSourceCheckDrift = 'absent' | 'wrong_def' | 'not_validated';

export interface LinkSourceCheckStatus {
  /** The links table exists (nothing to check if not). */
  tablePresent: boolean;
  constraintPresent: boolean;
  /** `pg_get_constraintdef` output; null when absent. */
  def: string | null;
  /** Which drift shape was found; null when the live shape matches v114. */
  drift: LinkSourceCheckDrift | null;
  needsRepair: boolean;
}

export async function checkLinkSourceCheck(engine: BrainEngine): Promise<LinkSourceCheckStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(`SELECT to_regclass('links')::text AS reg`);
  if (!tbl[0]?.reg) {
    return { tablePresent: false, constraintPresent: false, def: null, drift: null, needsRepair: false };
  }
  const rows = await engine.executeRaw<{ def: string; convalidated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = to_regclass('links') AND conname = '${CONSTRAINT_NAME}'`,
  );
  const row = rows[0];
  // pg_get_constraintdef deparses the regex Const verbatim, so a substring
  // match on the literal distinguishes v114 from any older allowlist.
  const drift: LinkSourceCheckDrift | null = !row
    ? 'absent'
    : !row.def.includes(LINK_SOURCE_KEBAB_RE)
      ? 'wrong_def'
      : !row.convalidated
        ? 'not_validated'
        : null;
  return { tablePresent: true, constraintPresent: !!row, def: row?.def ?? null, drift, needsRepair: drift !== null };
}

export interface LinkSourceCheckRepairResult {
  repaired: boolean;
  /** Rows whose link_source fails the kebab gate (they block the ADD). */
  violations: number;
  reason: 'already_correct' | 'no_table' | 'violations' | 'restored';
}

async function countViolations(engine: BrainEngine): Promise<number> {
  const bad = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM links WHERE link_source IS NOT NULL AND NOT ${GATE_PREDICATE}`,
  );
  return parseInt(bad[0]?.n ?? '0', 10);
}

/**
 * Restore the v114 definition when the live shape drifted. Mirrors v114's
 * engine split: on Postgres a plain `ADD CONSTRAINT ... CHECK` takes ACCESS
 * EXCLUSIVE + a full validation scan on `links`, so the repair does DROP +
 * `ADD ... NOT VALID` in one transaction (atomic, no scan) and then `VALIDATE
 * CONSTRAINT` outside it (SHARE UPDATE EXCLUSIVE, doesn't block reads or
 * writes); a `not_validated` drift only needs the VALIDATE. PGLite
 * (single-writer WASM, no lock concern) keeps the one-shot DROP + ADD in one
 * transaction. Violating rows are counted BEFORE any DDL, so a brain with a
 * bad row never pays for a failing ALTER at every engine open; the post-DDL
 * count only classifies a row written between the probe and the ALTER.
 */
export async function repairLinkSourceCheck(engine: BrainEngine): Promise<LinkSourceCheckRepairResult> {
  const status = await checkLinkSourceCheck(engine);
  if (!status.tablePresent) return { repaired: false, violations: 0, reason: 'no_table' };
  if (!status.needsRepair) return { repaired: false, violations: 0, reason: 'already_correct' };
  const violations = await countViolations(engine);
  if (violations > 0) return { repaired: false, violations, reason: 'violations' };
  try {
    if (engine.kind === 'postgres') {
      if (status.drift !== 'not_validated') {
        await engine.transaction((tx) => tx.runMigration(0, `${DROP_DDL} ${ADD_DDL} NOT VALID;`));
      }
      await engine.runMigration(0, VALIDATE_DDL);
    } else {
      await engine.transaction((tx) => tx.runMigration(0, `${DROP_DDL} ${ADD_DDL};`));
    }
  } catch (e) {
    const late = await countViolations(engine);
    if (late === 0) throw e; // not a data problem — surface the real error
    return { repaired: false, violations: late, reason: 'violations' };
  }
  return { repaired: true, violations: 0, reason: 'restored' };
}
