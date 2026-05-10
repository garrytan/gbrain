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

export type TakeQuality = 'correct' | 'incorrect' | 'partial';

export interface ParsedTake {
  rowNum: number;
  claim: string;        // strikethrough markers stripped; inner text only
  kind: TakeKind;
  /**
   * Who HOLDS this belief — the person asserting/endorsing it.
   * NOT the person the belief is ABOUT (that's the subject, implicit in the claim).
   *
   * Cross-modal eval (2026-05-10, 3 frontier models on 100K takes) found
   * holder/subject confusion was the #1 attribution error (6.5/10).
   *
   * The test: "Did this person SAY or CLEARLY IMPLY this?"
   *   YES → holder = people/slug
   *   NO, it's your analysis of them → holder = brain
   *
   * Examples:
   *   ✅ holder=people/garry-tan claim="AI will replace 50% of coding" (Garry SAID this)
   *   ✅ holder=brain claim="Garry has a hero/rescuer pattern" (analysis OF Garry)
   *   ✅ holder=people/bo-lu claim="We can hit $10M ARR" (Bo Lu SAID this)
   *   ❌ holder=people/garry-tan claim="Garry has a hero/rescuer pattern" (not his belief)
   *   ❌ holder=companies/hermes claim="Latency is 15-20s" (Zain said it → people/zain)
   *
   * Values: 'world' (consensus fact) | 'people/<slug>' (individual's stated belief) |
   *         'companies/<slug>' (institutional fact, no individual claimant) |
   *         'brain' (AI-inferred when holder is genuinely ambiguous)
   *
   * Additional rules from production eval:
   *   - Amplification ≠ endorsement: retweet-only → max weight 0.55
   *   - Self-reported ≠ verified: "Saif reports 7 figures" → people/saif, NOT world
   *   - Founder describing company → people/founder, NOT companies/slug
   */
  holder: string;
  weight: number;       // 0..1 (raw — may be out of range; engine clamps). Prefer 0.05 increments.
  sinceDate?: string;   // ISO 'YYYY-MM-DD' or 'YYYY-MM' (caller's choice)
  untilDate?: string;
  source?: string;
  active: boolean;      // false when claim was wrapped in ~~ ~~
  // v0.30.0 (Slice A1) resolution fields. Optional + always undefined on
  // unresolved rows. The renderer emits the resolved/quality/evidence/value/
  // unit/by columns ONLY when at least one row on the page has resolvedQuality
  // set; pages with no resolved rows keep their narrow 7-column shape.
  // Round-trip preservation through cmdUpdate/cmdSupersede is the codex F3
  // safety net — without it, every update after a resolve silently deletes
  // the resolution data on the next render.
  resolvedAt?: string;       // ISO timestamp 'YYYY-MM-DD' or full ISO
  resolvedQuality?: TakeQuality;
  resolvedOutcome?: boolean; // back-compat boolean; derivable from quality
  resolvedEvidence?: string; // human note (alias for resolved_source)
  resolvedValue?: number;
  resolvedUnit?: string;
  resolvedBy?: string;       // slug or 'garry'
}

export interface ParseResult {
  takes: ParsedTake[];
  warnings: string[];
}

// HTML-comment fence markers — verbatim per spec.
export const TAKES_FENCE_BEGIN = '<!--- gbrain:takes:begin -->';
export const TAKES_FENCE_END   = '<!--- gbrain:takes:end -->';

const KIND_VALUES: ReadonlySet<string> = new Set(['fact', 'take', 'bet', 'hunch']);
const QUALITY_VALUES: ReadonlySet<string> = new Set(['correct', 'incorrect', 'partial']);

// v0.30.0: header tokens that mark a v0.30-shape fence. Presence of `quality`
// (or any other resolution column) widens the parser to read 7+ extra cells
// per row. Missing tokens → v0.28 7-column shape, parsed exactly as before.
const RESOLUTION_HEADER_TOKENS = ['resolved', 'quality', 'evidence', 'value', 'unit', 'by'] as const;
type ResolutionColumn = typeof RESOLUTION_HEADER_TOKENS[number];

function parseQualityCell(raw: string): TakeQuality | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (QUALITY_VALUES.has(trimmed)) return trimmed as TakeQuality;
  return undefined;
}

function parseFloatCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a weight for storage. Single source of truth used by both engines
 * at all 4 takes write sites (addTakesBatch + updateTake × postgres + pglite).
 *
 * Pipeline:
 *   1. NaN / Infinity / -Infinity → 0.5 (default), clamped=true.
 *   2. Out of [0, 1] → clamp to [0, 1], clamped=true.
 *   3. Round to 0.05 grid (cross-modal eval over 100K takes flagged 0.74,
 *      0.82-style values as false precision; the engine layer enforces a
 *      coarser grid that matches actual calibration accuracy).
 *
 * 0 and 1 round to themselves exactly (Math.round(20)/20 = 1.0,
 * Math.round(0)/20 = 0). The clamped flag is the trigger for the engine's
 * TAKES_WEIGHT_CLAMPED stderr counter; rounding alone does NOT set it.
 *
 * `undefined` and `null` inputs return 0.5 with clamped=false (the default
 * weight when a fence row omits the column).
 */
export function normalizeWeightForStorage(
  raw: number | null | undefined,
): { weight: number; clamped: boolean } {
  let w = raw ?? 0.5;
  let clamped = false;
  if (!Number.isFinite(w)) {
    clamped = true;
    w = 0.5;
  } else if (w < 0 || w > 1) {
    clamped = true;
    w = Math.max(0, Math.min(1, w));
  }
  return { weight: Math.round(w * 20) / 20, clamped };
}

function parseStringCell(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

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
  // Map from resolution column name → cell index in the row. Empty when the
  // fence is a v0.28 7-column shape; populated when resolution columns appear.
  const resolutionColIdx: Partial<Record<ResolutionColumn, number>> = {};
  const seenRowNums = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;

    // Header row: `| # | claim | kind | who | weight | since | source |`
    // (v0.28 7-column shape) OR with extra `| resolved | quality | evidence
    // | value | unit | by |` columns appended (v0.30 13-column shape).
    if (!sawHeader) {
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('claim') && lower.includes('kind')) {
        sawHeader = true;
        // Detect v0.30 resolution columns. Columns are positional, but tolerate
        // any subset (forward-compat: future schemas might add more).
        for (const tok of RESOLUTION_HEADER_TOKENS) {
          const idx = lower.indexOf(tok);
          if (idx !== -1) resolutionColIdx[tok] = idx;
        }
        continue;
      }
      // First content row before header — skip with warning.
      warnings.push(`TAKES_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }

    // Separator row (just dashes/colons) — skip.
    if (isSeparatorRow(cells)) continue;

    // Expect 7 cells minimum: row_num, claim, kind, holder, weight, since, source.
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

    // v0.30 resolution columns. Only populated when the header contained the
    // matching tokens AND the row has cells at those positions.
    const cellAt = (col: ResolutionColumn): string | undefined => {
      const idx = resolutionColIdx[col];
      if (idx === undefined) return undefined;
      return idx < cells.length ? cells[idx] : undefined;
    };
    const resolvedAt        = cellAt('resolved');
    const qualityRaw        = cellAt('quality');
    const evidenceRaw       = cellAt('evidence');
    const valueRaw          = cellAt('value');
    const unitRaw           = cellAt('unit');
    const byRaw             = cellAt('by');
    const resolvedQuality   = qualityRaw !== undefined ? parseQualityCell(qualityRaw) : undefined;
    // Derive resolvedOutcome from quality so the parsed shape is self-consistent
    // for callers that read either field.
    const resolvedOutcome   = resolvedQuality === 'correct'   ? true
                            : resolvedQuality === 'incorrect' ? false
                            :                                    undefined;

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
      resolvedAt:        resolvedAt        ? parseStringCell(resolvedAt)  : undefined,
      resolvedQuality,
      resolvedOutcome,
      resolvedEvidence:  evidenceRaw       ? parseStringCell(evidenceRaw) : undefined,
      resolvedValue:     valueRaw          ? parseFloatCell(valueRaw)     : undefined,
      resolvedUnit:      unitRaw           ? parseStringCell(unitRaw)     : undefined,
      resolvedBy:        byRaw             ? parseStringCell(byRaw)       : undefined,
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
 *
 * v0.30.0 (Slice A1, codex F3 fix): conditional render of resolution
 * columns. When ANY take in the array has `resolvedQuality !== undefined`,
 * the renderer widens the table to 13 columns (`# | claim | kind | who |
 * weight | since | source | resolved | quality | evidence | value | unit |
 * by |`). Pages with no resolved rows keep the narrow 7-column shape
 * exactly as v0.28 emitted. The parser tolerates both shapes.
 *
 * Round-trip preservation is the safety net for the silent-data-loss bug
 * codex caught: every CLI that re-renders a fence (cmdUpdate, cmdSupersede,
 * cmdAdd) must read existing rows via parseTakesFence and pass them
 * through to renderTakesFence so resolution data on resolved rows survives
 * unrelated edits to other rows on the same page. The
 * round-trip-preservation test in test/takes-fence.test.ts is the
 * regression gate.
 */
export function renderTakesFence(takes: ParsedTake[]): string {
  const hasAnyResolution = takes.some(t => t.resolvedQuality !== undefined);
  const header = hasAnyResolution
    ? `| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |`
    : `| # | claim | kind | who | weight | since | source |`;
  const separator = hasAnyResolution
    ? `|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|`
    : `|---|-------|------|-----|--------|-------|--------|`;
  const rows = takes.map(t => {
    const claimCell = t.active ? t.claim : `~~${t.claim}~~`;
    const sinceCell = t.untilDate ? `${t.sinceDate ?? ''} → ${t.untilDate}` : (t.sinceDate ?? '');
    const w = formatWeight(t.weight);
    const source = t.source ?? '';
    // Escape any pipes inside cells so the table doesn't break.
    const safe = (s: string) => s.replace(/\|/g, '\\|');
    const baseCells = `| ${t.rowNum} | ${safe(claimCell)} | ${t.kind} | ${safe(t.holder)} | ${w} | ${safe(sinceCell)} | ${safe(source)} |`;
    if (!hasAnyResolution) return baseCells;
    // Resolution cells. Empty string for unresolved rows keeps the table
    // visually clean; the parser treats empty cells as undefined fields.
    const resolved   = t.resolvedAt       ? safe(t.resolvedAt)              : '';
    const quality    = t.resolvedQuality  ?? '';
    const evidence   = t.resolvedEvidence ? safe(t.resolvedEvidence)        : '';
    const value      = t.resolvedValue !== undefined ? formatWeight(t.resolvedValue) : '';
    const unit       = t.resolvedUnit     ? safe(t.resolvedUnit)            : '';
    const by         = t.resolvedBy       ? safe(t.resolvedBy)              : '';
    return `${baseCells} ${resolved} | ${quality} | ${evidence} | ${value} | ${unit} | ${by} |`;
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
