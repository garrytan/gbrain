/**
 * Tier 1 fence normalizer (#6188): pure, deterministic, free.
 *
 * `normalizeFences(page, ctx)` fixes what has one obvious meaning (a missing
 * end marker with nothing after the table, two-dash takes markers, stray
 * empty cells with exactly one valid deletion, row-number repairs, header
 * aliases and order, header-level write defaults, enum, kind and holder
 * synonyms, percent confidences) and reports the rest as
 * location-only residual issues. A page whose fences already compile is
 * returned unchanged (the same object), and every other byte outside the
 * edited cells, markers and headers is kept verbatim. The result is a fixed
 * point: normalizing it again changes nothing.
 *
 * Callers that must never fail on a normalizer bug use `safeNormalizeFences`,
 * which turns a throw into the residual reason `normalizer_failed`.
 */
import { contentPass } from './content.ts';
import { beforeLine, type MergeOrigins } from './merge.ts';
import { sectionsOf, strictFailures, strictPageClean } from './page-checks.ts';
import { extractRawRows, rowNumOf } from './raw-rows.ts';
import { strayCellPass } from './stray-cells.ts';
import { structuralPass } from './structure.ts';
import type { FenceCtx, FenceFix, FenceIssue, FencePage, FenceSection, StoredRowMap } from './types.ts';

/** Rule-set version; bump when a rule widens. It is part of the hold `fence_version` (`FENCE_VERSION`), so older holds are re-screened. */
export const FENCE_RULES_VERSION = 3;

export interface NormalizeResult<T extends FencePage> {
  page: T;
  fixes: FenceFix[];
  residual: FenceIssue[];
}

/** The section mentions a facts or takes marker (cheap pre-check; no fence work without it). */
export function hasFenceText(text: string | null | undefined): boolean {
  return !!text && (text.includes('gbrain:facts:') || text.includes('gbrain:takes:'));
}

export function normalizeFences<T extends FencePage>(page: T, ctx: FenceCtx): NormalizeResult<T> {
  if (!sectionsOf(page).some(([, text]) => hasFenceText(text)) || strictPageClean(page)) return { page, fixes: [], residual: [] };
  const fixes: FenceFix[] = [];
  const residual: FenceIssue[] = [];
  const texts: Record<FenceSection, string> = { body: '', timeline: '' };
  const merges: MergeOrigins[] = [];
  for (const [section, text] of sectionsOf(page)) {
    const pass = structuralPass(text, section, ctx);
    const stray = strayCellPass(pass.text, section);
    texts[section] = stray.text;
    fixes.push(...pass.fixes, ...stray.fixes);
    residual.push(...pass.residual);
    merges.push(...pass.merges);
  }
  const content = contentPass(texts, ctx, () => Math.max(nextFreeRowNum(page, ctx.storedRows), maxHidden(ctx) + 1), merges);
  fixes.push(...content.fixes);
  residual.push(...content.residual);
  // Rows a merge moved are reported at their line in the before page, where the file still has them.
  if (merges.length) for (const item of [...fixes, ...residual]) item.line = beforeLine(merges, item);
  const out = withSections(page, content.texts);
  if (!residual.length) residual.push(...unparseable(out));
  return { page: out, fixes, residual };
}

/** Like `normalizeFences`, but a thrown error becomes residual `normalizer_failed` and the page is returned unchanged. */
export function safeNormalizeFences<T extends FencePage>(page: T, ctx: FenceCtx): NormalizeResult<T> {
  try {
    return normalizeFences(page, ctx);
  } catch {
    return { page, fixes: [], residual: failedIssues(page) };
  }
}

function failedIssues(page: FencePage): FenceIssue[] {
  const issues: FenceIssue[] = [];
  try {
    for (const [section, text] of sectionsOf(page)) {
      for (const fence of ['facts', 'takes'] as const) {
        if (text.includes(`gbrain:${fence}:`)) issues.push({ fence, section, row: null, column: null, line: null, reason: 'normalizer_failed' });
      }
    }
  } catch {
    // The page itself cannot be read; report one location-free failure below.
  }
  return issues.length ? issues : [{ fence: 'facts', section: 'body', row: null, column: null, line: null, reason: 'normalizer_failed' }];
}

function withSections<T extends FencePage>(page: T, texts: Record<FenceSection, string>): T {
  const sameBody = texts.body === (page.compiled_truth ?? '');
  const sameTimeline = texts.timeline === (page.timeline ?? '');
  if (sameBody && sameTimeline) return page;
  return {
    ...page,
    compiled_truth: sameBody ? page.compiled_truth : texts.body,
    timeline: sameTimeline ? page.timeline : texts.timeline,
  };
}

/** Safety net: a page the rules report clean must compile; anything else is residual `unparseable`. */
function unparseable(page: FencePage): FenceIssue[] {
  return strictFailures(page).map(f => ({
    fence: f.fence, section: f.section ?? 'body', row: f.rows[0] ?? null, column: null, line: null,
    reason: f.check === 'repeated_marker' ? 'repeated_marker' : f.check === 'row_collision' ? 'row_collision' : 'unparseable',
  }));
}

function maxHidden(ctx: FenceCtx): number {
  return ctx.hiddenRows?.size ? Math.max(...ctx.hiddenRows) : 0;
}

/**
 * The number for a new fence row on this page.
 *
 * Contract: must never return a number already used on this page. It is one
 * more than the largest of every fence row number (live and struck, facts and
 * takes, body and timeline, including rows a strict parse rejects) and every
 * stored facts/takes row number the caller passes. A number whose only
 * evidence was deleted before stored rows existed cannot be seen here.
 */
export function nextFreeRowNum(page: FencePage, storedRows?: StoredRowMap): number {
  let max = 0;
  for (const [section, text] of sectionsOf(page)) {
    for (const fence of extractRawRows(text, section).fences) {
      for (const row of fence.rows) max = Math.max(max, rowNumOf(fence, row) ?? 0);
    }
  }
  for (const n of storedRows?.facts.keys() ?? []) max = Math.max(max, n);
  for (const n of storedRows?.takes.keys() ?? []) max = Math.max(max, n);
  return max + 1;
}
