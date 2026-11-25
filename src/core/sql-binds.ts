/**
 * Bound-parameter placeholders for SQL text built by hand, as the read-policy builders build theirs
 * (search/read-policy-sql.ts pageReadFilter): a value is pushed onto `params` and only its `$n` placeholder enters the
 * text, so no value is ever spliced. Statements that number their placeholders in the order values are bound use these
 * to keep the exact text they had when the placeholders were written by hand.
 */

/** Pushes `value` onto `params` and returns its placeholder (`$<position>`). */
export function bindParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/** A column name or `alias.column` spliced into SQL: code-provided, never user input. */
const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** `<column> IN ($a, $b, ...)`, each value bound in order; `column` must be a code-provided column name. */
export function bindInList(column: string, params: unknown[], values: readonly unknown[]): string {
  if (!COLUMN_RE.test(column)) throw new Error(`bindInList: bad column ${JSON.stringify(column)}`);
  return `${column} IN (${values.map(v => bindParam(params, v)).join(', ')})`;
}
