/**
 * The (case, arm) entries of the multi-writer matrix: each row of multi-writer-cases.ts is an entry, and each of its
 * optional `variants` (a dotted id such as `C06.partition`, with its own members, reference and cells) is an entry of its
 * own, looked up through its parent row. The harness, coverage.ts, the ledger and the bar all go through here, so a variant
 * is a first-class case everywhere and none of them reads `variants` itself.
 *
 * Pure data: no engine and no `bun:test` import.
 *
 * The reader is structural on purpose. It reads the `variants` list of a row (the case work's `MwVariant`: `id`, `of`, `title`,
 * `invariant`, `members`, `reference`, optional `needs`, and cells for the ENGINE arms only) without importing that type, so
 * the matrix file stays the case work's. A variant takes its `members`, `reference` and `needs` from itself, never from its
 * parent; it has no store cells, so on the store arms it is `n/a` (and has no store tests).
 */
import { MW_CASES, type MwArm, type MwCase, type MwCell, type MwEngineArm } from './multi-writer-cases.ts';

/** A case id (`C06`) or a variant id (`C06.partition`). */
export type MwEntryId = string;

export interface MwEntry {
  id: MwEntryId;
  /** The matrix row the entry comes from (the row itself for a case, the parent for a variant). */
  parent: MwCase;
  variant: boolean;
  members: readonly string[];
  reference: MwCase['reference'];
  needs?: MwCase['needs'];
  storeTests: MwCase['storeTests'];
  cells: Readonly<Record<MwArm, MwCell>>;
}

interface VariantShape {
  id?: unknown; of?: unknown; members?: unknown; reference?: unknown; needs?: unknown; cells?: unknown;
}

export const ENTRY_ID = /^C\d\d(\.[a-z0-9_-]+)?$/;

export function mwEntries(matrix: readonly MwCase[] = MW_CASES): MwEntry[] {
  const out: MwEntry[] = [];
  for (const row of matrix) {
    out.push({ id: row.id, parent: row, variant: false, members: row.members, reference: row.reference,
      ...(row.needs !== undefined && { needs: row.needs }), storeTests: row.storeTests, cells: row.cells });
    const variants = (row as { variants?: readonly VariantShape[] }).variants ?? [];
    for (const v of variants) {
      const where = `multi-writer-cases: ${row.id} variant ${JSON.stringify(v.id)}`;
      if (typeof v.id !== 'string' || !v.id.startsWith(`${row.id}.`) || !ENTRY_ID.test(v.id)) throw new Error(`${where}: the id must be \`${row.id}.<name>\``);
      if (!Array.isArray(v.members) || v.members.length === 0) throw new Error(`${where}: a variant names its own members`);
      if (v.reference !== 'compare' && v.reference !== 'standalone') throw new Error(`${where}: a variant names its own reference (compare or standalone)`);
      if (typeof v.cells !== 'object' || v.cells === null) throw new Error(`${where}: a variant carries its own cells`);
      if (out.some((e) => e.id === v.id)) throw new Error(`${where}: duplicate id`);
      if (v.of !== undefined && v.of !== row.id) throw new Error(`${where}: \`of\` is ${JSON.stringify(v.of)}, but it sits in the ${row.id} row`);
      const noStore: MwCell = { status: 'n/a', why: 'a variant is an engine-level scenario and has no store cells' };
      out.push({ id: v.id, parent: row, variant: true, members: v.members as readonly string[], reference: v.reference,
        ...(v.needs !== undefined && { needs: v.needs as MwCase['needs'] }), storeTests: { runnable: [], pending: [] },
        cells: { 'store-single': noStore, 'store-optimistic': noStore, ...(v.cells as Record<MwEngineArm, MwCell>) } as Record<MwArm, MwCell> });
    }
  }
  return out;
}

/** The entry for a case or variant id; throws when the matrix has none. */
export function mwEntry(id: MwEntryId, matrix: readonly MwCase[] = MW_CASES): MwEntry {
  const found = mwEntries(matrix).find((e) => e.id === id);
  if (found === undefined) throw new Error(`multi-writer-cases: no row or variant for ${id}`);
  return found;
}
