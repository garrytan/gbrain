/**
 * Shared symbol-match SQL for the call-graph edge lookups
 * (`getCallersOf` / `getCalleesOf`) across BOTH engines.
 *
 * The `code_callers` / `code_callees` ops document their `symbol` param as
 * "bare or qualified name" — both forms must resolve:
 *
 *   - QUALIFIED input (`CPipCalculator.CalculatePips`, `Widget::compute`)
 *     → exact match. Precise: a qualified query never conflates two classes'
 *       same-named methods, and it stays on the b-tree index (the hot path the
 *       recursive code walk hammers per BFS node).
 *   - BARE input (`CalculatePips`) → exact OR last-segment match, so a short
 *     name still recalls receiver-resolved QUALIFIED edges (e.g. the edge whose
 *     `to_symbol_qualified` is `CPipCalculator.CalculatePips`). This realizes
 *     the documented contract and the North Star's 100% recall bar; the
 *     ambiguity surfaces as multiple distinct qualified callers, not a silent
 *     zero.
 *
 * A bare query pays a sequential scan (the `regexp_replace` defeats the index),
 * but bare lookups are the inherent fan-out case; qualified lookups — including
 * every step of the recursive walk, which carries qualified names — keep the
 * fast exact path.
 *
 * Identifiers can't contain `.`/`:`/`#` (`[A-Za-z_][A-Za-z0-9_]*`), so any
 * input carrying one of those separators IS qualified. The last-segment
 * extractor `^.*[.:#]` greedily strips through the LAST separator, leaving the
 * final segment for `.`, `::`, and Ruby's `#` alike.
 *
 * `column` is an engine-supplied literal (`to_symbol_qualified` /
 * `from_symbol_qualified`), never user input — safe to interpolate. The value
 * stays the bound `$1` parameter in the caller's query.
 */

/**
 * POSIX pattern that greedily strips everything through the LAST namespace
 * separator, leaving the bare final segment. Shared by both engines so the
 * pglite and postgres last-segment match stay byte-identical (engine parity).
 */
export const LAST_SEGMENT_REGEX = '^.*[.:#]';

/** True when `symbol` carries a namespace separator and is therefore qualified. */
export function isQualifiedSymbol(symbol: string): boolean {
  return /[.:#]/.test(symbol);
}

/**
 * SQL boolean predicate (pglite `$1` style) matching `column` against the bound
 * `$1` parameter. Qualified inputs match exactly (index-fast, precise); bare
 * inputs also match on last segment (recall of receiver-resolved qualified
 * edges). `LAST_SEGMENT_REGEX` has no single-quotes, so inlining it as a SQL
 * literal here is safe.
 */
export function symbolMatchSql(column: string, symbol: string): string {
  if (isQualifiedSymbol(symbol)) {
    return `${column} = $1`;
  }
  return `(${column} = $1 OR regexp_replace(${column}, '${LAST_SEGMENT_REGEX}', '') = $1)`;
}
