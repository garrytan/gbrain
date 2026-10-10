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
  return cells.map(decodeFenceCell);
}

/**
 * The cell-content decoder `parseRowCells` applies after cell boundaries are
 * found: `<br>` (also `<br/>`, `<br />`, case insensitive) → `\n`, then one
 * level of the fence-marker encoding below is removed. Exported so a parser
 * that tracks offsets itself (`fence-repair/raw-rows.ts`) reads cells
 * byte-identically to `parseRowCells`.
 */
export function decodeFenceCell(cell: string): string {
  return cell.replace(/<br\s*\/?>/gi, '\n').replace(ENCODED_MARKER_RE, (_m, amps: string, kind: string, edge: string) =>
    amps === '' ? `gbrain:${kind}:${edge}` : `gbrain&${amps.slice('amp;'.length)}#58;${kind}:${edge}`);
}

/**
 * Fence-marker text inside a cell (#5395). A claim that quotes
 * `gbrain:facts:begin` outside code would otherwise be written as a live
 * marker inside the table: the fence scanner pairs with it, the row and
 * every row after it vanish with no warning, and the remote boundary cuts
 * the body at the section. The encoding lengthens the ampersand run in
 * front of `#58;` (`&#58;` is the HTML entity for `:`; GFM renders it as a
 * colon, and no marker regex matches it):
 *
 *   gbrain:facts:begin          → gbrain&#58;facts:begin
 *   gbrain&#58;facts:begin      → gbrain&amp;#58;facts:begin
 *   gbrain&amp;#58;facts:begin  → gbrain&amp;amp;#58;facts:begin
 *
 * Decoding removes exactly one level, so the codec is injective: a claim
 * that literally held `gbrain&#58;facts:begin` reads back as that literal,
 * never as a live marker. A `&#58;` not followed by `(facts|takes):(begin|end)`
 * is left alone in both directions, and the transcript renderer's
 * `gbrain\:facts:begin` form contains no bare marker and passes through.
 */
const BARE_OR_ENCODED_MARKER_RE = /gbrain(:|&(?:amp;)*#58;)(facts|takes):(begin|end)/g;
const ENCODED_MARKER_RE = /gbrain&((?:amp;)*)#58;(facts|takes):(begin|end)/g;

function encodeFenceMarkers(s: string): string {
  return s.replace(BARE_OR_ENCODED_MARKER_RE, (_m, mid: string, kind: string, edge: string) =>
    mid === ':' ? `gbrain&#58;${kind}:${edge}` : `gbrain&amp;${mid.slice(1)}${kind}:${edge}`);
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
 * each row stays on one physical line, and encodes fence-marker text (see
 * `encodeFenceMarkers`) so a quoted marker never becomes a live one.
 * `parseRowCells` decodes these after identifying cell boundaries. A
 * literal `<br>` collides with this encoding and reads back as a newline.
 */
export function escapeFenceCell(s: string): string {
  return encodeFenceMarkers(s.replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>'));
}
