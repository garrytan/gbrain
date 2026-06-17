/**
 * v0.28: structured-citations → inline-marker rendering for `gbrain think`.
 *
 * The model's structured output gives us:
 *   citations: [{page_slug, row_num | null, citation_index}, ...]
 *   answer: "...inline [slug#row] markers..."
 *
 * Trust contract:
 *   1. ALWAYS prefer the structured citations field. It's parseable, indexed,
 *      and matches what gets persisted into synthesis_evidence.
 *   2. If structured field is missing/invalid, fall back to a regex scan of
 *      the answer body for `[slug#row]` and `[slug]` patterns. Codex P1 #4
 *      fold: never fail synthesis because the model omitted citations — log
 *      a warning, persist what we can recover.
 *
 * The body markers stay verbatim. We don't rewrite them; we just normalize
 * them for matching against the structured list.
 */

export interface ParsedCitation {
  page_slug: string;
  row_num: number | null;     // null = page-level citation, set = take citation
  citation_index: number;     // 1-based order in the body
}

/**
 * Extract citation markers from an answer body. Used as the fallback path
 * when the model omits the structured citations field.
 *
 * Recognizes:
 *   [slug#3]                           → take citation
 *   [slug]                             → page citation
 *   [slug/with/path#7]                 → take citation with multi-segment slug
 *
 * Slugs match validatePageSlug's allowlist (lowercase alphanumeric + hyphens
 * + forward-slash separators). Anything outside that pattern won't match —
 * which is the right answer (random brackets in prose shouldn't promote to
 * citations).
 */
export function parseInlineCitations(body: string): ParsedCitation[] {
  // [a-z0-9][a-z0-9\-]*(/[a-z0-9][a-z0-9\-]*)*  — same shape as validatePageSlug.
  // Optionally followed by #N for take citations.
  const RX = /\[([a-z0-9][a-z0-9\-]*(?:\/[a-z0-9][a-z0-9\-]*)*)(?:#(\d+))?\]/gi;
  const out: ParsedCitation[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  let idx = 1;
  while ((match = RX.exec(body)) !== null) {
    const slug = match[1].toLowerCase();
    const rowStr = match[2];
    const row_num = rowStr ? parseInt(rowStr, 10) : null;
    if (row_num !== null && (!Number.isFinite(row_num) || row_num <= 0)) continue;
    const key = `${slug}#${row_num ?? '_'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ page_slug: slug, row_num, citation_index: idx++ });
  }
  return out;
}

/**
 * Validate a structured citations array from the model. Returns the
 * cleaned list + any warnings about dropped/invalid entries.
 */
export function normalizeStructuredCitations(
  raw: unknown,
): { citations: ParsedCitation[]; warnings: string[] } {
  const citations: ParsedCitation[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { citations, warnings: ['CITATIONS_NOT_ARRAY'] };
  }
  let idx = 1;
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) {
      warnings.push('CITATION_NOT_OBJECT');
      continue;
    }
    const slug = (c as { page_slug?: unknown }).page_slug;
    const row = (c as { row_num?: unknown }).row_num;
    if (typeof slug !== 'string' || !slug.trim()) {
      warnings.push('CITATION_MISSING_SLUG');
      continue;
    }
    let row_num: number | null = null;
    if (row !== null && row !== undefined) {
      const n = typeof row === 'number' ? row : parseInt(String(row), 10);
      if (Number.isFinite(n) && n > 0) {
        row_num = n;
      } else {
        warnings.push(`CITATION_INVALID_ROW(${slug}: ${row})`);
        continue;
      }
    }
    const key = `${slug.toLowerCase()}#${row_num ?? '_'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ page_slug: slug.toLowerCase(), row_num, citation_index: idx++ });
  }
  return { citations, warnings };
}

/**
 * Combine the structured citations + body fallback into a single resolved
 * list. Strategy:
 *   - If structured has any valid entries, use them as the source of truth.
 *   - Otherwise fall back to the inline-marker scan and emit a warning so
 *     callers know the synthesis was rendered without explicit structured
 *     citations.
 */
export function resolveCitations(
  structuredRaw: unknown,
  answerBody: string,
): { citations: ParsedCitation[]; warnings: string[]; usedFallback: boolean } {
  const structured = normalizeStructuredCitations(structuredRaw);
  if (structured.citations.length > 0) {
    return { citations: structured.citations, warnings: structured.warnings, usedFallback: false };
  }
  const fallback = parseInlineCitations(answerBody);
  const warnings = [...structured.warnings, 'CITATIONS_REGEX_FALLBACK'];
  return { citations: fallback, warnings, usedFallback: true };
}
