/**
 * v0.32.2: parser/renderer for fenced facts tables.
 *
 * The `## Facts` fence on an entity page is the system-of-record for facts
 * about that entity. The `facts` DB table is a derived index reconciled by
 * the new `extract_facts` cycle phase. This module is the boundary between
 * the markdown and the DB.
 *
 * Structural mirror of `src/core/takes-fence.ts`. Same fence-shape
 * primitives, same strict-canonical-lenient-hand-edit posture, same
 * append-only row_num contract. Different column set:
 *
 *   ## Facts
 *
 *   <!--- gbrain:facts:begin -->
 *   | # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
 *   |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
 *   | 1 | Founded Acme in 2017             | fact       | 1.0  | world   | high   | 2017-01-01 |            | linkedin       |                                    |
 *   | 2 | Prefers async over meetings      | preference | 0.85 | private | medium | 2026-04-29 |            | OH 2026-04-29  |                                    |
 *   | 3 | ~~Will hit $10M ARR by Q4~~      | commitment | 0.55 | world   | medium | 2026-06-01 | 2026-12-31 | bo call        | superseded by #4                   |
 *   | 4 | ~~Used to live in Tokyo~~        | fact       | 0.9  | private | low    | 2018-01-01 | 2026-05-10 | inferred       | forgotten: user asked to remove    |
 *   <!--- gbrain:facts:end -->
 *
 * 10 data columns + the leading `#` row-number column = 11 cells per row
 * including the leading and trailing pipes.
 *
 * Strikethrough parse contract (resolves Codex R2-#3 forget-as-fence):
 *   - `~~claim~~` + `context: superseded by #N` → active=false, supersededBy=N
 *   - `~~claim~~` + `context: forgotten: <reason>` → active=false, forgotten=true
 *   - `~~claim~~` + anything else in context → active=false, both flags null
 *
 * The semantic layer (commit 3's `extract-from-fence.ts`) maps `forgotten`
 * to `valid_until = today` so the DB's `expired_at` derives correctly via
 * the existing `expired_at = valid_until + now()` rule.
 *
 * Both fences share row-level helpers via `./fence-shared.ts` — see that
 * module for `parseRowCells`, `isSeparatorRow`, `stripStrikethrough`, and
 * `escapeFenceCell`. Domain-specific parsing (column ordering, kind/
 * visibility/notability enums, the strikethrough-context distinction)
 * lives in this file.
 */

import {
  parseRowCells,
  isSeparatorRow,
  stripStrikethrough,
  parseStringCell,
  escapeFenceCell,
} from './fence-shared.ts';

// HTML-comment fence markers — verbatim per spec. Same shape as the takes
// fence markers so anyone who's seen one immediately recognizes the other.
export const FACTS_FENCE_BEGIN = '<!--- gbrain:facts:begin -->';
export const FACTS_FENCE_END   = '<!--- gbrain:facts:end -->';

// Mirror src/core/engine.ts FactKind. Re-declared (not imported) because
// the fence parser has zero engine dependencies — it must run in pure-
// markdown contexts (the chunker strip, the CI invariant check) where
// importing engine.ts pulls a large DB-shaped transitive graph.
export type FactKind = 'event' | 'preference' | 'commitment' | 'belief' | 'fact';

// Mirror src/core/engine.ts FactVisibility ('private' | 'world'). Binary
// gate per the existing takes D21 contract — drives the chunker strip
// (Layer A) and the get_page response strip (Layer B).
export type FactVisibility = 'private' | 'world';

export type FactNotability = 'high' | 'medium' | 'low';

const KIND_VALUES: ReadonlySet<string> = new Set([
  'event', 'preference', 'commitment', 'belief', 'fact',
]);
const VISIBILITY_VALUES: ReadonlySet<string> = new Set(['private', 'world']);
const NOTABILITY_VALUES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/** Parsed shape of a single fence row. */
export interface ParsedFact {
  rowNum: number;
  claim: string;          // strikethrough markers stripped on parse
  kind: FactKind;
  confidence: number;     // 0..1 (clamp/normalize happens in the engine layer)
  visibility: FactVisibility;
  notability: FactNotability;
  validFrom?: string;     // ISO date 'YYYY-MM-DD' (or empty)
  validUntil?: string;
  source?: string;
  context?: string;
  active: boolean;        // false when claim was wrapped in `~~ ~~`
  /**
   * v0.32.2 strikethrough semantics. Both are mutually exclusive with `active=true`.
   *   - `supersededBy` set: the row was superseded by another fence row;
   *     `context` matches `/superseded by #(\d+)/i`.
   *   - `forgotten` true: the user invoked `gbrain forget` on this row;
   *     `context` matches `/^forgotten:/i`.
   * When neither is set but `active=false`, the row is "inactive for
   * unrecognized reason" — the parser preserves it (markdown source-of-
   * truth contract) but downstream `extract-from-fence` treats it like
   * `forgotten` for DB-derivation purposes.
   */
  supersededBy?: number;
  forgotten?: boolean;
  /**
   * v0.35.4 typed-claim fields (D-CDX-5). Optional. When present, drives
   * `gbrain eval trajectory` + the `find_trajectory` MCP op chronological
   * regression detection. The fence layout widens from 10 to 14 columns
   * when any row in the table has a non-undefined typed field; otherwise
   * stays 10-cell for backward compat with existing fences.
   *
   *   - `claimMetric`: lowercase snake_case after normalization
   *     (`mrr`, `arr`, `team_size`, …). Free-text labels accepted; the
   *     parser does not enforce the seed-map allow-list.
   *   - `claimValue`: numeric, finite. Empty cell → undefined.
   *   - `claimUnit`: free-form unit string (`USD`, `people`, `pct`, …).
   *   - `claimPeriod`: free-form period string (`monthly`, `annual`, …)
   *     or undefined for non-periodic metrics.
   */
  claimMetric?: string;
  claimValue?: number;
  claimUnit?: string;
  claimPeriod?: string;
}

export interface FactsFenceParseResult {
  facts: ParsedFact[];
  warnings: string[];
}

function parseConfidenceCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * v0.35.4 — parse a free-form numeric cell for typed-claim values.
 * Empty / non-numeric → undefined (caller decides whether to drop or warn).
 * Tolerates plain numbers and standard scientific notation. Locale-dependent
 * thousand separators (`,`) are stripped so `50,000` parses to `50000`.
 */
function parseNumericCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(/,/g, '');
  const n = parseFloat(stripped);
  return Number.isFinite(n) ? n : undefined;
}

function parseSupersededByFromContext(context: string | undefined): number | undefined {
  if (!context) return undefined;
  const m = context.match(/superseded by #(\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseForgottenFromContext(context: string | undefined): boolean {
  if (!context) return false;
  return /^forgotten\s*:/i.test(context.trim());
}

/**
 * Slice the body between the fence markers and parse the table.
 * Returns empty facts + empty warnings when no fence is present.
 *
 * Strict on canonical shape, lenient on hand-edits — malformed rows are
 * skipped with a warning, the rest of the table still parses. Callers
 * (extract-facts cycle phase, doctor) surface warnings as
 * `FACTS_TABLE_MALFORMED` sync-failures entries.
 */
export function parseFactsFence(body: string): FactsFenceParseResult {
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx   = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  const warnings: string[] = [];

  if (beginIdx === -1 && endIdx === -1) return { facts: [], warnings };
  if (beginIdx === -1 || endIdx === -1) {
    warnings.push('FACTS_FENCE_UNBALANCED: missing begin or end marker');
    return { facts: [], warnings };
  }
  if (endIdx < beginIdx) {
    warnings.push('FACTS_FENCE_UNBALANCED: end marker before begin');
    return { facts: [], warnings };
  }

  const inner = body.slice(beginIdx + FACTS_FENCE_BEGIN.length, endIdx);
  const lines = inner.split('\n');
  const facts: ParsedFact[] = [];
  let sawHeader = false;
  const seenRowNums = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;

    // Header row: cells include 'claim' and 'kind' (case-insensitive).
    if (!sawHeader) {
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('claim') && lower.includes('kind')) {
        sawHeader = true;
        continue;
      }
      warnings.push(`FACTS_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }

    // Separator row (just dashes/colons) — skip.
    if (isSeparatorRow(cells)) continue;

    // Expect 10 cells (legacy 10-cell fence) OR 14 cells (v0.35.4
    // typed-claim wide fence): row_num, claim, kind, confidence,
    // visibility, notability, valid_from, valid_until, source, context,
    // [claim_metric, claim_value, claim_unit, claim_period].
    // Tolerate 9 (missing trailing context cell) — markdown editors often
    // drop empty trailing cells.
    if (cells.length < 9) {
      warnings.push(`FACTS_TABLE_MALFORMED: only ${cells.length} cells in row "${line.trim()}"`);
      continue;
    }

    const [
      rowNumStr, claimRaw, kindRaw, confidenceRaw,
      visibilityRaw, notabilityRaw,
      validFromRaw, validUntilRaw,
      sourceRaw,
      contextRaw = '',
      claimMetricRaw = '',
      claimValueRaw = '',
      claimUnitRaw = '',
      claimPeriodRaw = '',
    ] = cells;

    const rowNum = parseInt(rowNumStr, 10);
    if (!Number.isFinite(rowNum) || rowNum <= 0) {
      warnings.push(`FACTS_TABLE_MALFORMED: invalid row_num "${rowNumStr}"`);
      continue;
    }
    if (seenRowNums.has(rowNum)) {
      warnings.push(`FACTS_ROW_NUM_COLLISION: duplicate row_num ${rowNum}`);
      continue;
    }
    seenRowNums.add(rowNum);

    const kind = kindRaw.trim().toLowerCase();
    if (!KIND_VALUES.has(kind)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown kind "${kindRaw}" (expected event|preference|commitment|belief|fact)`);
      continue;
    }

    const visibility = visibilityRaw.trim().toLowerCase();
    if (!VISIBILITY_VALUES.has(visibility)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown visibility "${visibilityRaw}" (expected private|world)`);
      continue;
    }

    const notability = notabilityRaw.trim().toLowerCase();
    if (!NOTABILITY_VALUES.has(notability)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown notability "${notabilityRaw}" (expected high|medium|low)`);
      continue;
    }

    const confidence = parseConfidenceCell(confidenceRaw);
    if (confidence === undefined) {
      warnings.push(`FACTS_TABLE_MALFORMED: non-numeric confidence "${confidenceRaw}" in row ${rowNumStr}`);
      continue;
    }

    const { text: claimText, struck } = stripStrikethrough(claimRaw);
    const context = parseStringCell(contextRaw);
    const supersededBy = parseSupersededByFromContext(context);
    const forgotten    = parseForgottenFromContext(context);

    facts.push({
      rowNum,
      claim: claimText,
      kind: kind as FactKind,
      confidence,
      visibility: visibility as FactVisibility,
      notability: notability as FactNotability,
      validFrom:  parseStringCell(validFromRaw),
      validUntil: parseStringCell(validUntilRaw),
      source:     parseStringCell(sourceRaw),
      context,
      active: !struck,
      supersededBy,
      forgotten: struck ? forgotten : false,
      // v0.35.4 — typed-claim fields, all optional.
      claimMetric: parseStringCell(claimMetricRaw),
      claimValue:  parseNumericCell(claimValueRaw),
      claimUnit:   parseStringCell(claimUnitRaw),
      claimPeriod: parseStringCell(claimPeriodRaw),
    });
  }

  if (!sawHeader && facts.length === 0 && lines.some(l => l.trim().startsWith('|'))) {
    warnings.push('FACTS_TABLE_MALFORMED: pipe-rows present but no recognizable header');
  }

  return { facts, warnings };
}

function formatConfidence(c: number): string {
  if (Number.isInteger(c)) return c.toFixed(1);
  return String(parseFloat(c.toFixed(2)));
}

/**
 * Render a facts array back to a fenced markdown table. Round-trip safe
 * with parseFactsFence. Same tight-column-padding posture as takes-fence
 * (one space per side, readable but not pretty-printed).
 *
 * Round-trip preservation is the safety net for the system-of-record
 * invariant: every CLI that re-renders a fence (forgetFactInFence,
 * upsertFactRow, the v0_32_2 migration backfill) must read existing rows
 * via parseFactsFence and pass them through renderFactsTable so existing
 * fence state survives unrelated edits to other rows.
 */
export function renderFactsTable(facts: ParsedFact[]): string {
  // v0.35.4 (D-CDX-5): widen to 14 cells when ANY row has a non-undefined
  // typed-claim field. Otherwise stay at the 10-cell legacy shape so
  // existing fences don't get widened on unrelated rewrites (no churn diff
  // noise).
  const anyTyped = facts.some(f =>
    f.claimMetric !== undefined ||
    f.claimValue  !== undefined ||
    f.claimUnit   !== undefined ||
    f.claimPeriod !== undefined,
  );
  const header = anyTyped
    ? `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |`
    : `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |`;
  const separator = anyTyped
    ? `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|`
    : `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|`;
  const rows = facts.map(f => {
    const claimCell = f.active ? f.claim : `~~${f.claim}~~`;
    const base = `| ${f.rowNum} | ${escapeFenceCell(claimCell)} | ${f.kind} | ${formatConfidence(f.confidence)} | ${f.visibility} | ${f.notability} | ${escapeFenceCell(f.validFrom ?? '')} | ${escapeFenceCell(f.validUntil ?? '')} | ${escapeFenceCell(f.source ?? '')} | ${escapeFenceCell(f.context ?? '')} |`;
    if (!anyTyped) return base;
    const valueCell = f.claimValue === undefined ? '' : String(f.claimValue);
    return `${base} ${escapeFenceCell(f.claimMetric ?? '')} | ${escapeFenceCell(valueCell)} | ${escapeFenceCell(f.claimUnit ?? '')} | ${escapeFenceCell(f.claimPeriod ?? '')} |`;
  });
  const inner = ['', header, separator, ...rows, ''].join('\n');
  return `${FACTS_FENCE_BEGIN}${inner}${FACTS_FENCE_END}`;
}

/**
 * Append a new fact row to the body. If a fenced facts table exists, the
 * row is added to the end of it. If not, a new `## Facts` section + fence
 * is created at the end of the body.
 *
 * Append-only — row_num is set to (max existing rowNum in the fence) + 1.
 * Stable forever, so cross-page refs like `<slug>#F<N>` keep pointing at
 * the same row.
 */
export function upsertFactRow(
  body: string,
  newRow: Omit<ParsedFact, 'rowNum' | 'active' | 'supersededBy' | 'forgotten'> & {
    rowNum?: number;
    active?: boolean;
  },
): { body: string; rowNum: number } {
  const { facts } = parseFactsFence(body);
  const nextRowNum = newRow.rowNum
    ?? (facts.length > 0 ? Math.max(...facts.map(f => f.rowNum)) + 1 : 1);

  const allRows: ParsedFact[] = [
    ...facts,
    {
      rowNum: nextRowNum,
      claim: newRow.claim,
      kind: newRow.kind,
      confidence: newRow.confidence,
      visibility: newRow.visibility,
      notability: newRow.notability,
      validFrom: newRow.validFrom,
      validUntil: newRow.validUntil,
      source: newRow.source,
      context: newRow.context,
      active: newRow.active ?? true,
      // v0.35.4 — typed-claim pass-through. When undefined the renderer
      // stays at the 10-cell shape so unrelated edits don't widen the
      // fence.
      claimMetric: newRow.claimMetric,
      claimValue:  newRow.claimValue,
      claimUnit:   newRow.claimUnit,
      claimPeriod: newRow.claimPeriod,
    },
  ];

  const newFence = renderFactsTable(allRows);

  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx   = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  let out: string;
  if (beginIdx !== -1 && endIdx !== -1) {
    out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + FACTS_FENCE_END.length);
  } else {
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    out = `${body}${sep}## Facts\n\n${newFence}\n`;
  }
  return { body: out, rowNum: nextRowNum };
}

export interface StripFactsFenceOpts {
  /**
   * Visibility values to KEEP in the rendered output. When omitted (the
   * default), the entire fence block is removed wholesale — matches
   * `stripTakesFence`'s contract and is what the chunker uses to keep
   * private text out of `content_chunks.chunk_text` (Codex R2-#1 P0 fix
   * + simpler than per-row filtering).
   *
   * When set to e.g. `['world']`, the function preserves the fence
   * structure but removes rows whose visibility is not in the allow-list.
   * Used by `get_page` for remote MCP callers to ship a useful response
   * (world facts visible) while keeping private rows on the boundary's
   * inside.
   */
  keepVisibility?: FactVisibility[];
}

/**
 * Strip facts content from the body for downstream consumers that must
 * not see (some or all of) it. Two modes:
 *
 *   1. No `keepVisibility` (or empty array): drop the entire fence
 *      block — same posture as `stripTakesFence`. Useful when a caller
 *      wants the body without ANY fence content (rare in practice; the
 *      privacy-boundary callers all want partial retention).
 *
 *   2. `keepVisibility: ['world']`: retain only world-visibility rows.
 *      The fence shape stays in the body so a re-importer can still
 *      round-trip the response; private rows are dropped at the row
 *      level. This is the mode BOTH the chunker (Codex R2-#1 — keeps
 *      world rows searchable, drops private text from
 *      `content_chunks.chunk_text` + embeddings + search) AND `get_page`
 *      over remote MCP (Codex Q5 — restricted callers see world rows
 *      only) use.
 *
 * The default whole-fence strip is the "deny-by-default" branch for any
 * caller that forgets to specify allowed visibility — a safer failure
 * mode at a privacy boundary than accidentally leaking.
 *
 * Returns the body unchanged when no fence is present.
 */
export function stripFactsFence(body: string, opts: StripFactsFenceOpts = {}): string {
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  if (beginIdx === -1) return body;
  const endIdx = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  if (endIdx === -1) return body;

  // Whole-fence strip mode (chunker case).
  if (!opts.keepVisibility || opts.keepVisibility.length === 0) {
    return body.slice(0, beginIdx) + body.slice(endIdx + FACTS_FENCE_END.length);
  }

  // Selective row-level strip mode (get_page case). Parse, filter, render.
  // The parser's lenient posture means malformed rows are silently dropped,
  // which is the safe direction at a privacy boundary — when in doubt,
  // strip rather than leak.
  const { facts } = parseFactsFence(body);
  const keep = new Set(opts.keepVisibility);
  const kept = facts.filter(f => keep.has(f.visibility));
  const replacement = renderFactsTable(kept);
  return body.slice(0, beginIdx) + replacement + body.slice(endIdx + FACTS_FENCE_END.length);
}
