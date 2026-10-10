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
 * Escaped pipes (`\|`) stay inside their cell and are decoded back to `|`.
 * After cell boundaries are found, `<br>` (also `<br/>` and `<br />`, case
 * insensitive) decodes to `\n`. A literal `<br>` in a claim therefore reads
 * back as a newline. Other backslashes are preserved verbatim.
 */
export function parseRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\' && inner[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells.map(cell => cell.replace(/<br\s*\/?>/gi, '\n'));
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
  // [\s\S] rather than `.`: cells may hold decoded newlines (<br>).
  const m = s.match(/^~~([\s\S]+?)~~$/);
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
 * literal `|` with `\|` and line breaks (`\r\n`, `\r`, `\n`) with `<br>` so
 * each row stays on one physical line. `parseRowCells` decodes these after
 * identifying cell boundaries. A literal `<br>` collides with this encoding
 * and reads back as a newline.
 */
export function escapeFenceCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>');
}

/**
 * A fence rewrite refused because the fence it starts from does not parse
 * cleanly. Every rewriter re-renders the rows the parser returned, so
 * rewriting such a fence would silently delete the rows the parser skipped.
 * The message names the fence only: parser warnings embed row text, so they
 * stay on `warnings` for the caller to locate, never in the message.
 */
export class FenceRewriteRefusal extends Error {
  constructor(readonly fence: 'facts' | 'takes', readonly warnings: readonly string[]) {
    super(`The ${fence} fence does not parse cleanly, so it was not rewritten; fix the fence first.`);
    this.name = 'FenceRewriteRefusal';
  }
}

/** Throw `FenceRewriteRefusal` when the parse a rewrite starts from has warnings. */
export function assertFenceRewritable(fence: 'facts' | 'takes', parsed: { warnings: readonly string[] }): void {
  if (parsed.warnings.length > 0) throw new FenceRewriteRefusal(fence, parsed.warnings);
}
