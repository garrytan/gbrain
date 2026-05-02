/**
 * v0.28: parser/renderer for fenced takes tables.
 *
 * Markdown is the source of truth (git is canonical). The DB takes table
 * is a derived index. This module is the boundary between them.
 *
 * Fence shape (HTML-comment markers, same pattern as skillpack/installer.ts):
 *
 *   ## Takes
 *
 *   <!--- gbrain:takes:begin -->
 *   | # | claim | kind | who | weight | since | source |
 *   |---|-------|------|-----|--------|-------|--------|
 *   | 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
 *   | 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | OH 2026-04-29 |
 *   | 3 | ~~Will reach $50B~~ | bet | garry | 0.7 | 2026-04-29 → 2026-06 | superseded by #4 |
 *   | 4 | Will reach $30B | bet | garry | 0.55 | 2026-06 | revised after Q2 numbers |
 *   <!--- gbrain:takes:end -->
 *
 * Parsing rules (Codex P1 #8 fold — strict on canonical, lenient on hand-edits):
 *
 * - Strict shape (clean header + 8 cells per row including leading/trailing |)
 *   parses without warning.
 * - Strikethrough `~~claim~~` → active=false; the inner text is parsed.
 * - Date ranges in `since` (`2022-01 → 2026-06` or `2022-01 -> 2026-06`)
 *   split into `since_date` + `until_date`.
 * - Weight is parsed as float; out-of-range values [0,1] are clamped at the
 *   engine layer (TAKES_WEIGHT_CLAMPED), not here.
 * - Malformed rows (wrong cell count, non-numeric weight, unknown kind) are
 *   skipped. The fence parser returns the parsed-OK rows + a `warnings` list
 *   so callers (extract, doctor) can surface `TAKES_TABLE_MALFORMED`.
 *
 * Append-only semantics (CEO-D6 + eng-D9): `upsertTakeRow` always appends
 * to the end of the table. `supersedeRow` strikes through the target row's
 * claim + appends a new row. Cross-page refs `slug#N` and synthesis_evidence
 * stay valid forever because no row_num ever shifts.
 */

export type TakeKind = 'fact' | 'take' | 'bet' | 'hunch';

export interface ParsedTake {
  rowNum: number;
  claim: string;        // strikethrough markers stripped; inner text only
  kind: TakeKind;
  holder: string;       // 'world' | 'garry' | 'brain' | <slug>
  weight: number;       // 0..1 (raw — may be out of range; engine clamps)
  sinceDate?: string;   // ISO 'YYYY-MM-DD' or 'YYYY-MM' (caller's choice)
  untilDate?: string;
  source?: string;
  active: boolean;      // false when claim was wrapped in ~~ ~~
}

export interface ParseResult {
  takes: ParsedTake[];
  warnings: string[];
}

// HTML-comment fence markers — verbatim per spec.
export const TAKES_FENCE_BEGIN = '<!--- gbrain:takes:begin -->';
export const TAKES_FENCE_END   = '<!--- gbrain:takes:end -->';

const KIND_VALUES: ReadonlySet<string> = new Set(['fact', 'take', 'bet', 'hunch']);

// Match a markdown table row's cell-stripped content. Allows surrounding
// whitespace and tolerates trailing `|`.
function parseRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  // Strip leading and trailing pipes, split on `|`, trim cells.
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map(c => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^[-:\s]+$/.test(c)) && cells.length > 0;
}

function stripStrikethrough(s: string): { text: string; struck: boolean } {
  const m = s.match(/^~~(.+?)~~$/);
  if (m) return { text: m[1].trim(), struck: true };
  return { text: s, struck: false };
}

function parseSinceCell(raw: string): { since?: string; until?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // Range syntax: `2022-01 → 2026-06` or `2022-01 -> 2026-06`
  const rangeMatch = trimmed.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (rangeMatch) {
    return { since: rangeMatch[1].trim(), until: rangeMatch[2].trim() };
  }
  return { since: trimmed };
}

/**
 * Slice the body between the fence markers and parse the table.
 * Returns empty takes + empty warnings when no fence is present.
 */
export function parseTakesFence(body: string): ParseResult {
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  const endIdx   = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  const warnings: string[] = [];

  if (beginIdx === -1 && endIdx === -1) return { takes: [], warnings };
  if (beginIdx === -1 || endIdx === -1) {
    warnings.push('TAKES_FENCE_UNBALANCED: missing begin or end marker');
    return { takes: [], warnings };
  }
  if (endIdx < beginIdx) {
    warnings.push('TAKES_FENCE_UNBALANCED: end marker before begin');
    return { takes: [], warnings };
  }

  const inner = body.slice(beginIdx + TAKES_FENCE_BEGIN.length, endIdx);
  const lines = inner.split('\n');
  const takes: ParsedTake[] = [];
  let sawHeader = false;
  const seenRowNums = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;

    // Header row: `| # | claim | kind | who | weight | since | source |`
    if (!sawHeader) {
      // Best-effort detection: header has 'claim' and 'kind' tokens.
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('claim') && lower.includes('kind')) {
        sawHeader = true;
        continue;
      }
      // First content row before header — skip with warning.
      warnings.push(`TAKES_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }

    // Separator row (just dashes/colons) — skip.
    if (isSeparatorRow(cells)) continue;

    // Expect 7 cells: row_num, claim, kind, holder, weight, since, source.
    if (cells.length < 6) {
      warnings.push(`TAKES_TABLE_MALFORMED: only ${cells.length} cells in row "${line.trim()}"`);
      continue;
    }

    const [rowNumStr, claimRaw, kindRaw, holderRaw, weightRaw, sinceRaw, sourceRaw = ''] = cells;
    const rowNum = parseInt(rowNumStr, 10);
    if (!Number.isFinite(rowNum) || rowNum <= 0) {
      warnings.push(`TAKES_TABLE_MALFORMED: invalid row_num "${rowNumStr}"`);
      continue;
    }
    if (seenRowNums.has(rowNum)) {
      warnings.push(`TAKES_ROW_NUM_COLLISION: duplicate row_num ${rowNum}`);
      continue;
    }
    seenRowNums.add(rowNum);

    const kind = kindRaw.trim().toLowerCase();
    if (!KIND_VALUES.has(kind)) {
      warnings.push(`TAKES_TABLE_MALFORMED: unknown kind "${kindRaw}" (expected fact|take|bet|hunch)`);
      continue;
    }

    const weight = parseFloat(weightRaw);
    if (!Number.isFinite(weight)) {
      warnings.push(`TAKES_TABLE_MALFORMED: non-numeric weight "${weightRaw}"`);
      continue;
    }

    const { text: claimText, struck } = stripStrikethrough(claimRaw);
    const { since, until } = parseSinceCell(sinceRaw);

    takes.push({
      rowNum,
      claim: claimText,
      kind: kind as TakeKind,
      holder: holderRaw.trim(),
      weight,
      sinceDate: since,
      untilDate: until,
      source: sourceRaw.trim() || undefined,
      active: !struck,
    });
  }

  if (!sawHeader && takes.length === 0 && lines.some(l => l.trim().startsWith('|'))) {
    warnings.push('TAKES_TABLE_MALFORMED: pipe-rows present but no recognizable header');
  }

  return { takes, warnings };
}

/**
 * Render a takes array back to a fenced markdown table. Round-trip safe
 * with parseTakesFence. Output uses tight column padding (one space per
 * side) — readable but not pretty-printed.
 */
export function renderTakesFence(takes: ParsedTake[]): string {
  const header = `| # | claim | kind | who | weight | since | source |`;
  const separator = `|---|-------|------|-----|--------|-------|--------|`;
  const rows = takes.map(t => {
    const claimCell = t.active ? t.claim : `~~${t.claim}~~`;
    const sinceCell = t.untilDate ? `${t.sinceDate ?? ''} → ${t.untilDate}` : (t.sinceDate ?? '');
    const w = formatWeight(t.weight);
    const source = t.source ?? '';
    // Escape any pipes inside cells so the table doesn't break.
    const safe = (s: string) => s.replace(/\|/g, '\\|');
    return `| ${t.rowNum} | ${safe(claimCell)} | ${t.kind} | ${safe(t.holder)} | ${w} | ${safe(sinceCell)} | ${safe(source)} |`;
  });
  const inner = ['', header, separator, ...rows, ''].join('\n');
  return `${TAKES_FENCE_BEGIN}${inner}${TAKES_FENCE_END}`;
}

function formatWeight(w: number): string {
  // Match common spec form: 1.0, 0.85, 0.7. Strip trailing zeros except one.
  if (Number.isInteger(w)) return w.toFixed(1);
  return String(parseFloat(w.toFixed(2)));
}

/**
 * Append a new take row to the body. If a fenced takes table exists, the
 * row is added to the end of it. If not, a new `## Takes` section + fence
 * is created at the end of the body.
 *
 * Append-only per CEO-D6 + eng-D9: row_num is set to (max existing rowNum
 * in the fence) + 1. Stable forever.
 *
 * `claim`, `kind`, `holder` of the input are required; `weight` defaults
 * to 0.5 if omitted; `active` defaults to true.
 */
export function upsertTakeRow(
  body: string,
  newRow: Omit<ParsedTake, 'rowNum'> & { rowNum?: number },
): { body: string; rowNum: number } {
  const { takes, warnings } = parseTakesFence(body);
  // Surface warnings to caller via an attached marker — caller decides what to do.
  // (We don't throw here so writes proceed; doctor surfaces the underlying issue.)
  void warnings;
  const nextRowNum = newRow.rowNum
    ?? (takes.length > 0 ? Math.max(...takes.map(t => t.rowNum)) + 1 : 1);

  const allRows: ParsedTake[] = [
    ...takes,
    {
      rowNum: nextRowNum,
      claim: newRow.claim,
      kind: newRow.kind,
      holder: newRow.holder,
      weight: newRow.weight ?? 0.5,
      sinceDate: newRow.sinceDate,
      untilDate: newRow.untilDate,
      source: newRow.source,
      active: newRow.active ?? true,
    },
  ];

  const newFence = renderTakesFence(allRows);

  // If fence already exists, replace it. Otherwise append a Takes section.
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  const endIdx   = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  let out: string;
  if (beginIdx !== -1 && endIdx !== -1) {
    out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
  } else {
    // No fence yet — append a fresh Takes section at the end.
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    out = `${body}${sep}## Takes\n\n${newFence}\n`;
  }
  return { body: out, rowNum: nextRowNum };
}

/**
 * Supersede an existing row: strike through the target row's claim AND
 * append a new row at the end with the new claim. Both rows preserved
 * in markdown for git-blame archaeology. Returns oldRowNum + newRowNum.
 *
 * Throws when the target row is not found in the fence.
 */
export function supersedeRow(
  body: string,
  oldRowNum: number,
  replacement: Omit<ParsedTake, 'rowNum' | 'active'>,
): { body: string; oldRowNum: number; newRowNum: number } {
  const { takes } = parseTakesFence(body);
  const idx = takes.findIndex(t => t.rowNum === oldRowNum);
  if (idx === -1) {
    throw new Error(`supersedeRow: row #${oldRowNum} not found in takes fence`);
  }
  const oldClaim = takes[idx].claim;
  const newRowNum = takes.length > 0 ? Math.max(...takes.map(t => t.rowNum)) + 1 : 1;

  // Mark old row inactive; append new row.
  const updatedTakes: ParsedTake[] = takes.map((t, i) =>
    i === idx ? { ...t, active: false } : t,
  );
  updatedTakes.push({
    rowNum: newRowNum,
    claim: replacement.claim,
    kind: replacement.kind,
    holder: replacement.holder,
    weight: replacement.weight,
    sinceDate: replacement.sinceDate,
    untilDate: replacement.untilDate,
    source: replacement.source ?? `superseded by #${newRowNum}`,
    active: true,
  });
  void oldClaim; // Reserved for future "show what changed" diff helper.

  const newFence = renderTakesFence(updatedTakes);
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  const endIdx   = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error('supersedeRow: fence markers missing in body (unexpected — parseTakesFence found rows)');
  }
  const out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
  return { body: out, oldRowNum, newRowNum };
}

/**
 * Strip the fenced takes block from the body. Used by the chunker so takes
 * content lives ONLY in the takes table, not duplicated in page chunks
 * (Codex P0 #3 privacy fix). When no fence is present, returns body
 * unchanged.
 */
export function stripTakesFence(body: string): string {
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  if (beginIdx === -1) return body;
  const endIdx = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  if (endIdx === -1) return body;
  return body.slice(0, beginIdx) + body.slice(endIdx + TAKES_FENCE_END.length);
}
