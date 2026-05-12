/**
 * Shared primitives for HTML-comment-delimited markdown fences.
 *
 * Two consumers today:
 *   - `src/core/takes-fence.ts` (v0.28+) — the `## Takes` fence.
 *   - `src/core/facts-fence.ts` (v0.32.2+) — the `## Facts` fence.
 *
 * Both fences share row-level shape (pipe-separated cells, strikethrough on
 * the claim for inactive rows, optional separator row, escape-on-write for
 * embedded pipes). Lifting these helpers out makes that contract a single
 * source of truth — so a fix to one fence's parsing semantics applies to
 * the other automatically.
 *
 * Behavior is byte-identical to the inlined versions that shipped in
 * takes-fence at v0.28 — this is a refactor, not a behavior change. The
 * takes-fence test suite is the regression gate.
 *
 * Future fences (hunches as a third category, anything else that needs
 * fenced markdown tables) should consume these helpers and add only the
 * domain-specific parser layer on top.
 */

/**
 * Match a markdown table row's cell-stripped content.
 *
 * Returns `null` when the line is not a table row (doesn't start with `|`
 * or has no second pipe). On a match, returns the cells with surrounding
 * whitespace trimmed, with the outer pipes already stripped.
 *
 * NOTE: does NOT unescape `\|` back to `|`. Round-trip-on-pipes is a
 * separate concern callers handle if their domain text legitimately
 * contains pipes (currently neither takes nor facts do at the LLM-extract
 * layer; if a hand-edit introduces one, escape-on-write at render time
 * protects the table shape).
 */
export function parseRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map(c => c.trim());
}

/**
 * Markdown table separator detector. A row like `|---|---|---|` (or with
 * colons for alignment) returns true. Used to skip past the header
 * separator when iterating fence rows.
 */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^[-:\s]+$/.test(c)) && cells.length > 0;
}

/**
 * Detect strikethrough wrapping on a cell.
 *
 * `~~text~~` → `{ text: 'text', struck: true }`
 * `text`     → `{ text: 'text', struck: false }`
 *
 * Used by both fences to mark a row as inactive (takes: superseded /
 * retracted; facts: superseded / forgotten — the parser distinguishes
 * via the `context` cell at the domain layer, not here).
 */
export function stripStrikethrough(s: string): { text: string; struck: boolean } {
  const m = s.match(/^~~(.+?)~~$/);
  if (m) return { text: m[1].trim(), struck: true };
  return { text: s, struck: false };
}

/**
 * Trim a cell's surrounding whitespace and collapse empty / whitespace-only
 * cells to `undefined`. The `''` → `undefined` mapping is what callers want
 * for optional string fields.
 */
export function parseStringCell(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Escape a value for safe placement inside a pipe-separated cell. Replaces
 * any literal `|` with `\|` so the table layout stays intact. Inverse is
 * not needed at parse time today (see parseRowCells note); a future
 * `unescapeFenceCell` helper can land alongside any domain that needs to
 * read pipes back out of cell text.
 */
export function escapeFenceCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}
