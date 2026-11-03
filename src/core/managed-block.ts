/**
 * managed-block.ts — one marker-delimited block inside a text file the user
 * also edits (CLAUDE.md, AGENTS.md, SOUL.md, a Cursor rule).
 *
 * Discipline (shared by the ambient-writeback block and the brain-first
 * block): exact-line marker match at column 0; no markers → append a fresh
 * block at EOF; exactly one in-order pair → replace the interior; anything
 * else (duplicates, an orphan, out of order) → THROW, because those are
 * hand-edits we must not guess through. Marker-equal lines inside the body
 * are neutralized with a leading space so a body can never self-wedge the
 * next splice. Text outside the markers is never touched.
 */

export interface BlockMarkers {
  begin: string;
  end: string;
  /** Names the block and the command that rewrites it, for the damaged-markers error. */
  label: string;
  rerun: string;
}

function damagedMarkersError(m: BlockMarkers, begins: number, ends: number): Error {
  return new Error(
    `the gbrain ${m.label} markers in this file are damaged ` +
      `(${begins} begin / ${ends} end` +
      `${begins === 1 && ends === 1 ? ', out of order' : ''}) — ` +
      `the managed block was hand-edited. Fix the markers (or delete the whole block, ` +
      `markers included) and re-run \`${m.rerun}\`.`,
  );
}

/** A line as an editor may have saved it: a CRLF line ending or a leading BOM does not hide a marker. */
function bare(line: string, i: number): string {
  return (i === 0 ? line.replace(/^\uFEFF/, '') : line).replace(/\r$/, '');
}

function scanMarkers(m: BlockMarkers, lines: string[]): { begin: number; end: number } | 'absent' {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (bare(line, i) === m.begin) begins.push(i);
    if (bare(line, i) === m.end) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return 'absent';
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) throw damagedMarkersError(m, begins.length, ends.length);
  return { begin: begins[0], end: ends[0] };
}

/** Non-throwing probe: absent, present (with its interior) or damaged. */
export function probeBlock(m: BlockMarkers, text: string): { state: 'absent' | 'present' | 'damaged'; interior?: string } {
  const lines = text.split('\n');
  try {
    const scan = scanMarkers(m, lines);
    if (scan === 'absent') return { state: 'absent' };
    return { state: 'present', interior: lines.slice(scan.begin + 1, scan.end).map((l) => l.replace(/\r$/, '')).join('\n') };
  } catch {
    return { state: 'damaged' };
  }
}

/** Splice `body` into the block; no markers → append at EOF; damaged markers throw. */
export function spliceBlock(m: BlockMarkers, existing: string, body: string): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const scan = scanMarkers(m, lines);
  const neutralized = body
    .split('\n')
    .map((l) => (l === m.begin || l === m.end ? ` ${l}` : l))
    .join('\n');
  const interior = neutralized.endsWith('\n') ? neutralized.slice(0, -1) : neutralized;
  if (scan === 'absent') {
    const head = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    return `${head}${m.begin}\n${interior}\n${m.end}\n`;
  }
  const out = [...lines.slice(0, scan.begin + 1), ...interior.split('\n'), ...lines.slice(scan.end)];
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/**
 * Strip the block (markers, interior and at most one trailing blank line).
 * No markers → `removed: false` with the text unchanged; damaged markers throw.
 */
export function removeBlock(m: BlockMarkers, existing: string): { text: string; removed: boolean } {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const scan = scanMarkers(m, lines);
  if (scan === 'absent') return { text: existing, removed: false };
  let after = scan.end + 1;
  if (after < lines.length - 1 && bare(lines[after], after) === '') after++;
  const out = [...lines.slice(0, scan.begin), ...lines.slice(after)];
  const bom = scan.begin === 0 && lines[0].startsWith('\uFEFF') ? '\uFEFF' : '';
  return { text: bom + out.join('\n'), removed: true };
}

/** True when any exact marker line is present, well-formed or damaged. */
export function blockPresent(m: BlockMarkers, text: string): boolean {
  return text.split('\n').some((l, i) => bare(l, i) === m.begin || bare(l, i) === m.end);
}
