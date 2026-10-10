/**
 * Structural Tier 1 rules for one section (#6188, #6377): `merge_fences`
 * (balanced same-kind fences, merge.ts), `marker_form` (takes two-dash
 * markers), `close_fence` (a missing end marker) and `close_fence_trailing`
 * (a missing end marker with page text after the table).
 *
 * `close_fence` inserts the end marker after the last table row only when
 * every row of the before-region is one contiguous block and nothing but
 * blank lines follows it to the end of the section: the privacy boundary
 * hides everything after an unpaired begin marker, so closing the fence
 * early would publish whatever trails it (gate (g)). Every structural edit
 * is also checked against `exposedLines` before it is kept.
 *
 * `close_fence_trailing` (#6377) is the one rule that shows hidden lines on
 * purpose, and only when showing them discloses nothing or the user agreed:
 * the trailing lines hold no pipe and no fence marker (so no parser can read
 * them as rows), or the tail classifier judged them prose (`ctx.tailProse`),
 * and the page is private (remote readers never see its body) or the caller
 * holds the user's hash-bound approval (`ctx.approveTailExposure`). A
 * pipe-free tail on a world page without approval is `tail_exposure_approval`;
 * a tail with a pipe the classifier has not judged is
 * `unclosed_trailing_content` (Tier 3); a marker mention is
 * `unclosed_ambiguous_tail` (manual).
 */
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { mergeEdits, mergeOrigins, mergePlan, type MergeOrigins, type MergePlan } from './merge.ts';
import { exposedLines } from './page-checks.ts';
import { extractRawRows, MARKERS, parseRowSpans, primaryFence, type RawFence, type RawSection } from './raw-rows.ts';
import type { FenceCtx, FenceFix, FenceIssue, FenceReason, FenceSection, FixClass } from './types.ts';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface PassResult {
  text: string;
  fixes: FenceFix[];
  residual: FenceIssue[];
  /** Row origins of every fence `merge_fences` built, for the content pass. */
  merges: MergeOrigins[];
}

interface Step {
  edits: Edit[];
  fixes: FenceFix[];
  residual: FenceIssue[];
  /** Merge plans whose edits were kept; their origins are read once the edits are applied. */
  merged: MergePlan[];
}

/** Apply non-overlapping edits (any order) to `text`. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** Run the structural rules until they settle (a converted marker may then need closing). */
export type StructuralCtx = Pick<FenceCtx, 'pageVisibility' | 'approveTailExposure' | 'tailProse'>;

export function structuralPass(text: string, section: FenceSection, ctx: StructuralCtx = { pageVisibility: 'world' }): PassResult {
  let current = text;
  const fixes: FenceFix[] = [];
  const merges: MergeOrigins[] = [];
  for (let round = 0; round < 3; round++) {
    const step = structuralStep(current, section, ctx);
    if (!step.edits.length) return { text: current, fixes, residual: step.residual, merges };
    current = applyEdits(current, step.edits);
    fixes.push(...step.fixes);
    merges.push(...step.merged.map(plan => mergeOrigins(plan, current)));
  }
  throw new Error('fence structure rules did not settle');
}

/** A fence whose markers need a person: repeated, or an end marker with no begin before it. */
export function fenceBlocked(raw: RawSection, fence: RawFence): boolean {
  return fence.issues.some(i => i.reason === 'repeated_marker')
    || raw.issues.some(i => i.fence === fence.kind && i.reason === 'missing_begin');
}

function structuralStep(text: string, section: FenceSection, ctx: StructuralCtx): Step {
  const raw = extractRawRows(text, section);
  const step: Step = { edits: [], fixes: [], residual: [], merged: [] };
  for (const kind of ['facts', 'takes'] as const) {
    const fence = primaryFence(raw, kind);
    if (!fence) continue;
    const plan = mergePlan(raw, kind);
    if (plan) {
      // A merge that would show hidden text stays `repeated_marker`, which the content pass reports from the fence's issues.
      const edits = mergeEdits(text, plan);
      if (exposedLines(text, applyEdits(text, edits)).length) continue;
      step.edits.push(...edits);
      step.fixes.push({ fence: kind, section, row: null, column: null, line: fence.begin.line, class: 'merge_fences' });
      step.merged.push(plan);
      continue;
    }
    if (fenceBlocked(raw, fence)) continue;
    const edits = markerEdits(text, fence);
    if (edits === null) {
      step.residual.push(fenceIssue(fence, 'marker_near_miss', fence.begin.line));
      continue;
    }
    if (edits.length) keep(step, text, fence, edits, 'marker_form', 'marker_near_miss');
    else if (!fence.end) planClose(step, text, fence, ctx);
  }
  return step;
}

function fenceIssue(fence: RawFence, reason: FenceReason, line: number | null): FenceIssue {
  return { fence: fence.kind, section: fence.section, row: null, column: null, line, reason };
}

/** Keep a fence's edits unless they would show text the privacy boundary hid. */
function keep(step: Step, text: string, fence: RawFence, edits: Edit[], cls: FixClass, otherwise: FenceReason): void {
  if (exposedLines(text, applyEdits(text, edits)).length) {
    step.residual.push(fenceIssue(fence, otherwise, fence.begin.line));
    return;
  }
  step.edits.push(...edits);
  step.fixes.push({ fence: fence.kind, section: fence.section, row: null, column: null, line: fence.begin.line, class: cls });
}

/** `marker_form` edits for two-dash takes markers; null when a near-miss begin has no table after it. */
function markerEdits(text: string, fence: RawFence): Edit[] | null {
  const edits: Edit[] = [];
  if (fence.begin.nearMiss) {
    if (!tableFollows(text, fence.begin.end)) return null;
    edits.push({ start: fence.begin.start, end: fence.begin.end, text: TAKES_FENCE_BEGIN });
  }
  if (fence.end?.nearMiss) edits.push({ start: fence.end.start, end: fence.end.end, text: TAKES_FENCE_END });
  return edits;
}

/** The first non-blank line after `from` is a pipe-table row. */
function tableFollows(text: string, from: number): boolean {
  let at = text.indexOf('\n', from);
  while (at !== -1) {
    const next = text.indexOf('\n', at + 1);
    const end = next === -1 ? text.length : next;
    if (text.slice(at + 1, end).trim()) return parseRowSpans(text, at + 1, end, 0) !== null;
    at = next;
  }
  return false;
}

function planClose(step: Step, text: string, fence: RawFence, ctx: StructuralCtx): void {
  const lines = [fence.header, ...fence.separators, ...fence.rows].filter(r => r !== null).sort((a, b) => a.line - b.line);
  const last = lines[lines.length - 1];
  if (lines.some((row, i) => i > 0 && row.line !== lines[i - 1]!.line + 1)) {
    step.residual.push(fenceIssue(fence, 'split_rows', fence.begin.line));
    return;
  }
  const after = last ? last.end : fence.begin.end;
  const tail = trailingLines(text.slice(after, fence.regionEnd));
  if (!tail.length) {
    keep(step, text, fence, [closeEdit(text, after, MARKERS[fence.kind].end)], 'close_fence', 'unclosed_trailing_content');
    return;
  }
  if (tail.some(line => line.includes('gbrain:'))) {
    step.residual.push(fenceIssue(fence, 'unclosed_ambiguous_tail', fence.begin.line));
    return;
  }
  const judged = tailAmbiguous(tail) ? ctx.tailProse?.has(`${fence.section}:${fence.kind}`) === true || ctx.tailProse?.has('*') === true : true;
  if (!judged) {
    step.residual.push(fenceIssue(fence, 'unclosed_trailing_content', fence.begin.line));
    return;
  }
  if (ctx.pageVisibility !== 'private' && !ctx.approveTailExposure) {
    step.residual.push(fenceIssue(fence, 'tail_exposure_approval', fence.begin.line));
    return;
  }
  step.edits.push(closeEdit(text, after, MARKERS[fence.kind].end));
  step.fixes.push({ fence: fence.kind, section: fence.section, row: null, column: null, line: fence.begin.line, class: 'close_fence_trailing' });
}

/** The non-blank lines of a fence's tail, trimmed, as written. */
export function trailingLines(tail: string): string[] {
  return tail.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
}

/** The tail holds a pipe, so a line could be a table row; without one every line is prose under every parser. */
export function tailAmbiguous(tail: readonly string[]): boolean {
  return tail.some(line => line.includes('|'));
}

/**
 * The trailing lines a `close_fence_trailing` fix shows, per unclosed fence of
 * the before section: what gate (g) may accept as exposed, and nothing else.
 */
export function trailingLinesOf(text: string, section: FenceSection): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const raw = extractRawRows(text, section);
  for (const fence of raw.fences) {
    if (!fence.primary || fence.end) continue;
    const lines = [fence.header, ...fence.separators, ...fence.rows].filter(r => r !== null).sort((a, b) => a.line - b.line);
    const last = lines[lines.length - 1];
    out.set(`${section}:${fence.kind}`, trailingLines(text.slice(last ? last.end : fence.begin.end, fence.regionEnd)));
  }
  return out;
}

/** Insert `marker` on its own line after the line that ends at or after `at`, keeping that line's ending. */
function closeEdit(text: string, at: number, marker: string): Edit {
  const nl = text.indexOf('\n', at);
  if (nl === -1) return { start: text.length, end: text.length, text: `\n${marker}` };
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const pos = crlf ? nl - 1 : nl;
  return { start: pos, end: pos, text: `${crlf ? '\r\n' : '\n'}${marker}` };
}
