/**
 * Tier 1 on a write path (#6188): the one fence step the coordinated screen,
 * `importFromContent` and the append verbs share.
 *
 * `fenceStep(page, ctx, { normalize })` returns `clean` with no work beyond a
 * marker substring check when neither section mentions a fence, and with one
 * shared scan (`scanCanonicalFences`, the same check the canonical projection
 * refuses on) when the fences already compile. A fence the projection would
 * refuse runs through `safeNormalizeFences`; the result is `normalized` only
 * when the normalizer left no residual, the validator passes gates (a)-(g)
 * and the output is a Tier 1 fixed point (E14). Everything else is
 * `residual`, with location-only issues and the refusal location. With
 * normalization off (`fences.normalize=false`) a fixable fence is residual
 * too, located exactly as the screen located it before normalization existed.
 *
 * Pure and deterministic: no I/O, no clock, no cell values in any output.
 */
import { hasFenceText, safeNormalizeFences } from './normalize.ts';
import { scanCanonicalFences, FENCE_ROWS_MAX } from './refusal.ts';
import { issueLocation, type FenceMessageLocation } from './reasons.ts';
import { validateFenceRepair } from './validate.ts';
import type { FenceCtx, FenceFix, FenceIssue, FenceKind, FencePage, FenceReason, FenceSection, FixClass } from './types.ts';

export type FenceStep<T extends FencePage> =
  | { status: 'clean' }
  | { status: 'normalized'; page: T; fixes: FenceFix[] }
  /** `fixable` lists what Tier 1 would have fixed (only when normalization is off). */
  | { status: 'residual'; issues: FenceIssue[]; location: FenceMessageLocation; fixable: FenceFix[] };

/** Wire form of one issue or fix (D18): location and class only. */
export interface FenceIssueWire {
  fence: FenceKind;
  section: FenceSection;
  row: number | null;
  column: string | null;
  line: number | null;
  /** A residual reason, or the Tier 1 fix class a disabled normalizer would have applied. */
  class: FenceReason | FixClass;
  /** Schema vocabulary for the column (never a cell value). */
  allowed?: readonly string[];
}

/** At most this many issues ride a refusal, a receipt or a warning. */
export const FENCE_ISSUES_MAX = 20;

/** The section mentions a fence marker (the zero-work pre-check). */
export function pageHasFenceText(page: FencePage): boolean {
  return hasFenceText(page.compiled_truth) || hasFenceText(page.timeline);
}

export function fenceStep<T extends FencePage>(page: T, ctx: FenceCtx, opts: { normalize: boolean }): FenceStep<T> {
  if (!pageHasFenceText(page)) return { status: 'clean' };
  const defects = scanCanonicalFences(page).defects;
  if (!defects.length) return { status: 'clean' };
  try {
    return normalizedStep(page, ctx, opts, defects);
  } catch {
    // E38: a validator or normalizer fault is a residual `normalizer_failed`, never a thrown write.
    return residual([{ ...defectIssue(defects[0]!), row: null, column: null, line: null, reason: 'normalizer_failed' }]);
  }
}

function normalizedStep<T extends FencePage>(page: T, ctx: FenceCtx, opts: { normalize: boolean }, defects: FenceMessageLocation[]): FenceStep<T> {
  const result = safeNormalizeFences(page, ctx);
  if (!opts.normalize) {
    return { status: 'residual', issues: result.residual, location: defects[0]!, fixable: result.fixes };
  }
  if (result.residual.length) return residual(result.residual);
  const first = defects[0]!;
  // The normalizer saw nothing to fix in a fence the projection refuses: report the screen's own location.
  if (!result.fixes.length) return { status: 'residual', issues: [defectIssue(first)], location: first, fixable: [] };
  const verdict = validateFenceRepair(page, result.page, { ...ctx, tier: 'deterministic', issues: result.fixes });
  if (!verdict.ok) {
    return residual([{ fence: verdict.fence ?? first.fence, section: verdict.section ?? first.section, row: verdict.rows[0] ?? null, column: null, line: null, reason: verdict.reason }]);
  }
  // E14: what Tier 1 writes is a fixed point and compiles; anything else is a normalizer fault, never a write.
  const again = safeNormalizeFences(result.page, ctx);
  if (again.fixes.length || again.residual.length || scanCanonicalFences(result.page).defects.length) {
    return residual([{ ...defectIssue(first), row: null, column: null, line: null, reason: 'normalizer_failed' }]);
  }
  return { status: 'normalized', page: result.page, fixes: result.fixes };
}

function defectIssue(defect: FenceMessageLocation): FenceIssue {
  return { fence: defect.fence, section: defect.section, row: defect.rows[0] ?? null, column: defect.columns[0] ?? null, line: defect.line, reason: defect.reason,
    ...(defect.allowed ? { allowed: defect.allowed } : {}) };
}

function residual(issues: FenceIssue[]): FenceStep<never> {
  return { status: 'residual', issues, location: residualLocation(issues), fixable: [] };
}

/** The refusal location for residual issues: the first issue, with every row and column of that reason in that fence and section. */
export function residualLocation(issues: readonly FenceIssue[]): FenceMessageLocation {
  const first = issues[0]!;
  const same = issues.filter(i => i.reason === first.reason && i.fence === first.fence && i.section === first.section);
  const rows = [...new Set(same.flatMap(i => i.row === null ? [] : [i.row]))].slice(0, FENCE_ROWS_MAX);
  const columns = [...new Set(same.flatMap(i => i.column === null ? [] : [i.column]))].slice(0, 20);
  return { ...issueLocation(first), rows, columns };
}

/** Issues (and, with normalization off, the fixes it would apply) in wire form, bounded. */
export function fenceIssuesWire(issues: ReadonlyArray<FenceIssue | FenceFix>): FenceIssueWire[] {
  return issues.slice(0, FENCE_ISSUES_MAX).map(issue => ({
    fence: issue.fence, section: issue.section, row: issue.row, column: issue.column, line: issue.line,
    class: 'reason' in issue ? issue.reason : issue.class,
    ...('allowed' in issue && issue.allowed?.length ? { allowed: issue.allowed } : {}),
  }));
}

/** Location-only fixes as stored in outcomes and notices: no `from` number when it equals the row. */
export function fenceFixesWire(fixes: readonly FenceFix[]): Array<Pick<FenceFix, 'fence' | 'section' | 'row' | 'column' | 'class'>> {
  return fixes.slice(0, FENCE_ISSUES_MAX).map(f => ({ fence: f.fence, section: f.section, row: f.row, column: f.column, class: f.class }));
}

/** Fixes per class. */
export function fixesByClass(fixes: readonly Pick<FenceFix, 'class'>[]): Partial<Record<FixClass, number>> {
  const counts: Partial<Record<FixClass, number>> = {};
  for (const fix of fixes) counts[fix.class] = (counts[fix.class] ?? 0) + 1;
  return counts;
}
