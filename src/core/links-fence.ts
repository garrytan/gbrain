/**
 * The `## Links` fence: the markdown form of authored (manual) graph edges.
 *
 *   ## Links
 *
 *   <!--- gbrain:links:begin -->
 *   | to | type | source | valid_from | valid_until | context |
 *   |---|---|---|---|---|---|
 *   | companies/acme-example | works_at | manual | 2025-03-01 |  | met at a conference |
 *   <!--- gbrain:links:end -->
 *
 * Each row is one edge from the page that holds the fence, keyed by
 * (to, type, source); `source` defaults to `manual`. The `links` rows are
 * projected from it (links-fence-projection.ts): link_source = the row's
 * source, origin_page_id = this page, origin_field = `links_fence`. A body
 * with no fence projects nothing and removes nothing.
 *
 * Pure module (no engine imports), like facts-fence.ts: the row helpers come
 * from fence-shared.ts and the marker scan from fence-scan.ts. The renderer
 * is deterministic (rows sorted by key), so a parse/render round trip of a
 * clean fence is byte-stable.
 */
import { escapeFenceCell, isSeparatorRow, parseRowCells } from './fence-shared.ts';
import { locateOutsideCode, unclosedCodeFenceStart } from './fence-scan.ts';

export const LINKS_FENCE_BEGIN = '<!--- gbrain:links:begin -->';
export const LINKS_FENCE_END = '<!--- gbrain:links:end -->';
/** links.origin_field of an edge projected from a page's links fence. */
export const LINKS_FENCE_ORIGIN_FIELD = 'links_fence';

/**
 * v114 (#1941): reconciliation-managed provenances a caller must not forge
 * through add_link, and that a links fence row cannot carry. `manual` is
 * intentionally absent: it is the user-facing provenance and the default.
 */
export const MANAGED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved', 'mcp-remote-mention'];

const COLUMNS = ['to', 'type', 'source', 'valid_from', 'valid_until', 'context'] as const;
type Column = typeof COLUMNS[number];
/** The links.link_source CHECK (src/schema.sql). */
const LINK_SOURCE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface LinksFenceRow {
  to: string;
  type: string;
  source: string;
  validFrom?: string;
  validUntil?: string;
  context: string;
}

/** `absent`: no fence markers; `malformed`: markers or a header that cannot be read (no row is trusted). */
export interface LinksFenceParseResult {
  state: 'absent' | 'parsed' | 'malformed';
  rows: LinksFenceRow[];
  warnings: string[];
}

export const linksFenceKey = (row: Pick<LinksFenceRow, 'to' | 'type' | 'source'>) => `${row.to}\u0000${row.type}\u0000${row.source}`;

/** YYYY-MM-DD naming a real calendar day. */
export function isFenceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Why a row cannot become an edge, or null when it can. */
export function linksFenceRowProblem(row: LinksFenceRow): string | null {
  if (!row.to || /\s/.test(row.to)) return `target ${JSON.stringify(row.to)} is not a page slug`;
  if (/\s/.test(row.type)) return `link type ${JSON.stringify(row.type)} has whitespace`;
  if (!LINK_SOURCE_RE.test(row.source) || row.source.length > 64) return `source ${JSON.stringify(row.source)} is not a kebab-case tag`;
  if (MANAGED_LINK_SOURCES.includes(row.source)) return `source ${row.source} is reconciliation-managed`;
  for (const [name, value] of [['valid_from', row.validFrom], ['valid_until', row.validUntil]] as const) {
    if (value !== undefined && !isFenceDate(value)) return `${name} ${JSON.stringify(value)} is not a YYYY-MM-DD date`;
  }
  if (row.validFrom && row.validUntil && row.validUntil < row.validFrom) return 'valid_until is before valid_from';
  return null;
}

// A cell quoting this fence's own marker would close or reopen it. The fence-shared encoding, applied to links
// markers (`gbrain:links:begin` -> `gbrain&#58;links:begin`, each further level adds `amp;`), keeps it text.
const BARE_OR_ENCODED_MARKER_RE = /gbrain(:|&(?:amp;)*#58;)links:(begin|end)/g;
const ENCODED_MARKER_RE = /gbrain&((?:amp;)*)#58;links:(begin|end)/g;
const encodeCell = (value: string) => escapeFenceCell(value.replace(BARE_OR_ENCODED_MARKER_RE, (_m, mid: string, edge: string) =>
  mid === ':' ? `gbrain&#58;links:${edge}` : `gbrain&amp;${mid.slice(1)}links:${edge}`));
const decodeCell = (value: string) => value.replace(ENCODED_MARKER_RE, (_m, amps: string, edge: string) =>
  amps === '' ? `gbrain:links:${edge}` : `gbrain&${amps.slice('amp;'.length)}#58;links:${edge}`);

/** Offsets of the fence (begin marker start, end marker end) outside code, or null when it has no balanced pair. */
export function locateLinksFence(body: string): { start: number; end: number } | null {
  const { beginIdx, endIdx } = locateOutsideCode(body, LINKS_FENCE_BEGIN, LINKS_FENCE_END);
  return beginIdx === -1 || endIdx === -1 ? null : { start: beginIdx, end: endIdx + LINKS_FENCE_END.length };
}

export function parseLinksFence(body: string): LinksFenceParseResult {
  const { beginIdx, endIdx } = locateOutsideCode(body, LINKS_FENCE_BEGIN, LINKS_FENCE_END);
  if (beginIdx === -1 && endIdx === -1) return { state: 'absent', rows: [], warnings: [] };
  if (beginIdx === -1 || endIdx === -1) {
    return { state: 'malformed', rows: [], warnings: ['LINKS_FENCE_UNBALANCED: missing begin or end marker'] };
  }
  const warnings: string[] = [];
  const rows: LinksFenceRow[] = [];
  const seen = new Set<string>();
  let layout: Column[] | null = null;
  for (const line of body.slice(beginIdx + LINKS_FENCE_BEGIN.length, endIdx).split('\n')) {
    if (!line.trim()) continue;
    const cells = parseRowCells(line)?.map(decodeCell);
    if (!cells) {
      warnings.push(`LINKS_TABLE_MALFORMED: not a table row: "${line.trim()}"`);
      continue;
    }
    if (!layout) {
      const lower = cells.map(cell => cell.toLowerCase());
      if (!lower.includes('to') || lower.some(cell => !(COLUMNS as readonly string[]).includes(cell)) || new Set(lower).size !== lower.length) {
        return { state: 'malformed', rows: [], warnings: [`LINKS_TABLE_MALFORMED: the header must name to and only ${COLUMNS.join(', ')}: "${line.trim()}"`] };
      }
      layout = lower as Column[];
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    if (cells.length > layout.length) {
      warnings.push(`LINKS_TABLE_MALFORMED: ${cells.length} cells in row "${line.trim()}", more than its ${layout.length} columns`);
      continue;
    }
    const columns = layout;
    const cell = (column: Column) => (columns.includes(column) ? cells[columns.indexOf(column)] ?? '' : '').trim();
    const row: LinksFenceRow = { to: cell('to').toLowerCase(), type: cell('type'), source: cell('source') || 'manual',
      ...(cell('valid_from') ? { validFrom: cell('valid_from') } : {}), ...(cell('valid_until') ? { validUntil: cell('valid_until') } : {}),
      context: cell('context') };
    const problem = linksFenceRowProblem(row);
    if (problem) {
      warnings.push(`LINKS_ROW_INVALID: ${problem}: "${line.trim()}"`);
      continue;
    }
    if (seen.has(linksFenceKey(row))) {
      warnings.push(`LINKS_ROW_DUPLICATE: a second row for ${row.to} ${row.type || '(untyped)'} ${row.source}: "${line.trim()}"`);
      continue;
    }
    seen.add(linksFenceKey(row));
    rows.push(row);
  }
  if (!layout) return { state: 'malformed', rows: [], warnings: [...warnings, 'LINKS_TABLE_MALFORMED: no header row'] };
  return { state: 'parsed', rows, warnings };
}

const compareRows = (a: LinksFenceRow, b: LinksFenceRow) => a.to < b.to ? -1 : a.to > b.to ? 1
  : a.type < b.type ? -1 : a.type > b.type ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0;

/** The fence block (markers included), rows sorted by (to, type, source). */
export function renderLinksFence(rows: readonly LinksFenceRow[]): string {
  const lines = [LINKS_FENCE_BEGIN, `| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`];
  for (const row of [...rows].sort(compareRows)) {
    lines.push(`| ${[row.to, row.type, row.source, row.validFrom ?? '', row.validUntil ?? '', row.context].map(encodeCell).join(' | ')} |`);
  }
  lines.push(LINKS_FENCE_END);
  return lines.join('\n');
}

/** Replace the fence in `body`, or append a `## Links` section holding it (above an unclosed code block, so it is read). */
export function replaceOrInsertLinksFence(body: string, block: string): string {
  const at = locateLinksFence(body);
  if (at) return body.slice(0, at.start) + block + body.slice(at.end);
  const section = `## Links\n\n${block}\n`;
  const codeAt = unclosedCodeFenceStart(body);
  const head = codeAt === -1 ? body : body.slice(0, codeAt);
  const tail = codeAt === -1 ? '' : `\n${body.slice(codeAt)}`;
  if (!head.trim()) return `${section}${tail}`;
  const sep = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n';
  return `${head}${sep}${section}${tail}`;
}

/** A fence that does not parse cleanly would lose the rows the parser skipped if it were rewritten. */
export class LinksFenceRewriteRefusal extends Error {
  constructor(readonly warnings: readonly string[]) {
    super(`The page's links fence does not parse cleanly (${warnings.slice(0, 3).join('; ')}), so it was not rewritten.`);
    this.name = 'LinksFenceRewriteRefusal';
  }
}

function rewritableRows(body: string): LinksFenceRow[] {
  const parsed = parseLinksFence(body);
  if (parsed.warnings.length) throw new LinksFenceRewriteRefusal(parsed.warnings);
  return parsed.rows;
}

/**
 * Add the row keyed (to, type, source), or update it: an empty context or an omitted date keeps the stored one.
 * An identical row leaves the body unchanged (`changed` false).
 */
export function upsertLinksFenceRow(body: string, row: LinksFenceRow): { body: string; changed: boolean; row: LinksFenceRow } {
  const rows = rewritableRows(body);
  const existing = rows.find(r => linksFenceKey(r) === linksFenceKey(row));
  const next: LinksFenceRow = existing ? { ...existing, context: row.context || existing.context,
    ...(row.validFrom ? { validFrom: row.validFrom } : {}), ...(row.validUntil ? { validUntil: row.validUntil } : {}) } : row;
  const problem = linksFenceRowProblem(next);
  if (problem) throw new LinksFenceRewriteRefusal([`LINKS_ROW_INVALID: ${problem}`]);
  if (existing && renderLinksFence([existing]) === renderLinksFence([next])) return { body, changed: false, row: next };
  const updated = existing ? rows.map(r => r === existing ? next : r) : [...rows, next];
  return { body: replaceOrInsertLinksFence(body, renderLinksFence(updated)), changed: true, row: next };
}

/** Remove the rows to `to` (optionally only one type and/or source). The fence stays, empty, when no row is left. */
export function removeLinksFenceRows(body: string, match: { to: string; type?: string; source?: string }): { body: string; removed: LinksFenceRow[] } {
  if (parseLinksFence(body).state === 'absent') return { body, removed: [] };
  const rows = rewritableRows(body);
  const hit = (r: LinksFenceRow) => r.to === match.to && (match.type === undefined || r.type === match.type)
    && (match.source === undefined || r.source === match.source);
  const removed = rows.filter(hit);
  if (!removed.length) return { body, removed };
  return { body: replaceOrInsertLinksFence(body, renderLinksFence(rows.filter(r => !hit(r)))), removed };
}

/** Blank the fence (same length, newlines kept) so body link extraction never reads its cells as references. */
export function maskLinksFence(body: string): string {
  const at = locateLinksFence(body);
  if (!at) return body;
  return body.slice(0, at.start) + body.slice(at.start, at.end).replace(/[^\n]/g, ' ') + body.slice(at.end);
}

/** The page section that holds the fence: compiled_truth, unless only the timeline has one. */
export function linksFenceSection(page: { compiled_truth: string; timeline?: string | null }): 'compiled_truth' | 'timeline' {
  return parseLinksFence(page.compiled_truth).state === 'absent' && page.timeline && parseLinksFence(page.timeline).state !== 'absent'
    ? 'timeline' : 'compiled_truth';
}

/** The page's links fence, read from the section that holds it. */
export function readPageLinksFence(page: { compiled_truth: string; timeline?: string | null }): LinksFenceParseResult {
  return parseLinksFence((linksFenceSection(page) === 'timeline' ? page.timeline : page.compiled_truth) ?? '');
}
