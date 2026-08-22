/**
 * v0.46 (#3014) — pure resolution of a struck fence row's
 * `superseded by #N` page-local reference to a fact id.
 *
 * The fence parser (`facts-fence.ts`) maps `~~claim~~` + `context:
 * superseded by #N` to `supersededBy: N` — a ROW NUMBER within the page,
 * not a fact id. `facts.superseded_by` is a FK to `facts.id`, so the
 * engines resolve the row number in a second pass inside the insert
 * transaction (keyed on the v51 unique coordinate
 * `(source_id, source_markdown_slug, row_num)`). The decision logic lives
 * here — pure, no engine call, no I/O — so it is unit-testable without a
 * DB and shared verbatim by both engines (parity) plus the cycle phase's
 * drift re-resolution.
 */

/**
 * The target row a struck `superseded by #N` reference resolves to, as
 * seen at insert time.
 */
export interface SupersedeTarget {
  id: number;
  /**
   * true when the target row is itself inactive (its `expired_at` is set)
   * — e.g. `#N` points at a forgotten row or an already-superseded row. A
   * supersession target must be a live row, so a struck target is rejected.
   */
  struck: boolean;
}

/** Outcome of resolving a `superseded by #N` reference to a fact id. */
export interface SupersedeResolution {
  /** The resolved target fact id, or null when the reference is unsafe. */
  superseded_by: number | null;
  /** A human-readable warning when the reference could not be resolved. */
  warning: string | null;
}

/** Largest value a Postgres `int4` column (`facts.row_num`) can hold. */
export const PG_INT4_MAX = 2147483647;

/**
 * Can `n` safely target the `row_num` (int4) column in insertFacts'
 * supersession-resolution SELECT? The fence parser accepts any finite
 * `#N`, but a value outside int4 range would overflow the comparison and
 * raise `integer out of range`, aborting the whole extract cycle. The
 * engines gate the lookup on this so an absurd `#N` is treated as a
 * dangling reference (resolveSupersededByRow with `target` undefined →
 * NULL + warning) rather than an uncaught throw.
 */
export function isInt4RowRef(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= PG_INT4_MAX;
}

/**
 * Resolve a struck row's `superseded by #N` page-local reference to a
 * fact id. Pure: the caller supplies the already-looked-up `target`
 * (keyed on source + slug + row_num within the same transaction) so this
 * decision is unit-testable without a DB.
 *
 * Three references are unsafe and resolve to NULL + a warning (never an
 * FK write to a guessed id); `expired_at` is set by the fence mapper
 * regardless of the outcome so the struck row still exits active views:
 *   - self-reference (`#N` == the row's own number)
 *   - dangling (`#N` names a row absent from the page)
 *   - struck target (`#N` names a row that is itself inactive — a
 *     supersession chain, or a forgotten target)
 */
export function resolveSupersededByRow(
  ownRowNum: number,
  supersededByRow: number,
  target: SupersedeTarget | undefined,
  slug: string,
): SupersedeResolution {
  if (supersededByRow === ownRowNum) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" references itself — leaving superseded_by NULL`,
    };
  }
  if (!target) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" names a row absent from the fence — leaving superseded_by NULL`,
    };
  }
  if (target.struck) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" names a row that is itself struck (inactive) — a supersession target must be a live row; leaving superseded_by NULL`,
    };
  }
  return { superseded_by: target.id, warning: null };
}
